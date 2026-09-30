import type { ActionType, Card, HandPhase, HandResultPublic, LegalAction, Street } from '../shared/protocol.ts'
import { type Rng, createDeck, shuffle } from './deck.ts'
import { evaluateHand, type HandValue } from './evaluate.ts'
import { awardPots, buildPots } from './pots.ts'

export type EngineErrorCode = 'not_seated' | 'not_your_turn' | 'illegal_action' | 'hand_finished' | 'bad_state'

export class EngineError extends Error {
  code: EngineErrorCode

  constructor(code: EngineErrorCode, message: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
  }
}

export interface TableConfig {
  smallBlind: number
  bigBlind: number
  startingStack: number
  maxSeats: number
}

/** 引擎的公开座位视图：**不含任何未公开底牌**。 */
export interface EngineSeatPublic {
  playerId: string
  seat: number
  nickname: string
  stack: number
  committedStreet: number
  committedHand: number
  folded: boolean
  allIn: boolean
  inHand: boolean
  /** 已离座但座位与筹码保留（只有本人能坐回）。 */
  away: boolean
  lastAction: ActionType | null
  revealedCards: Card[] | null
}

export interface TablePublicState {
  phase: HandPhase
  street: Street | null
  board: Card[]
  pots: { amount: number; eligiblePlayerIds: string[] }[]
  potTotal: number
  currentBet: number
  minRaise: number
  buttonSeat: number | null
  smallBlindSeat: number | null
  bigBlindSeat: number | null
  actingSeat: number | null
  handId: string | null
  handNo: number
  seats: EngineSeatPublic[]
  result: HandResultPublic | null
}

interface Seat extends Omit<EngineSeatPublic, 'revealedCards'> {
  holeCards: Card[]
  revealedCards: Card[] | null
  /** 已离座但座位与筹码仍为本人保留（只有本人能坐回）。 */
  away: boolean
  /** 已退出房间：本手结束后连座位一起移除（筹码还在池里时必须等本手结束）。 */
  pendingRemoval: boolean
}

export const TABLE_SNAPSHOT_VERSION = 1

export interface SeatSnapshot {
  playerId: string
  nickname: string
  seat: number
  stack: number
  inHand: boolean
  folded: boolean
  allIn: boolean
  committedStreet: number
  committedHand: number
  lastAction: ActionType | null
  holeCards: Card[]
  revealedCards: Card[] | null
  away: boolean
  pendingRemoval: boolean
}

/**
 * 引擎的完整私有状态快照（含牌堆位置与所有人底牌）。
 * 只允许写入服务端 SQLite 的 room_snapshots，绝不整体下发客户端。
 */
export interface TableSnapshot {
  schemaVersion: number
  config: TableConfig
  seats: SeatSnapshot[]
  deck: Card[]
  burn: Card[]
  board: Card[]
  /** 本手结算时已退出玩家的底牌，只用于恢复时核对完整牌堆。 */
  removedHoleCards?: Card[]
  phase: HandPhase
  street: Street | null
  handId: string | null
  handNo: number
  buttonSeat: number | null
  smallBlindSeat: number | null
  bigBlindSeat: number | null
  actingSeat: number | null
  firstToActSeat: number | null
  actionCursor: number | null
  currentBet: number
  minRaise: number
  needsToAct: number[]
  raiseAllowed: [number, boolean][]
  /** 上次行动后本轮的最高下注额；旧版快照可缺省。 */
  lastActedBet?: [number, number][]
  result: HandResultPublic | null
}

/**
 * 无框架依赖的无限注德州扑克牌桌状态机。
 * 唯一真相来源：牌堆、底牌、筹码、轮次与行动权全部在这里裁定。
 */
export class HoldemTable {
  private readonly config: TableConfig
  private seats: Seat[] = []
  private deck: Card[] = []
  private burn: Card[] = []
  private board: Card[] = []
  private removedHoleCards: Card[] = []
  private phase: HandPhase = 'waiting'
  private street: Street | null = null
  private handId: string | null = null
  private handNo = 0
  private buttonSeat: number | null = null
  private smallBlindSeat: number | null = null
  private bigBlindSeat: number | null = null
  private actingSeat: number | null = null
  private firstToActSeat: number | null = null
  /** 行动游标：下一次行动从该座位之后顺时针寻找；null 表示从本轮首位开始。 */
  private actionCursor: number | null = null
  private currentBet = 0
  private minRaise = 0
  /** 本轮仍需行动（且能行动）的座位。 */
  private needsToAct = new Set<number>()
  /** 每个座位本轮是否仍有加注权；累计短额加注由 lastActedBet 补判。 */
  private raiseAllowed = new Map<number, boolean>()
  private lastActedBet = new Map<number, number>()
  private result: HandResultPublic | null = null

