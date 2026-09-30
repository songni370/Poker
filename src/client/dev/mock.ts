/**
 * 第 1 阶段的固定模拟场景。
 *
 * ⚠️ 只在开发环境使用：TableView.vue 里有一处接入点，第 3 阶段用真实 WebSocket
 * 快照（ServerEvent.state / ServerEvent.self）替换那处调用即可，本文件可整体删除。
 *
 * 所有场景都返回与协议完全一致的 `{ state: GameStatePublic, self: PrivateSelfState }`，
 * 或一个错误场景（房间关闭 / 被移出 / 房间已满），用于演示错误页。
 */
import type {
  ErrorCode,
  GameStatePublic,
  HandResultPublic,
  PrivateSelfState,
  RoomInfoResponse,
  SeatPublic,
} from '../../shared/protocol.ts'
import type { ActionType, Card, HandCategory, Street } from '../../shared/poker.ts'
import { HAND_CATEGORY_NAMES, TABLE_RULES } from '../../shared/poker.ts'

/* ────────────────────────────── 基础工具 ────────────────────────────── */

// 房间号与产品一致：纯数字（开发场景固定一个，方便截图比对）。
const roomId = '482913'

/** 固定昵称，方便截图比对；下标即座位号。 */
const NAMES = ['你', '林小满', '陈默', '阿水', '老张', 'Nina', 'Kai', '小柯', '周舟'] as const

const STACKS = [2000, 1500, 2780, 950, 3120, 640, 1880, 2260, 420, 1600, 880, 2040, 3000, 120, 2640, 780, 1990, 1440, 3660, 2000] as const

function stackOf(seat: number, offset = 0): number {
  const base = STACKS[(seat * 7 + offset) % STACKS.length] ?? TABLE_RULES.startingStack
  return base
}

interface SeatOptions {
  stack: number
  isSmallBlind?: boolean
  isBigBlind?: boolean
  committedHand?: number
  committedStreet?: number
  folded?: boolean
  allIn?: boolean
  connected?: boolean
  inHand?: boolean
  away?: boolean
  lastAction?: ActionType | null
  revealedCards?: Card[] | null
}

function seatAt(seat: number, options: SeatOptions): SeatPublic {
  return {
    playerId: `p${String(seat + 1)}`,
    seat,
    nickname: NAMES[seat] ?? `玩家${String(seat + 1)}`,
    stack: options.stack,
    committedStreet: options.committedStreet ?? 0,
    committedHand: options.committedHand ?? 0,
    folded: options.folded ?? false,
    allIn: options.allIn ?? false,
    connected: options.connected ?? true,
    inHand: options.inHand ?? true,
    isHost: seat === 0,
    ready: true,
    away: options.away ?? false,
    isDealer: false,
    isSmallBlind: options.isSmallBlind ?? false,
    isBigBlind: options.isBigBlind ?? false,
    holeCardCount: 2,
    revealedCards: options.revealedCards ?? null,
    lastAction: options.lastAction ?? null,
  }
}

function seatsFrom(entries: readonly (SeatPublic | null)[], maxSeats: number): (SeatPublic | null)[] {
  const seats: (SeatPublic | null)[] = []
  for (let index = 0; index < maxSeats; index += 1) seats.push(entries[index] ?? null)
  return seats
}

/** 盲注与庄位的文案位；真正的按钮位置由 buttonSeat 决定。 */
function markBlinds(seats: (SeatPublic | null)[], dealer: number, smallBlind: number, bigBlind: number): void {
  for (const seat of seats) {
    if (!seat) continue
    seat.isDealer = seat.seat === dealer
    seat.isSmallBlind = seat.seat === smallBlind
    seat.isBigBlind = seat.seat === bigBlind
  }
}

interface StateInit {
  phase: GameStatePublic['phase']
  street: Street | null
  board: Card[]
  seats: (SeatPublic | null)[]
  maxSeats: number
  buttonSeat: number | null
  /** 当前行动者座位号；null 表示没有人在行动。 */
  actingSeat?: number | null
  turnDeadlineMs?: number | null
  potTotal: number
  pots?: GameStatePublic['pots']
  currentBet?: number
  minRaise?: number
  handNo?: number
  handId?: string | null
  lastResult?: HandResultPublic | null
  status?: GameStatePublic['status']
}

