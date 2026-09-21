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
  pendingLeave: boolean
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
  /** 每个座位本轮是否仍有加注权（未满额 all-in 后会被收回）。 */
  private raiseAllowed = new Map<number, boolean>()
  private result: HandResultPublic | null = null

  constructor(config: TableConfig) {
    this.config = config
  }

  /* ───────────────────────── 座位管理 ───────────────────────── */

  seatOf(playerId: string): Seat | undefined {
    return this.seats.find((seat) => seat.playerId === playerId)
  }

  seatAt(seat: number): Seat | undefined {
    return this.seats.find((entry) => entry.seat === seat)
  }

  seatedPlayers(): { playerId: string; nickname: string; seat: number; stack: number }[] {
    return this.seats.map(({ playerId, nickname, seat, stack }) => ({ playerId, nickname, seat, stack }))
  }

  isHandRunning(): boolean {
    return this.phase !== 'waiting' && this.phase !== 'settlement'
  }

  canStartHand(): boolean {
    return !this.isHandRunning() && this.seats.filter((seat) => seat.stack > 0).length >= 2
  }

  sit(playerId: string, nickname: string, seat: number, stack = this.config.startingStack): void {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.config.maxSeats) {
      throw new EngineError('bad_state', '座位号超出范围')
    }
    if (this.seatAt(seat)) throw new EngineError('bad_state', '该座位已被占用')
    if (this.seatOf(playerId)) throw new EngineError('bad_state', '你已经入座')
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
      pendingLeave: false,
    })
    this.seats.sort((a, b) => a.seat - b.seat)
  }

  /** 离座：手牌进行中先记为弃牌，筹码留在池中，本手结束后移除。 */
  leave(playerId: string): void {
    const seat = this.seatOf(playerId)
    if (!seat) return
    if (this.isHandRunning() && seat.inHand) {
      seat.folded = true
      seat.lastAction = 'fold'
      seat.pendingLeave = true
      if (this.actingSeat === seat.seat) this.progress()
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
    if (this.buttonSeat === null) return this.seats.find((seat) => seat.stack > 0)?.seat ?? 0
    return this.nextSeatWhere(this.buttonSeat, (seat) => seat.stack > 0) ?? this.buttonSeat
  }

  startHand(options: { handId: string; rng: Rng; buttonSeat?: number; deck?: readonly Card[] }): void {
    if (this.isHandRunning()) throw new EngineError('bad_state', '当前手牌尚未结束')

    this.seats = this.seats.filter((seat) => !seat.pendingLeave)
    const participants = this.seats.filter((seat) => seat.stack > 0)
    if (participants.length < 2) throw new EngineError('bad_state', '至少需要 2 名有筹码的玩家')

    this.handId = options.handId
    this.handNo += 1
    this.result = null
    this.board = []
    this.burn = []
    // deck 仅用于测试注入固定牌序（数组末尾是第一个被发出的牌）；生产走安全随机洗牌。
    this.deck = options.deck ? [...options.deck] : shuffle(createDeck(), options.rng)
    this.currentBet = 0
    this.minRaise = this.config.bigBlind

    for (const seat of this.seats) {
      seat.inHand = seat.stack > 0
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
    if (!this.seatAt(this.buttonSeat) || this.seatAt(this.buttonSeat)!.stack <= 0) {
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

    const mayRaise = this.raiseAllowed.get(seat.seat) ?? false
    if (mayRaise && maxTarget > this.currentBet) {
      const minTarget = this.currentBet === 0 ? this.config.bigBlind : this.currentBet + this.minRaise
      const bounded = Math.min(minTarget, maxTarget)
      actions.push(
        this.currentBet === 0
          ? { action: 'bet', min: bounded, max: maxTarget }
          : { action: 'raise', min: bounded, max: maxTarget },
      )
    }

    if (seat.stack > 0) actions.push({ action: 'all_in', amount: maxTarget })
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
        lastAction: seat.lastAction,
        revealedCards: seat.revealedCards ? [...seat.revealedCards] : null,
      })),
      result: this.result,
    }
  }
}