  constructor(config: TableConfig) {
    this.config = config
  }

  /* ───────────────────────── 座位管理 ───────────────────────── */

  seatOf(playerId: string): Seat | undefined {
    return this.seats.find((seat) => seat.playerId === playerId)
  }

  /**
   * 取座位占用者。
   * 离座（away）的玩家仍然占着这个座位与筹码——只有本人能坐回，别人坐不进来，
   * 因此这里不再区分「正在离座」，一个座位只会有一个主人。
   */
  seatAt(seat: number): Seat | undefined {
    return this.seats.find((entry) => entry.seat === seat)
  }

  seatedPlayers(): { playerId: string; nickname: string; seat: number; stack: number }[] {
    return this.seats.map(({ playerId, nickname, seat, stack }) => ({ playerId, nickname, seat, stack }))
  }

  isHandRunning(): boolean {
    return this.phase !== 'waiting' && this.phase !== 'settlement'
  }

  /** 能开局的条件：至少 2 名「在座且有筹码」的玩家（离座保留座位的人不算）。 */
  canStartHand(): boolean {
    return !this.isHandRunning() && this.seats.filter((seat) => seat.stack > 0 && !seat.away).length >= 2
  }

  /** 该座位现在能否坐人：离座保留的座位仍属于原主人，别人不能占。 */
  isSeatAvailable(seat: number): boolean {
    return this.seatAt(seat) === undefined
  }

  /** 玩家是否已经离座但保留座位。 */
  isAway(playerId: string): boolean {
    return this.seatOf(playerId)?.away ?? false
  }

  /** 已入座且在座（未离座）的人数。 */
  presentSeatCount(): number {
    return this.seats.filter((seat) => !seat.away).length
  }