/** 未显式给出边池时，把全部底池作为唯一主池，合格玩家为已在座的玩家。 */
function fallbackPots(init: StateInit): GameStatePublic['pots'] {
  if (init.potTotal <= 0) return []
  const eligible: string[] = []
  for (const seat of init.seats) if (seat) eligible.push(seat.playerId)
  return [{ amount: init.potTotal, eligiblePlayerIds: eligible }]
}

function buildState(init: StateInit): GameStatePublic {
  const actingSeat = init.actingSeat ?? null
  return {
    roomId,
    roomName: '周五夜局',
    status: init.status ?? 'playing',
    version: 41,
    handId: init.handId === undefined ? 'h-2026-09-21-07' : init.handId,
    handNo: init.handNo ?? 7,
    phase: init.phase,
    street: init.street,
    board: init.board,
    pots: init.pots ?? fallbackPots(init),
    potTotal: init.potTotal,
    currentBet: init.currentBet ?? 0,
    minRaise: init.minRaise ?? TABLE_RULES.bigBlind,
    smallBlind: TABLE_RULES.smallBlind,
    bigBlind: TABLE_RULES.bigBlind,
    startingStack: TABLE_RULES.startingStack,
    buyInMin: TABLE_RULES.startingStack,
    buyInMax: TABLE_RULES.maxBuyInDefault,
    buyInStep: TABLE_RULES.smallBlind,
    maxSeats: init.maxSeats,
    turnSeconds: TABLE_RULES.turnSeconds,
    nextHandSeconds: TABLE_RULES.nextHandSeconds,
    nextHandDeadlineAt: null,
    seats: init.seats,
    scores: [],
    buttonSeat: init.buttonSeat,
    actingPlayerId: actingSeat === null ? null : (init.seats[actingSeat]?.playerId ?? null),
    turnDeadlineAt: actingSeat === null ? null : Date.now() + (init.turnDeadlineMs ?? 14_000),
    lastResult: init.lastResult ?? null,
  }
}

/** 结算数据：只公开已亮牌玩家的底牌，绝不从别处补。 */
function resultFrom(
  state: GameStatePublic,
  options: {
    showdown: boolean
    board: Card[]
    winners: {
      playerId: string
      amount: number
      category: HandCategory | null
      bestFive: Card[]
      potIndex: number
    }[]
    potTotal: number
  },
): HandResultPublic {
  const revealed = state.seats
    .filter((seat): seat is SeatPublic => Boolean(seat?.revealedCards?.length))
    .map((seat) => ({
      playerId: seat.playerId,
      cards: seat.revealedCards ?? [],
      handName: HAND_CATEGORY_NAMES[options.winners.find((w) => w.playerId === seat.playerId)?.category ?? 'high_card'],
    }))

  return {
    handId: state.handId ?? 'h-mock',
    handNo: state.handNo,
    board: options.board,
    potTotal: options.potTotal,
    showdown: options.showdown,
    winners: options.winners.map((winner) => ({
      playerId: winner.playerId,
      amount: winner.amount,
      handName: winner.category ? HAND_CATEGORY_NAMES[winner.category] : null,
      bestFive: winner.bestFive,
      potIndex: winner.potIndex,
    })),
    revealed,
  }
}

const sid = (seat: number): string => `p${String(seat + 1)}`

/* ────────────────────────────── 场景定义 ────────────────────────────── */

/** 等待开局：2 人已座，其余空位。 */
function scenarioWaiting(): MockSnapshot {
  const maxSeats = 6
  const seats = seatsFrom(
    [
      seatAt(0, { stack: TABLE_RULES.startingStack, inHand: false, committedHand: 0 }),
      seatAt(2, { stack: TABLE_RULES.startingStack, inHand: false, committedHand: 0 }),
    ],
    maxSeats,
  )
  markBlinds(seats, 0, 0, 0)
  const state = buildState({
    status: 'waiting',
    phase: 'waiting',
    street: null,
    board: [],
    seats,
    maxSeats,
    buttonSeat: 0,
    handId: null,
    handNo: 0,
    potTotal: 0,
    pots: [],
  })
  return { state, self: { playerId: sid(0), seat: 0, holeCards: [], legalActions: [] } }
}

/** 翻牌前：6 人桌，轮到自己（按钮位，前面 5 人已跟注或弃牌）。 */
function scenarioPreflop(): MockSnapshot {
  const maxSeats = 6
  const seats = seatsFrom(
    [
      seatAt(0, { stack: 2000, committedStreet: 0, committedHand: 0 }),
      seatAt(1, { stack: 1990, committedStreet: 10, committedHand: 10 }),
      seatAt(2, { stack: 1980, committedStreet: 20, committedHand: 20 }),
      seatAt(3, { stack: 1940, committedStreet: 20, committedHand: 20, lastAction: 'call' }),
      seatAt(4, { stack: 1980, committedStreet: 20, committedHand: 20, lastAction: 'call' }),
      seatAt(5, { stack: 2000, committedStreet: 0, committedHand: 0, folded: true, inHand: false, lastAction: 'fold' }),
    ],
    maxSeats,
  )
  markBlinds(seats, 0, 1, 2)
  const state = buildState({
    phase: 'preflop',
    street: 'preflop',
    board: [],
    seats,
    maxSeats,
    buttonSeat: 0,
    actingSeat: 0,
    potTotal: 90,
    currentBet: 20,
    minRaise: 20,
  })
  return {
    state,
    self: {
      playerId: sid(0),
      seat: 0,
      holeCards: ['As', 'Kh'],
      legalActions: [
        { action: 'fold' },
        { action: 'call', amount: 20 },
        { action: 'raise', min: 40, max: 2000 },
        { action: 'all_in', amount: 2000 },
      ],
    },
  }
}

/** 翻牌圈：3 张公共牌，需跟注。 */
function scenarioFlop(): MockSnapshot {
  const maxSeats = 6
  const seats = seatsFrom(
    [
      seatAt(0, { stack: 1940, committedStreet: 0, committedHand: 60 }),
      seatAt(1, { stack: 1940, committedStreet: 0, committedHand: 60, folded: true, lastAction: 'fold' }),
      seatAt(2, { stack: 1940, committedStreet: 0, committedHand: 60, folded: true, lastAction: 'fold' }),
      seatAt(3, { stack: 1940, committedStreet: 0, committedHand: 60, lastAction: 'call' }),
      seatAt(4, { stack: 1820, committedStreet: 120, committedHand: 180, lastAction: 'bet' }),
      seatAt(5, { stack: 2000, committedStreet: 0, committedHand: 0, folded: true, inHand: false, lastAction: 'fold' }),
    ],
    maxSeats,
  )
  markBlinds(seats, 0, 1, 2)
  const state = buildState({
    phase: 'flop',
    street: 'flop',
    board: ['As', '7h', '2d'] satisfies Card[],
    seats,
    maxSeats,
    buttonSeat: 0,
    actingSeat: 0,
    potTotal: 360,
    currentBet: 120,
    minRaise: 120,
  })
  return {
    state,
    self: {
      playerId: sid(0),
      seat: 0,
      holeCards: ['Ac', 'Qc'],
      legalActions: [
        { action: 'fold' },
        { action: 'call', amount: 120 },
        { action: 'raise', min: 240, max: 1940 },
        { action: 'all_in', amount: 1940 },
      ],
    },
  }
}

/** 转牌圈：4 张公共牌，面对一个大额加注。 */
function scenarioTurn(): MockSnapshot {
  const maxSeats = 6
  const seats = seatsFrom(
    [
      seatAt(0, { stack: 3000, committedStreet: 0, committedHand: 2000 }),
      seatAt(1, { stack: 1940, committedStreet: 0, committedHand: 60, folded: true, lastAction: 'fold' }),
      seatAt(2, { stack: 1940, committedStreet: 0, committedHand: 60, folded: true, lastAction: 'fold' }),
      seatAt(3, { stack: 1940, committedStreet: 0, committedHand: 60, folded: true, lastAction: 'fold' }),
      seatAt(4, { stack: 10060, committedStreet: 2000, committedHand: 2000, lastAction: 'raise' }),
      seatAt(5, { stack: 2000, committedStreet: 0, committedHand: 0, folded: true, inHand: false, lastAction: 'fold' }),
    ],
    maxSeats,
  )
  markBlinds(seats, 0, 1, 2)
  const state = buildState({
    phase: 'turn',
    street: 'turn',
    board: ['As', '7h', '2d', 'Kd'] satisfies Card[],
    seats,
    maxSeats,
    buttonSeat: 0,
    actingSeat: 0,
    potTotal: 8120,
    currentBet: 2000,
    minRaise: 1960,
  })
  return {
    state,
    self: {
      playerId: sid(0),
      seat: 0,
      holeCards: ['Ac', 'Qc'],
      legalActions: [
        { action: 'fold' },
        { action: 'call', amount: 2000 },
        { action: 'raise', min: 3960, max: 3000 },
        { action: 'all_in', amount: 3000 },
      ],
    },
  }
}