  sit(playerId: string, nickname: string, seat: number, stack = this.config.startingStack): void {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.config.maxSeats) {
      throw new EngineError('bad_state', '座位号超出范围')
    }
    const existing = this.seatOf(playerId)
    if (existing) {
      // 离座保留的座位：本人坐回，筹码照旧；输光了（0 筹码）则按本次买入补充（重新买入）。
      if (existing.seat !== seat) {
        throw new EngineError('bad_state', '你已经有一个保留的座位，先退出房间才能换座')
      }
      if (!existing.away) {
        if (existing.stack !== 0 || this.isHandRunning()) throw new EngineError('bad_state', '你已经入座')
        existing.stack = stack
        existing.inHand = false
        existing.folded = false
        existing.allIn = false
        existing.lastAction = null
        return
      }
      existing.away = false
      existing.pendingRemoval = false
      if (existing.stack <= 0 && !this.isHandRunning()) existing.stack = stack
      return
    }
    if (this.seatAt(seat)) throw new EngineError('bad_state', '该座位已被占用')
    this.seats.push({
      playerId,
      nickname,
      seat,
      stack,
      inHand: false,
      folded: false,
      allIn: false,
      committedStreet: 0,
      committedHand: 0,
      lastAction: null,
      holeCards: [],
      revealedCards: null,
      away: false,
      pendingRemoval: false,
    })
    this.seats.sort((a, b) => a.seat - b.seat)
  }

  /**
   * 离座玩家换到另一个空位（第 4 项需求）：筹码跟人走。
   *
   * 语义：离座只是「暂时不玩」，座位与筹码仍属于本人；本人可以选择**任意**空位坐下，
   * 而不是只能坐回原位。原座位腾空释放，筹码原样带到新座位——
   * 所以这里的 `buyIn` 只在原筹码为 0（输光了、重新买入）时才用到。
   * 仍参与本手的离座玩家要等结算后才能换座。
   *
   * @returns 离座前的筹码（服务端用它决定是否需要重新买入，以及给客户端回执金额）
   */
  reSit(playerId: string, nickname: string, seat: number, buyIn = this.config.startingStack): number {
    const existing = this.seatOf(playerId)
    if (!existing || !existing.away) {
      throw new EngineError('bad_state', '只有离座保留座位的玩家可以换座位')
    }
    if (this.isHandRunning() && existing.inHand) {
      throw new EngineError('bad_state', '本手牌结束后才能换座')
    }
    if (existing.seat === seat) {
      this.sit(playerId, nickname, seat, buyIn)
      return existing.stack
    }
    if (!this.isSeatAvailable(seat)) {
      throw new EngineError('bad_state', '该座位已被占用')
    }
    const previousStack = existing.stack
    // 先释放原座位（连同它的筹码），再把筹码原样带到新座位：筹码属于玩家，不属于座位。
    this.seats = this.seats.filter((entry) => entry.playerId !== playerId)
    this.sit(playerId, nickname, seat, previousStack > 0 ? previousStack : buyIn)
    return previousStack
  }

  /**
   * 离座（seat.leave）：座位与筹码都留着，只有本人能坐回。
   * 手牌进行中离座会先自动弃牌；已全下者保留争池资格。
   * 已投入的筹码留在池中，
   * 本手结束后座位仍然保留，随时可以坐回来接着玩。
   */
  leave(playerId: string): void {
    const seat = this.seatOf(playerId)
    if (!seat) return
    seat.away = true
    if (this.isHandRunning() && seat.inHand && !seat.folded && !seat.allIn) {
      this.foldOut(seat)
    }
  }

  /**
   * 让一个座位在本手出局（离座 / 退出房间时用）。
   * 必须完全照 fold 动作来做：从 needsToAct 里移除并推进——否则：
   *   - 不推进：只剩一人时本手不会结算（实测离座后牌局卡在 preflop）；
   *   - 只在自己行动时推进：别人行动时弃牌会漏掉「其余全弃牌」的结算。
   */
  private foldOut(seat: Seat): void {
    seat.folded = true
    seat.lastAction = 'fold'
    this.needsToAct.delete(seat.seat)
    this.progress()
  }

  /**
   * 退出房间：真正释放座位。
   * 手牌进行中且筹码还在池里时标记待移除，等本手结算后再移除。
   * 未全下者先弃牌；已全下者保留争池资格。
   */
  removePlayer(playerId: string): void {
    const seat = this.seatOf(playerId)
    if (!seat) return
    if (this.isHandRunning() && seat.inHand) {
      seat.away = true
      seat.pendingRemoval = true
      if (!seat.folded && !seat.allIn) this.foldOut(seat)
      return
    }
    this.seats = this.seats.filter((entry) => entry.playerId !== playerId)
  }

  /** 玩家重连/掉线只影响展示，不改变牌局；断线不暂停全桌，由超时代打。 */
  holeCardsOf(playerId: string): Card[] {
    return this.seatOf(playerId)?.holeCards.slice() ?? []
  }

  totalChips(): number {
    return this.seats.reduce((sum, seat) => sum + seat.stack + seat.committedHand, 0)
  }

  /* ───────────────────────── 开局 ───────────────────────── */

  suggestButtonSeat(): number {
    const playable = (seat: Seat): boolean => seat.stack > 0 && !seat.away
    if (this.buttonSeat === null) return this.seats.find(playable)?.seat ?? 0
    return this.nextSeatWhere(this.buttonSeat, playable) ?? this.buttonSeat
  }

  startHand(options: { handId: string; rng: Rng; buttonSeat?: number; deck?: readonly Card[] }): void {
    if (this.isHandRunning()) throw new EngineError('bad_state', '当前手牌尚未结束')

    this.seats = this.seats.filter((seat) => !seat.pendingRemoval)
    // 离座保留座位的人不参与本手（座位与筹码留着，坐回来即可继续）。
    const participants = this.seats.filter((seat) => seat.stack > 0 && !seat.away)
    if (participants.length < 2) throw new EngineError('bad_state', '至少需要 2 名有筹码的玩家')

    this.handId = options.handId
    this.handNo += 1
    this.result = null
    this.board = []
    this.removedHoleCards = []
    this.burn = []
    // deck 仅用于测试注入固定牌序（数组末尾是第一个被发出的牌）；生产走安全随机洗牌。
    this.deck = options.deck ? [...options.deck] : shuffle(createDeck(), options.rng)
    this.currentBet = 0
    this.minRaise = this.config.bigBlind

    for (const seat of this.seats) {
      seat.inHand = seat.stack > 0 && !seat.away
      seat.folded = false
      seat.allIn = false
      seat.committedHand = 0
      seat.committedStreet = 0
      seat.holeCards = []
      seat.revealedCards = null
      seat.lastAction = null
    }

    const headsUp = participants.length === 2
    this.buttonSeat = options.buttonSeat ?? this.suggestButtonSeat()
    const buttonSeat = this.buttonSeat === null ? undefined : this.seatAt(this.buttonSeat)
    if (!buttonSeat || buttonSeat.stack <= 0 || buttonSeat.away) {
      this.buttonSeat = this.seats.find((seat) => seat.inHand)?.seat ?? this.buttonSeat
    }

    // 双人桌例外：庄家同时是小盲，翻牌前先行动、翻牌后最后行动。
    this.smallBlindSeat = headsUp ? this.buttonSeat : this.nextSeatWhere(this.buttonSeat, (seat) => seat.inHand)
    this.bigBlindSeat =
      this.smallBlindSeat === null ? null : this.nextSeatWhere(this.smallBlindSeat, (seat) => seat.inHand)
    if (this.smallBlindSeat === null || this.bigBlindSeat === null) {
      throw new EngineError('bad_state', '无法确定盲注位')
    }

    for (const seat of this.playersFromButton()) seat.holeCards.push(this.deck.pop()!)
    for (const seat of this.playersFromButton()) seat.holeCards.push(this.deck.pop()!)

    this.postBlind(this.smallBlindSeat, this.config.smallBlind)
    this.postBlind(this.bigBlindSeat, this.config.bigBlind)
    this.currentBet = this.config.bigBlind

    this.street = 'preflop'
    this.phase = 'preflop'
    const firstToAct = headsUp
      ? this.buttonSeat
      : this.nextSeatWhere(this.bigBlindSeat, (seat) => seat.inHand && !seat.allIn)
    this.beginBettingRound(firstToAct ?? this.buttonSeat)
    this.progress()
  }

  /* ───────────────────────── 行动 ───────────────────────── */

  legalActions(playerId: string): LegalAction[] {
    if (!this.isHandRunning() || this.actingSeat === null) return []
    const seat = this.seatOf(playerId)
    if (!seat || seat.seat !== this.actingSeat || !seat.inHand || seat.folded || seat.allIn) return []

    const toCall = this.currentBet - seat.committedStreet
    const maxTarget = seat.committedStreet + seat.stack
    const actions: LegalAction[] = [{ action: 'fold' }]

    if (toCall <= 0) actions.push({ action: 'check' })
    else actions.push({ action: 'call', amount: Math.min(toCall, seat.stack) })

    const lastBet = this.lastActedBet.get(seat.seat)
    const mayRaise =
      (this.raiseAllowed.get(seat.seat) ?? false) ||
      (lastBet !== undefined && this.currentBet - lastBet >= this.minRaise)
    if (mayRaise && maxTarget > this.currentBet) {
      const minTarget = this.currentBet === 0 ? this.config.bigBlind : this.currentBet + this.minRaise
      if (maxTarget >= minTarget) {
        actions.push(
          this.currentBet === 0
            ? { action: 'bet', min: minTarget, max: maxTarget }
            : { action: 'raise', min: minTarget, max: maxTarget },
        )
      }
    }

    if (seat.stack > 0 && (maxTarget <= this.currentBet || mayRaise)) {
      actions.push({ action: 'all_in', amount: maxTarget })
    }
    return actions
  }

  act(playerId: string, action: ActionType, amount?: number): void {
    if (!this.isHandRunning()) throw new EngineError('hand_finished', '本手牌已结束')
    const seat = this.seatOf(playerId)
    if (!seat || !seat.inHand || seat.folded) throw new EngineError('not_seated', '你不在本手牌中')
    if (this.actingSeat !== seat.seat) throw new EngineError('not_your_turn', '还没轮到你行动')

    const allowed = this.legalActions(playerId).find((entry) => entry.action === action)
    if (!allowed) throw new EngineError('illegal_action', '当前不合法操作')

    const toCall = this.currentBet - seat.committedStreet

    switch (action) {
      case 'fold':
        seat.folded = true
        seat.lastAction = 'fold'
        this.needsToAct.delete(seat.seat)
        break
      case 'check':
        if (toCall > 0) throw new EngineError('illegal_action', '面对下注不能过牌')
        seat.lastAction = 'check'
        this.needsToAct.delete(seat.seat)
        break
      case 'call':
        this.commit(seat, Math.min(toCall, seat.stack))
        seat.lastAction = 'call'
        this.needsToAct.delete(seat.seat)
        break
      case 'bet':
      case 'raise':
      case 'all_in':
        this.applyAggression(seat, action, amount, allowed)
        break
    }

    this.lastActedBet.set(seat.seat, this.currentBet)
    this.actionCursor = seat.seat
    this.progress()
  }

  /* ───────────────────────── 内部推进 ───────────────────────── */

  private applyAggression(seat: Seat, action: ActionType, amount: number | undefined, allowed: LegalAction): void {
    const maxTarget = seat.committedStreet + seat.stack
    const target = action === 'all_in' ? maxTarget : amount
    if (target === undefined || !Number.isInteger(target) || target < 0) {
      throw new EngineError('illegal_action', '缺少或不合法的下注额')
    }
    if (target > maxTarget || (allowed.max !== undefined && target > allowed.max)) {
      throw new EngineError('illegal_action', '下注额超过你的筹码')
    }
    if (target <= this.currentBet) {
      // 全下但不足以跟平：按「全下跟注」处理，不改变当前下注额，也不重开加注权。
      if (action !== 'all_in') throw new EngineError('illegal_action', '下注额必须高于当前下注')
      this.commit(seat, seat.stack)
      seat.lastAction = 'all_in'
      this.needsToAct.delete(seat.seat)
      return
    }
    if (allowed.min !== undefined && target < allowed.min) {
      throw new EngineError('illegal_action', `最少要下注到 ${allowed.min}`)
    }

    const increment = target - this.currentBet
    const fullRaise = increment >= this.minRaise
    this.commit(seat, target - seat.committedStreet)
    this.currentBet = target
    if (fullRaise) this.minRaise = increment
    seat.lastAction = action

    const others = this.activeSeats().filter((entry) => entry.seat !== seat.seat)
    if (!fullRaise) {
      // 未满额 all-in：已经行动过的玩家只能跟注或弃牌，加注权不再开放。
      for (const other of others) {
        if (!this.needsToAct.has(other.seat)) this.raiseAllowed.set(other.seat, false)
      }
    } else {
      for (const other of others) this.raiseAllowed.set(other.seat, true)
    }
    this.needsToAct = new Set(others.map((entry) => entry.seat))
  }

  /** 单入口推进：轮流结算街道、无人可行动时自动发完公共牌、只剩一人时直接结算。 */
  private progress(): void {
    for (;;) {
      if (this.remaining().length <= 1) {
        this.settle()
        return
      }
      const active = this.activeSeats()
      // 只剩 ≤1 名可行动玩家且其下注已跟平 → 不存在可争夺的下注，直接发完公共牌。
      // 注意：若该玩家还欠跟注，必须给他跟注/弃牌的机会，不能提前跳过。
      const loneActorMatched =
        active.length === 0 || (active.length === 1 && active[0]!.committedStreet >= this.currentBet)
      if (loneActorMatched || this.needsToAct.size === 0) {
        if (this.street === 'river') {
          this.showdown()
          return
        }
        this.dealNextStreet()
        continue
      }
      const next = this.nextToAct()
      if (next === null) {
        if (this.street === 'river') {
          this.showdown()
          return
        }
        this.dealNextStreet()
        continue
      }
      this.actingSeat = next
      return
    }
  }

  private beginBettingRound(firstToActSeat: number | null): void {
    const active = this.activeSeats()
    this.needsToAct = new Set(active.map((seat) => seat.seat))
    this.raiseAllowed = new Map(active.map((seat) => [seat.seat, true]))
    this.lastActedBet.clear()
    this.firstToActSeat = firstToActSeat
    this.actionCursor = null
    this.actingSeat = null
  }

  private dealNextStreet(): void {
    for (const seat of this.seats) {
      seat.committedStreet = 0
      seat.lastAction = null
    }
    this.currentBet = 0
    this.minRaise = this.config.bigBlind
    this.burn.push(this.deck.pop()!)

    if (this.street === 'preflop') {
      for (let i = 0; i < 3; i++) this.board.push(this.deck.pop()!)
      this.street = 'flop'
    } else if (this.street === 'flop') {
      this.board.push(this.deck.pop()!)
      this.street = 'turn'
    } else {
      this.board.push(this.deck.pop()!)
      this.street = 'river'
    }
    this.phase = this.street

    const firstToAct =
      this.buttonSeat === null ? null : this.nextSeatWhere(this.buttonSeat, (seat) => seat.inHand && !seat.folded && !seat.allIn)
    this.beginBettingRound(firstToAct)
  }

  private settle(): void {
    const survivor = this.remaining()[0]
    if (!survivor) throw new EngineError('bad_state', '没有剩余玩家可结算')

    const contributions = this.contributions()
    const total = contributions.reduce((sum, entry) => sum + entry.amount, 0)
    survivor.stack += total
    this.zeroCommitments()

    this.result = {
      handId: this.handId ?? '',
      handNo: this.handNo,
      board: [...this.board],
      potTotal: total,
      showdown: false,
      winners: [{ playerId: survivor.playerId, amount: total, handName: null, bestFive: [], potIndex: 0 }],
      revealed: [],
    }
    this.finishHand()
  }

  private showdown(): void {
    const contenders = this.remaining()
    const hands = new Map<string, HandValue>()
    for (const seat of contenders) {
      hands.set(seat.playerId, evaluateHand([...seat.holeCards, ...this.board]))
      seat.revealedCards = [...seat.holeCards]
    }

    const pots = buildPots(this.contributions())
    const awards = awardPots(
      pots,
      (playerId) => hands.get(playerId) ?? null,
      this.playersFromButton().map((seat) => seat.playerId),
    )
    for (const award of awards) {
      const seat = this.seatOf(award.playerId)
      if (seat) seat.stack += award.amount
    }

    const total = this.contributions().reduce((sum, entry) => sum + entry.amount, 0)
    this.zeroCommitments()

    this.result = {
      handId: this.handId ?? '',
      handNo: this.handNo,
      board: [...this.board],
      potTotal: total,
      showdown: true,
      winners: awards.map((award) => ({
        playerId: award.playerId,
        amount: award.amount,
        handName: award.hand?.name ?? null,
        bestFive: award.hand?.bestFive ?? [],
        potIndex: award.potIndex,
      })),
      revealed: contenders.map((seat) => ({
        playerId: seat.playerId,
        cards: [...seat.holeCards],
        handName: hands.get(seat.playerId)!.name,
      })),
    }
    this.finishHand()
  }

  /** 结算后清零投入，保证「筹码 = 余额 + 池中」这一不变量在任何时刻都成立。 */
  private zeroCommitments(): void {
    for (const seat of this.seats) {
      seat.committedHand = 0
      seat.committedStreet = 0
    }
  }

  private finishHand(): void {
    this.phase = 'settlement'
    this.street = null
    this.actingSeat = null
    this.needsToAct.clear()
    this.raiseAllowed.clear()
    this.lastActedBet.clear()
    // 本手结束：退出房间的人现在可以真正让出座位（筹码已经结算完了）。
    this.removedHoleCards.push(...this.seats.filter((seat) => seat.pendingRemoval).flatMap((seat) => seat.holeCards))
    this.seats = this.seats.filter((seat) => !seat.pendingRemoval)
  }

  private postBlind(seatNumber: number, amount: number): void {
    const seat = this.seatAt(seatNumber)
    if (!seat) return
    this.commit(seat, Math.min(amount, seat.stack))
  }

  private commit(seat: Seat, amount: number): void {
    const paid = Math.min(amount, seat.stack)
    seat.stack -= paid
    seat.committedStreet += paid
    seat.committedHand += paid
    if (seat.stack === 0) seat.allIn = true
  }

  /* ───────────────────────── 查询辅助 ───────────────────────── */

  private remaining(): Seat[] {
    return this.seats.filter((seat) => seat.inHand && !seat.folded)
  }

  private activeSeats(): Seat[] {
    return this.seats.filter((seat) => seat.inHand && !seat.folded && !seat.allIn)
  }

  private contributions(): { playerId: string; amount: number; folded: boolean }[] {
    return this.seats
      .filter((seat) => seat.committedHand > 0 || (seat.inHand && !seat.folded))
      .map((seat) => ({ playerId: seat.playerId, amount: seat.committedHand, folded: seat.folded || !seat.inHand }))
  }

  private nextToAct(): number | null {
    const sequence =
      this.actionCursor === null
        ? this.firstToActSeat === null
          ? []
          : this.sequentialSeats(this.firstToActSeat)
        : this.seatsAfter(this.actionCursor)
    for (const seat of sequence) {
      if (this.needsToAct.has(seat.seat)) return seat.seat
    }
    return null
  }

  private nextSeatWhere(fromSeat: number, predicate: (seat: Seat) => boolean): number | null {
    for (const seat of this.sequentialSeats(fromSeat)) {
      if (seat.seat === fromSeat) continue
      if (predicate(seat)) return seat.seat
    }
    return null
  }

  /** 从 fromSeat 之后（不含）顺时针的座位序列。 */
  private seatsAfter(fromSeat: number): Seat[] {
    const index = this.seats.findIndex((seat) => seat.seat === fromSeat)
    if (index < 0) return [...this.seats]
    return [...this.seats.slice(index + 1), ...this.seats.slice(0, index + 1)]
  }

  /** 从 fromSeat 开始顺时针（含自身）的座位序列。 */
  private sequentialSeats(fromSeat: number): Seat[] {
    const seats = this.seats
    const index = seats.findIndex((seat) => seat.seat === fromSeat)
    if (index < 0) return [...seats]
    return [...seats.slice(index), ...seats.slice(0, index)]
  }

  /** 庄家左手起顺时针的本手玩家（发牌顺序、余数筹码分配顺序）。 */
  private playersFromButton(): Seat[] {
    const inHand = this.seats.filter((seat) => seat.inHand)
    if (this.buttonSeat === null) return inHand
    const ordered = this.sequentialSeats(this.buttonSeat).filter((seat) => seat.inHand)
    return ordered.length > 0 ? [...ordered.slice(1), ordered[0]!] : inHand
  }

  /* ───────────────────────── 对外快照 ───────────────────────── */

  publicState(): TablePublicState {
    const contributions = this.contributions()
    return {
      phase: this.phase,
      street: this.street,
      board: [...this.board],
      pots: buildPots(contributions).map((pot) => ({ amount: pot.amount, eligiblePlayerIds: [...pot.eligible] })),
      potTotal: contributions.reduce((sum, entry) => sum + entry.amount, 0),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      buttonSeat: this.buttonSeat,
      smallBlindSeat: this.smallBlindSeat,
      bigBlindSeat: this.bigBlindSeat,
      actingSeat: this.actingSeat,
      handId: this.handId,
      handNo: this.handNo,
      seats: this.seats.map((seat) => ({
        playerId: seat.playerId,
        seat: seat.seat,
        nickname: seat.nickname,
        stack: seat.stack,
        committedStreet: seat.committedStreet,
        committedHand: seat.committedHand,
        folded: seat.folded,
        allIn: seat.allIn,
        inHand: seat.inHand,
        away: seat.away,
        lastAction: seat.lastAction,
        revealedCards: seat.revealedCards ? [...seat.revealedCards] : null,
      })),
      result: this.result,
    }
  }

  /* ───────────────────────── 可恢复快照（第 4 阶段） ───────────────────────── */

  /**
   * 导出完整私有状态（含牌堆位置与所有人底牌）。
   * 这份数据**只允许写入服务端 SQLite**，绝不整体下发给客户端。
   */
  serialize(): TableSnapshot {
    return {
      schemaVersion: TABLE_SNAPSHOT_VERSION,
      config: { ...this.config },
      seats: this.seats.map((seat) => ({
        playerId: seat.playerId,
        nickname: seat.nickname,
        seat: seat.seat,
        stack: seat.stack,
        inHand: seat.inHand,
        folded: seat.folded,
        allIn: seat.allIn,
        committedStreet: seat.committedStreet,
        committedHand: seat.committedHand,
        lastAction: seat.lastAction,
        holeCards: [...seat.holeCards],
        revealedCards: seat.revealedCards ? [...seat.revealedCards] : null,
        away: seat.away,
        pendingRemoval: seat.pendingRemoval,
      })),
      deck: [...this.deck],
      burn: [...this.burn],
      board: [...this.board],
      removedHoleCards: [...this.removedHoleCards],
      phase: this.phase,
      street: this.street,
      handId: this.handId,
      handNo: this.handNo,
      buttonSeat: this.buttonSeat,
      smallBlindSeat: this.smallBlindSeat,
      bigBlindSeat: this.bigBlindSeat,
      actingSeat: this.actingSeat,
      firstToActSeat: this.firstToActSeat,
      actionCursor: this.actionCursor,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      needsToAct: [...this.needsToAct],
      raiseAllowed: [...this.raiseAllowed.entries()],
      lastActedBet: [...this.lastActedBet.entries()],
      result: this.result ? { ...this.result } : null,
    }
  }

  /** 从快照重建牌桌；结构不一致直接抛错，由调用方决定是否放弃该房间。 */
  static restore(snapshot: TableSnapshot): HoldemTable {
    if (!snapshot || snapshot.schemaVersion !== TABLE_SNAPSHOT_VERSION) {
      throw new EngineError('bad_state', `快照版本不兼容：${String(snapshot?.schemaVersion)}`)
    }
    if (
      !Array.isArray(snapshot.seats) ||
      !Array.isArray(snapshot.deck) ||
      !Array.isArray(snapshot.burn) ||
      !Array.isArray(snapshot.board) ||
      (snapshot.removedHoleCards !== undefined && !Array.isArray(snapshot.removedHoleCards)) ||
      !Array.isArray(snapshot.needsToAct) ||
      !Array.isArray(snapshot.raiseAllowed) ||
      (snapshot.lastActedBet !== undefined && !Array.isArray(snapshot.lastActedBet)) ||
      typeof snapshot.config !== 'object' ||
      snapshot.config === null
    ) {
      throw new EngineError('bad_state', '快照结构损坏')
    }
    const { config } = snapshot
    if (
      !Number.isInteger(config.smallBlind) ||
      !Number.isInteger(config.bigBlind) ||
      config.smallBlind <= 0 ||
      config.bigBlind < config.smallBlind ||
      !Number.isInteger(config.startingStack) ||
      config.startingStack <= 0 ||
      !Number.isInteger(config.maxSeats) ||
      config.maxSeats < 2 ||
      config.maxSeats > 9
    ) {
      throw new EngineError('bad_state', '快照中的桌规不合法')
    }

    const table = new HoldemTable({ ...config })
    const seenSeatNumbers = new Set<number>()
    const seenPlayerIds = new Set<string>()

    table.seats = snapshot.seats.map((entry) => {
      if (!Number.isInteger(entry.seat) || entry.seat < 0 || entry.seat >= config.maxSeats) {
        throw new EngineError('bad_state', `快照座位号越界：${String(entry.seat)}`)
      }
      if (seenSeatNumbers.has(entry.seat)) throw new EngineError('bad_state', '快照座位号重复')
      if (seenPlayerIds.has(entry.playerId)) throw new EngineError('bad_state', '快照玩家重复')
      seenSeatNumbers.add(entry.seat)
      seenPlayerIds.add(entry.playerId)
      if (entry.stack < 0 || entry.committedStreet < 0 || entry.committedHand < 0) {
        throw new EngineError('bad_state', '快照出现负筹码')
      }
      if (entry.committedStreet > entry.committedHand) {
        throw new EngineError('bad_state', '快照中本轮投入大于本手投入')
      }
      if (entry.folded && entry.allIn) throw new EngineError('bad_state', '快照同时标记弃牌与全下')
      if (entry.holeCards.length > 2) throw new EngineError('bad_state', '快照底牌超过两张')
      return {
        playerId: entry.playerId,
        nickname: entry.nickname,
        seat: entry.seat,
        stack: entry.stack,
        inHand: entry.inHand,
        folded: entry.folded,
        allIn: entry.allIn,
        committedStreet: entry.committedStreet,
        committedHand: entry.committedHand,
        lastAction: entry.lastAction,
        holeCards: [...entry.holeCards],
        revealedCards: entry.revealedCards ? [...entry.revealedCards] : null,
        // 老快照没有这两个字段：默认 false，兼容旧数据。
        away: entry.away ?? false,
        pendingRemoval: entry.pendingRemoval ?? false,
      }
    })
    table.seats.sort((a, b) => a.seat - b.seat)

    if (snapshot.board.length !== 0 && snapshot.board.length !== 3 && snapshot.board.length !== 4 && snapshot.board.length !== 5) {
      throw new EngineError('bad_state', `快照公共牌数量异常：${String(snapshot.board.length)}`)
    }

    // 亮出的牌只是底牌的公开副本，不应作为另一张实体牌参与查重。
    for (const entry of snapshot.seats) {
      if (entry.revealedCards !== null &&
        (entry.revealedCards.length !== entry.holeCards.length ||
          entry.revealedCards.some((card, index) => card !== entry.holeCards[index]))) {
        throw new EngineError('bad_state', '快照亮牌与底牌不一致')
      }
    }
    // 全局查重：牌堆 + 烧牌 + 公共牌 + 所有底牌之间不允许出现同一张牌。
    const allCards = [
      ...snapshot.deck,
      ...snapshot.burn,
      ...snapshot.board,
      ...(snapshot.removedHoleCards ?? []),
      ...snapshot.seats.flatMap((entry) => entry.holeCards),
    ]
    if (new Set(allCards).size !== allCards.length) throw new EngineError('bad_state', '快照出现重复的牌')
    if (snapshot.phase === 'waiting') {
      // 还没开过手：不该有任何已发出的牌（此时牌堆本来就是空的）。
      if (allCards.length > 0) throw new EngineError('bad_state', '未开局快照不应含已发出的牌')
    } else if (
      snapshot.phase === 'settlement' && snapshot.removedHoleCards === undefined
        ? allCards.length > 52
        : allCards.length !== 52
    ) {
      // 手牌进行中：牌堆 + 已发出的牌必须刚好是完整一副。
      throw new EngineError('bad_state', `快照牌数不为 52：${String(allCards.length)}`)
    }

    if (snapshot.handId !== null && snapshot.phase === 'waiting') {
      throw new EngineError('bad_state', '快照状态与手牌 ID 不一致')
    }
    if (snapshot.actingSeat !== null && !snapshot.needsToAct.includes(snapshot.actingSeat)) {
      throw new EngineError('bad_state', '快照行动者不在待行动集合中')
    }
    if (snapshot.lastActedBet?.some(([seat, bet]) =>
      !seenSeatNumbers.has(seat) || !Number.isSafeInteger(bet) || bet < 0 || bet > snapshot.currentBet)) {
      throw new EngineError('bad_state', '快照上次行动下注额不合法')
    }

    table.deck = [...snapshot.deck]
    table.burn = [...snapshot.burn]
    table.board = [...snapshot.board]
    table.removedHoleCards = [...(snapshot.removedHoleCards ?? [])]
    table.phase = snapshot.phase
    table.street = snapshot.street
    table.handId = snapshot.handId
    table.handNo = snapshot.handNo
    table.buttonSeat = snapshot.buttonSeat
    table.smallBlindSeat = snapshot.smallBlindSeat
    table.bigBlindSeat = snapshot.bigBlindSeat
    table.actingSeat = snapshot.actingSeat
    table.firstToActSeat = snapshot.firstToActSeat
    table.actionCursor = snapshot.actionCursor
    table.currentBet = snapshot.currentBet
    table.minRaise = snapshot.minRaise
    table.needsToAct = new Set(snapshot.needsToAct)
    table.raiseAllowed = new Map(snapshot.raiseAllowed)
    table.lastActedBet = new Map(
      snapshot.lastActedBet ?? table.seats.map((seat) => [seat.seat, seat.committedStreet]),
    )
    table.result = snapshot.result ? { ...snapshot.result } : null

    return table
  }
}