/** 河牌圈：5 张公共牌，无需跟注（可过牌或下注）。 */
function scenarioRiver(): MockSnapshot {
  const maxSeats = 6
  const seats = seatsFrom(
    [
      seatAt(0, { stack: 4340, committedStreet: 0, committedHand: 2000 }),
      seatAt(1, { stack: 1940, committedStreet: 0, committedHand: 60, folded: true, lastAction: 'fold' }),
      seatAt(2, { stack: 1940, committedStreet: 0, committedHand: 60, folded: true, lastAction: 'fold' }),
      seatAt(3, { stack: 1940, committedStreet: 0, committedHand: 60, folded: true, lastAction: 'fold' }),
      seatAt(4, { stack: 9000, committedStreet: 900, committedHand: 2900, lastAction: 'call' }),
      seatAt(5, { stack: 1600, committedStreet: 1600, committedHand: 3000, lastAction: 'bet' }),
    ],
    maxSeats,
  )
  markBlinds(seats, 0, 1, 2)
  const state = buildState({
    phase: 'river',
    street: 'river',
    board: ['As', '7h', '2d', 'Kd', '3c'] satisfies Card[],
    seats,
    maxSeats,
    buttonSeat: 0,
    actingSeat: 0,
    potTotal: 12320,
    currentBet: 1600,
    minRaise: 1600,
  })
  return {
    state,
    self: {
      playerId: sid(0),
      seat: 0,
      holeCards: ['Ac', 'Qc'],
      legalActions: [
        { action: 'fold' },
        { action: 'call', amount: 1600 },
        { action: 'raise', min: 3200, max: 4340 },
        { action: 'all_in', amount: 4340 },
      ],
    },
  }
}

/** 摊牌 + 结算叠层：主池与边池分别派发。 */
function scenarioShowdown(): MockSnapshot {
  const maxSeats = 6
  const seats = seatsFrom(
    [
      seatAt(0, { stack: 4200, committedStreet: 1200, committedHand: 1200, revealedCards: ['Tc', '9c'] }),
      seatAt(1, { stack: 1940, committedStreet: 0, committedHand: 60, folded: true, lastAction: 'fold' }),
      seatAt(2, { stack: 1940, committedStreet: 0, committedHand: 60, folded: true, lastAction: 'fold' }),
      seatAt(3, { stack: 1940, committedStreet: 0, committedHand: 60, folded: true, lastAction: 'fold' }),
      seatAt(4, { stack: 6000, committedStreet: 1200, committedHand: 1200, revealedCards: ['Ks', 'Kd'] }),
      seatAt(5, { stack: 2000, committedStreet: 0, committedHand: 0, folded: true, inHand: false, lastAction: 'fold' }),
    ],
    maxSeats,
  )
  markBlinds(seats, 0, 1, 2)

  const state = buildState({
    phase: 'showdown',
    street: 'river',
    board: ['As', '7h', '2d', 'Jc', 'Tc'] satisfies Card[],
    seats,
    maxSeats,
    buttonSeat: 0,
    actingSeat: null,
    potTotal: 8000,
    pots: [
      { amount: 6000, eligiblePlayerIds: [sid(0), sid(4), sid(5), sid(7)] },
      { amount: 2000, eligiblePlayerIds: [sid(0), sid(4)] },
    ],
    currentBet: 1200,
  })

  state.lastResult = resultFrom(state, {
    showdown: true,
    board: state.board as Card[],
    potTotal: 8000,
    winners: [
      { playerId: sid(0), amount: 6000, category: 'straight', bestFive: ['As', 'Kd', 'Qc', 'Jc', 'Tc'] satisfies Card[], potIndex: 0 },
      { playerId: sid(4), amount: 2000, category: 'trips', bestFive: ['As', 'Kd', 'Ks', 'Kc', 'Jc'] satisfies Card[], potIndex: 1 },
    ],
  })

  return {
    state,
    self: { playerId: sid(0), seat: 0, holeCards: ['Tc', '9c'], legalActions: [] },
    notice: '本手进入摊牌：主池 6000、边池 2000 已按牌型分配。',
  }
}

/** 结算阶段（叠层打开时的状态）。 */
function scenarioSettlement(): MockSnapshot {
  const base = scenarioShowdown()
  const state: GameStatePublic = { ...base.state, phase: 'settlement', version: 42 }
  return { state, self: base.self }
}

/** 单赢家：其他人全部弃牌，不亮底牌。 */
function scenarioSingleWinner(): MockSnapshot {
  const maxSeats = 6
  const seats = seatsFrom(
    [
      seatAt(0, { stack: 2180, committedStreet: 0, committedHand: 60 }),
      seatAt(1, { stack: 1980, committedStreet: 0, committedHand: 20, folded: true, lastAction: 'fold' }),
      seatAt(2, { stack: 1960, committedStreet: 0, committedHand: 40, folded: true, lastAction: 'fold' }),
      seatAt(3, { stack: 1900, committedStreet: 0, committedHand: 100, folded: true, lastAction: 'fold' }),
      seatAt(4, { stack: 2000, committedStreet: 0, committedHand: 0, folded: true, lastAction: 'fold' }),
      seatAt(5, { stack: 1980, committedStreet: 0, committedHand: 20, folded: true, lastAction: 'fold' }),
    ],
    maxSeats,
  )
  markBlinds(seats, 0, 1, 2)
  const state = buildState({
    phase: 'settlement',
    street: 'preflop',
    board: [],
    seats,
    maxSeats,
    buttonSeat: 0,
    actingSeat: null,
    potTotal: 240,
    currentBet: 60,
    handNo: 8,
  })
  state.lastResult = resultFrom(state, {
    showdown: false,
    board: [],
    potTotal: 240,
    winners: [{ playerId: sid(0), amount: 240, category: null, bestFive: [] as Card[], potIndex: 0 }],
  })
  return { state, self: { playerId: sid(0), seat: 0, holeCards: ['Ac', 'Qc'], legalActions: [] } }
}

/** 多人平分：公共牌即最佳五张。 */
function scenarioSplitPot(): MockSnapshot {
  const maxSeats = 6
  const seats = seatsFrom(
    [
      seatAt(0, { stack: 1200, committedStreet: 0, committedHand: 800, revealedCards: ['As', '2h'] }),
      seatAt(1, { stack: 1200, committedStreet: 0, committedHand: 800, revealedCards: ['Kh', '3c'] }),
      seatAt(2, { stack: 1200, committedStreet: 0, committedHand: 800, revealedCards: ['Qh', '4d'] }),
      seatAt(3, { stack: 2000, committedStreet: 0, committedHand: 0, folded: true, inHand: false, lastAction: 'fold' }),
      seatAt(4, { stack: 2000, committedStreet: 0, committedHand: 0, folded: true, inHand: false, lastAction: 'fold' }),
      seatAt(5, { stack: 2000, committedStreet: 0, committedHand: 0, folded: true, inHand: false, lastAction: 'fold' }),
    ],
    maxSeats,
  )
  markBlinds(seats, 0, 1, 2)
  const state = buildState({
    phase: 'showdown',
    street: 'river',
    board: ['As', 'Kh', 'Qd', 'Jc', 'Ts'] satisfies Card[],
    seats,
    maxSeats,
    buttonSeat: 0,
    actingSeat: null,
    potTotal: 3200,
    currentBet: 800,
    handNo: 9,
  })
  state.lastResult = resultFrom(state, {
    showdown: true,
    board: state.board as Card[],
    potTotal: 3200,
    winners: [
      { playerId: sid(0), amount: 1066, category: 'straight', bestFive: ['As', 'Kh', 'Qd', 'Jc', 'Ts'] satisfies Card[], potIndex: 0 },
      { playerId: sid(1), amount: 1067, category: 'straight', bestFive: ['As', 'Kh', 'Qd', 'Jc', 'Ts'] satisfies Card[], potIndex: 0 },
      { playerId: sid(2), amount: 1067, category: 'straight', bestFive: ['As', 'Kh', 'Qd', 'Jc', 'Ts'] satisfies Card[], potIndex: 0 },
    ],
  })
  return { state, self: { playerId: sid(0), seat: 0, holeCards: ['As', '2h'], legalActions: [] } }
}

/** 他人全下：面对 3 家全下，保留单挑与边池。 */
function scenarioAllIn(): MockSnapshot {
  const maxSeats = 6
  const seats = seatsFrom(
    [
      seatAt(0, { stack: 5600, committedStreet: 0, committedHand: 0 }),
      seatAt(1, { stack: 1740, committedStreet: 200, committedHand: 260, lastAction: 'call' }),
      seatAt(2, { stack: 1960, committedStreet: 20, committedHand: 40, folded: true, lastAction: 'fold' }),
      seatAt(3, { stack: 0, committedStreet: 3800, committedHand: 3800, allIn: true, lastAction: 'all_in' }),
      seatAt(4, { stack: 0, committedStreet: 2400, committedHand: 2400, allIn: true, lastAction: 'all_in' }),
      seatAt(5, { stack: 2760, committedStreet: 2400, committedHand: 2400, lastAction: 'call' }),
    ],
    maxSeats,
  )
  markBlinds(seats, 0, 1, 2)
  const state = buildState({
    phase: 'preflop',
    street: 'preflop',
    board: [],
    seats,
    maxSeats,
    buttonSeat: 0,
    actingSeat: 0,
    potTotal: 12600,
    pots: [
      { amount: 7600, eligiblePlayerIds: [sid(0), sid(1), sid(3), sid(4)] },
      { amount: 3000, eligiblePlayerIds: [sid(1), sid(3), sid(4)] },
      { amount: 2000, eligiblePlayerIds: [sid(0), sid(3), sid(4)] },
    ],
    currentBet: 3800,
    minRaise: 1400,
  })
  return {
    state,
    self: {
      playerId: sid(0),
      seat: 0,
      holeCards: ['Jh', 'Js'],
      legalActions: [
        { action: 'fold' },
        { action: 'call', amount: 3800 },
        { action: 'raise', min: 5200, max: 5600 },
        { action: 'all_in', amount: 5600 },
      ],
    },
  }
}

/** 本人已全下：没有可执行动作，等待发完公共牌。 */
function scenarioHeroAllIn(): MockSnapshot {
  const base = scenarioAllIn()
  const seats = base.state.seats.map((seat) => (seat ? { ...seat } : null))
  const mine = seats[0]
  if (mine) {
    mine.stack = 0
    mine.committedStreet = 3800
    mine.committedHand = 3800
    mine.allIn = true
    mine.lastAction = 'all_in'
  }
  const state: GameStatePublic = {
    ...base.state,
    seats,
    actingPlayerId: null,
    turnDeadlineAt: null,
    potTotal: 17600,
  }
  return { state, self: { playerId: sid(0), seat: 0, holeCards: ['Jh', 'Js'], legalActions: [] } }
}

/** 有人断线：牌局继续，座位标记为断线并显示提示。 */
function scenarioDisconnected(): MockSnapshot {
  const base = scenarioTurn()
  const seats = base.state.seats.map((seat) => (seat ? { ...seat } : null))
  const dropped = seats[4]
  if (dropped) dropped.connected = false
  const state: GameStatePublic = { ...base.state, seats, version: 55 }
  return { state, self: base.self, notice: '阿水 已断线，牌局继续；其座位保留到宽限期结束。' }
}

/** 超时自动弃牌：服务端已按超时规则代为弃牌。 */
function scenarioTimeoutFold(): MockSnapshot {
  const maxSeats = 4
  const seats = seatsFrom(
    [
      seatAt(0, { stack: 1960, committedStreet: 20, committedHand: 20 }),
      seatAt(1, { stack: 1900, committedStreet: 100, committedHand: 100, lastAction: 'raise' }),
      seatAt(2, { stack: 1990, committedStreet: 0, committedHand: 10, folded: true, inHand: false, lastAction: 'fold' }),
      seatAt(3, { stack: 2000, committedStreet: 0, committedHand: 0, inHand: false }),
    ],
    maxSeats,
  )
  markBlinds(seats, 0, 2, 3)
  const state = buildState({
    phase: 'flop',
    street: 'flop',
    board: ['9s', '8s', '2c'] satisfies Card[],
    seats,
    maxSeats,
    buttonSeat: 0,
    actingSeat: 0,
    potTotal: 130,
    currentBet: 100,
    minRaise: 80,
    handNo: 10,
  })
  return {
    state,
    self: {
      playerId: sid(0),
      seat: 0,
      holeCards: ['9h', '9d'],
      legalActions: [
        { action: 'fold' },
        { action: 'call', amount: 80 },
        { action: 'raise', min: 180, max: 1960 },
        { action: 'all_in', amount: 1960 },
      ],
    },
    notice: '阿水 超时未行动，已按房间规则自动弃牌。',
  }
}

/** 空房：还没人入座。 */
function scenarioEmpty(): MockSnapshot {
  const maxSeats = 9
  const seats = seatsFrom([], maxSeats)
  const state = buildState({
    status: 'waiting',
    phase: 'waiting',
    street: null,
    board: [],
    seats,
    maxSeats,
    buttonSeat: null,
    handId: null,
    handNo: 0,
    potTotal: 0,
    pots: [],
  })
  return { state, self: { playerId: sid(0), seat: null, holeCards: [], legalActions: [] } }
}

/** 双人桌：检验 2 人排布（单挑盲注与按钮位置由服务端裁定）。 */
function scenarioHeadsUp(): MockSnapshot {
  const maxSeats = 2
  const seats = seatsFrom(
    [
      seatAt(0, { stack: 1980, committedStreet: 0, committedHand: 20 }),
      seatAt(1, { stack: 1990, committedStreet: 10, committedHand: 10 }),
    ],
    maxSeats,
  )
  markBlinds(seats, 1, 1, 0)
  const state = buildState({
    phase: 'preflop',
    street: 'preflop',
    board: [],
    seats,
    maxSeats,
    buttonSeat: 1,
    actingSeat: 1,
    potTotal: 30,
    currentBet: 20,
    minRaise: 20,
    handNo: 11,
  })
  return {
    state,
    self: {
      playerId: sid(1),
      seat: 1,
      holeCards: ['Ad', 'Kd'],
      legalActions: [
        { action: 'fold' },
        { action: 'call', amount: 10 },
        { action: 'raise', min: 40, max: 1990 },
        { action: 'all_in', amount: 1990 },
      ],
    },
  }
}

/** 9 人满桌：检验最多座位的椭圆排布。 */
function scenarioFullRing(): MockSnapshot {
  const maxSeats = 9
  const entries: (SeatPublic | null)[] = []
  for (let index = 0; index < maxSeats; index += 1) {
    // 0 号（本人）还未行动，1/2 号是盲注，其余跟注到 20。
    const committed = index === 0 || index > 6 ? 0 : index === 1 ? 10 : 20
    entries.push(
      seatAt(index, {
        stack: stackOf(index),
        committedStreet: committed,
        committedHand: committed,
        lastAction: index > 5 ? 'call' : null,
      }),
    )
  }
  const seats = seatsFrom(entries, maxSeats)
  markBlinds(seats, 0, 1, 2)
  const state = buildState({
    phase: 'preflop',
    street: 'preflop',
    board: [],
    seats,
    maxSeats,
    buttonSeat: 0,
    actingSeat: 0,
    potTotal: 150,
    currentBet: 20,
    minRaise: 20,
    handNo: 12,
  })
  return {
    state,
    self: {
      playerId: sid(0),
      seat: 0,
      holeCards: ['Qs', 'Qh'],
      legalActions: [
        { action: 'fold' },
        { action: 'call', amount: 20 },
        { action: 'raise', min: 40, max: 1600 },
        { action: 'all_in', amount: 1600 },
      ],
    },
  }
}

/**
 * 旁观者视角：本人没有座位，桌上有空位（第 5 项需求的落座流程）。
 * self.seat = null → 牌桌渲染空位按钮与买入弹窗。
 */
function scenarioSpectating(): MockSnapshot {
  const maxSeats = 9
  const entries: (SeatPublic | null)[] = []
  for (let index = 0; index < maxSeats; index += 1) {
    if (index > 2) {
      entries.push(null)
      continue
    }
    const committed = index === 1 ? 10 : 20
    entries.push(
      seatAt(index, {
        stack: stackOf(index),
        committedStreet: committed,
        committedHand: committed,
        lastAction: index > 0 ? 'call' : null,
      }),
    )
  }
  const seats = seatsFrom(entries, maxSeats)
  markBlinds(seats, 0, 1, 2)
  const state = buildState({
    phase: 'preflop',
    street: 'preflop',
    board: [],
    seats,
    maxSeats,
    buttonSeat: 0,
    actingSeat: 1,
    potTotal: 30,
    currentBet: 20,
    minRaise: 20,
    handNo: 3,
  })
  return { state, self: { playerId: 'spectator', seat: null, holeCards: [], legalActions: [] } }
}

/**
 * 已离座但保留座位：self.seat 仍是本人的座位（可以坐回），
 * 另外把一位对手也标成离座，用来核对桌面上「已离座」的显示。
 */
function scenarioAway(): MockSnapshot {
  const base = scenarioFlop()
  const heroSeat = base.self.seat
  if (heroSeat === null) return base
  const markAway = (index: number): void => {
    const seat = base.state.seats[index]
    if (!seat) return
    seat.away = true
    seat.folded = true
    seat.lastAction = 'fold'
    base.state.seats[index] = seat
  }
  markAway(heroSeat)
  markAway(heroSeat === 3 ? 4 : 3)
  base.self = { ...base.self, holeCards: [], legalActions: [] }
  return base
}

/* ────────────────────────────── 场景表 ────────────────────────────── */

export interface MockSnapshot {
  state: GameStatePublic
  self: PrivateSelfState
  /** 第 1 阶段的系统提示演示；第 3 阶段由 ServerEvent.notice 提供。 */
  notice?: string
}

/** 错误场景：房间关闭 / 被移出 / 房间已满。 */
export interface MockErrorScenario {
  error: ErrorCode
  detail?: string
}

export type MockScenario = MockSnapshot | MockErrorScenario

export const MOCK_SCENARIOS: Record<string, MockScenario> = {
  waiting: scenarioWaiting(),
  preflop: scenarioPreflop(),
  flop: scenarioFlop(),
  turn: scenarioTurn(),
  river: scenarioRiver(),
  showdown: scenarioShowdown(),
  settlement: scenarioSettlement(),
  singleWinner: scenarioSingleWinner(),
  splitPot: scenarioSplitPot(),
  allIn: scenarioAllIn(),
  heroAllIn: scenarioHeroAllIn(),
  disconnected: scenarioDisconnected(),
  timeoutFold: scenarioTimeoutFold(),
  empty: scenarioEmpty(),
  headsUp: scenarioHeadsUp(),
  fullRing: scenarioFullRing(),
  spectating: scenarioSpectating(),
  away: scenarioAway(),
  closed: { error: 'room_closed' },
  kicked: { error: 'unauthorized', detail: '你已被主持人移出房间。' },
  full: { error: 'room_full' },
  versionMismatch: { error: 'stale_version', detail: '客户端与服务器版本不一致，请刷新页面后重试。' },
}

/** 场景名列表，供开发期快捷切换使用。 */
export const MOCK_SCENARIO_NAMES: readonly string[] = Object.keys(MOCK_SCENARIOS)

export const DEFAULT_MOCK_SCENARIO = 'flop'

/** 默认场景对象，随 TableView 默认场景一起变化。 */
const defaultScenario: MockSnapshot = scenarioFlop()

export type DevScenarioResult = { kind: 'snapshot'; snapshot: MockSnapshot } | { kind: 'redirect'; error: MockErrorScenario }

/**
 * 视图唯一入口：给定场景名返回快照或错误页参数。
 * import.meta.env.DEV 判定放在本模块内部，生产构建时本文件整体不会进入依赖图。
 */
export function devScenario(name: string): DevScenarioResult {
  if (!import.meta.env.DEV) {
    // 生产环境不存在模拟数据；返回默认场景只是为了保持返回类型稳定。
    return { kind: 'snapshot', snapshot: defaultScenario }
  }
  const found = MOCK_SCENARIOS[name]
  if (found && 'error' in found) return { kind: 'redirect', error: found }
  if (found && 'state' in found) return { kind: 'snapshot', snapshot: found }
  return { kind: 'snapshot', snapshot: defaultScenario }
}

/** 等待区用的房间信息（第 3 阶段由 /api/rooms/:id 返回）。 */
export const MOCK_ROOM_INFO: RoomInfoResponse = {
  roomId,
  roomName: '周五夜局',
  status: 'waiting',
  seated: 2,
  maxSeats: TABLE_RULES.maxSeats,
  buyInMin: TABLE_RULES.startingStack,
  buyInMax: TABLE_RULES.maxBuyInDefault,
  buyInStep: TABLE_RULES.smallBlind,
  smallBlind: TABLE_RULES.smallBlind,
  bigBlind: TABLE_RULES.bigBlind,
  startingStack: TABLE_RULES.startingStack,
  turnSeconds: TABLE_RULES.turnSeconds,
  nextHandSeconds: TABLE_RULES.nextHandSeconds,
}
