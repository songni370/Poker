// 对局音效的判定规则单测（纯逻辑，不依赖浏览器 / Web Audio）。
//
// 音效本质上是「快照 diff」：服务端每次推送都带完整公共状态，
// 这次推送比上次多了什么（牌、下注、弃牌…），就说明场上发生了什么。
//
// 这里用真实 HoldemTable 驱动出牌局，再按服务端 rooms.ts 的方式把它转成
// 协议快照（引擎用 actingSeat，协议用 actingPlayerId），保证判定规则
// 面对的是客户端真正收到的数据结构。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HoldemTable } from '../src/engine/table.ts'
import { seededRng } from '../src/engine/deck.ts'
import type { GameStatePublic, PrivateSelfState, SeatPublic } from '../src/shared/protocol.ts'
import { resolveCues, type CueContext, type SoundCue } from '../src/client/sound/cues.ts'

const CONFIG = { smallBlind: 10, bigBlind: 20, startingStack: 2000, maxSeats: 9 }
const NAMES: Record<string, string> = { p1: '小满', p2: '阿宽' }

/** 建一张两人桌并开一手牌。 */
function twoPlayerTable(): HoldemTable {
  const table = new HoldemTable(CONFIG)
  table.sit('p1', '小满', 1, 2000)
  table.sit('p2', '阿宽', 2, 2000)
  table.startHand({ handId: 'h1', rng: seededRng(7), buttonSeat: 1 })
  return table
}

/**
 * 按服务端 rooms.ts 的映射把引擎状态转成协议快照。
 * 两个关键转换：
 * 1. 引擎 seats 是压缩数组（只含已入座者），协议 seats 是定长数组、下标即座位号。
 * 2. 引擎用 actingSeat（座位号），协议用 actingPlayerId。
 */
function snapshot(table: HoldemTable): GameStatePublic {
  const engineState = table.publicState()

  // 协议约定：seats 下标就是座位号，空位为 null。
  const seats: (SeatPublic | null)[] = new Array(CONFIG.maxSeats).fill(null)
  for (const seat of engineState.seats) {
    seats[seat.seat] = {
      playerId: seat.playerId,
      seat: seat.seat,
      nickname: seat.nickname,
      stack: seat.stack,
      committedStreet: seat.committedStreet,
      committedHand: seat.committedHand,
      folded: seat.folded,
      allIn: seat.allIn,
      connected: true,
      inHand: seat.inHand,
      isHost: seat.playerId === 'p1',
      ready: true,
      away: seat.away,
      isDealer: engineState.buttonSeat === seat.seat,
      isSmallBlind: engineState.smallBlindSeat === seat.seat,
      isBigBlind: engineState.bigBlindSeat === seat.seat,
      holeCardCount: seat.inHand && !seat.away ? 2 : 0,
      lastAction: seat.lastAction,
    } as SeatPublic
  }

  const actingSeat = engineState.actingSeat
  const actingPlayerId = actingSeat === null ? null : (engineState.seats.find((seat) => seat.seat === actingSeat)?.playerId ?? null)

  return {
    roomId: 'room1',
    roomName: '测试房',
    status: 'playing',
    version: 1,
    handId: engineState.handId,
    handNo: engineState.handNo,
    phase: engineState.phase,
    street: engineState.street,
    board: engineState.board,
    pots: engineState.pots,
    potTotal: engineState.potTotal,
    currentBet: engineState.currentBet,
    minRaise: engineState.minRaise,
    smallBlind: 10,
    bigBlind: 20,
    startingStack: 2000,
    buyInMin: 2000,
    buyInMax: 5000,
    buyInStep: 10,
    maxSeats: 9,
    turnSeconds: 30,
    nextHandSeconds: 5,
    nextHandDeadlineAt: null,
    seats,
    scores: [],
    buttonSeat: engineState.buttonSeat,
    actingPlayerId,
    turnDeadlineAt: null,
    lastResult: engineState.result,
  } as unknown as GameStatePublic
}

/** 构造私有状态：判定只读 playerId 与底牌张数。 */
function selfState(playerId: string, holeCards = 2): PrivateSelfState {
  return {
    playerId,
    seat: null,
    holeCards: Array.from({ length: holeCards }, () => 'As'),
    legalActions: [],
  } as unknown as PrivateSelfState
}

function cuesOf(overrides: Partial<CueContext> & Pick<CueContext, 'eventType' | 'next' | 'self'>): SoundCue[] {
  return resolveCues({ prev: null, wasMyTurn: false, ...overrides })
}

const kinds = (cues: SoundCue[]): string[] => cues.map((cue) => cue.kind)

/** 当前该行动的人的 playerId。 */
function toAct(table: HoldemTable): string {
  const state = table.publicState()
  const seat = state.seats.find((item) => item.seat === state.actingSeat)
  assert.ok(seat, '牌桌上应有正在行动的座位')
  return seat.playerId
}

test('音效判定：首次进入房间不补发历史动作的声音', () => {
  const table = twoPlayerTable()
  const cues = cuesOf({ eventType: 'room.snapshot', next: snapshot(table), self: selfState('p1') })
  const chips = cues.filter((cue) => cue.kind === 'chips')
  assert.equal(chips.length, 0, '进入房间不应该补播下注声')
})

test('音效判定：进入房间且轮到我时提示一次', () => {
  const table = twoPlayerTable()
  const state = snapshot(table)
  assert.ok(state.actingPlayerId, '开局后应有行动者')
  const cues = cuesOf({ eventType: 'room.snapshot', next: state, self: selfState(state.actingPlayerId!) })
  assert.ok(kinds(cues).includes('yourTurn'), '轮到我行动应有提示音')
})

test('音效判定：新开一手发底牌 → 发牌声', () => {
  const table = new HoldemTable(CONFIG)
  table.sit('p1', '小满', 1, 2000)
  table.sit('p2', '阿宽', 2, 2000)
  const before = snapshot(table)
  table.startHand({ handId: 'h1', rng: seededRng(7), buttonSeat: 1 })
  const after = snapshot(table)

  const deal = cuesOf({ eventType: 'hand.started', next: after, self: selfState('p1'), prev: before }).find(
    (cue) => cue.kind === 'deal',
  )
  assert.ok(deal, '开局应有发牌声')
  assert.equal(deal.kind === 'deal' && deal.count, 2, '每个玩家发 2 张底牌')
})

test('音效判定：翻牌发出 3 张公共牌 → 发牌声', () => {
  const table = twoPlayerTable()
  const before = snapshot(table)
  table.act(toAct(table), 'call')
  table.act(toAct(table), 'check')
  const after = snapshot(table)

  assert.equal(after.board.length, 3, '过牌后应进入翻牌')
  const deal = cuesOf({ eventType: 'hand.state_changed', next: after, self: selfState('p1'), prev: before }).find(
    (cue) => cue.kind === 'deal',
  )
  assert.ok(deal, '翻牌应有发牌声')
  assert.equal(deal.kind === 'deal' && deal.count, 3, '翻牌一次发 3 张')
})

test('音效判定：跟注 10 → 筹码声金额为 10', () => {
  const table = twoPlayerTable()
  const before = snapshot(table)
  table.act(toAct(table), 'call')
  const after = snapshot(table)

  const cue = cuesOf({ eventType: 'hand.state_changed', next: after, self: selfState('p1'), prev: before }).find(
    (item) => item.kind === 'chips',
  )
  assert.ok(cue, '跟注应有筹码声')
  assert.equal(cue.kind === 'chips' && cue.amount, 10, '跟注 10 应报出 10')
})

test('音效判定：加注的筹码声金额按本轮净增额，而不是总额', () => {
  const table = twoPlayerTable()
  table.act(toAct(table), 'call')
  const beforeRaise = snapshot(table)
  // 大盲本轮已投 20，加注到 60 → 净增 40。
  table.act(toAct(table), 'raise', 60)
  const afterRaise = snapshot(table)

  const cue = cuesOf({
    eventType: 'hand.state_changed',
    next: afterRaise,
    self: selfState('p1'),
    prev: beforeRaise,
  }).find((item) => item.kind === 'chips')
  assert.ok(cue, '加注应有筹码声')
  assert.equal(cue.kind === 'chips' && cue.amount, 40, '加注到 60 时净增 40')
})

test('音效判定：弃牌 → 弃牌声', () => {
  const table = twoPlayerTable()
  const before = snapshot(table)
  table.act(toAct(table), 'fold')
  const after = snapshot(table)

  assert.ok(
    kinds(cuesOf({ eventType: 'hand.state_changed', next: after, self: selfState('p1'), prev: before })).includes('fold'),
    '弃牌应有弃牌声',
  )
})

test('音效判定：过牌 → 敲桌声，不会误报成筹码声', () => {
  const table = twoPlayerTable()
  table.act(toAct(table), 'call')
  const beforeCheck = snapshot(table)
  table.act(toAct(table), 'check')
  const afterCheck = snapshot(table)

  const cueKinds = kinds(
    cuesOf({ eventType: 'hand.state_changed', next: afterCheck, self: selfState('p1'), prev: beforeCheck }),
  )
  assert.ok(cueKinds.includes('check'), '过牌应有敲桌声')
  assert.ok(!cueKinds.includes('chips'), '过牌不应发筹码声')
})

test('音效判定：轮到我行动时才提示，同一回合不重复', () => {
  const table = twoPlayerTable()
  const state = snapshot(table)
  const actingId = state.actingPlayerId!

  const mine = cuesOf({ eventType: 'turn.started', next: state, self: selfState(actingId), prev: state, wasMyTurn: false })
  assert.ok(kinds(mine).includes('yourTurn'))

  const again = cuesOf({ eventType: 'turn.started', next: state, self: selfState(actingId), prev: state, wasMyTurn: true })
  assert.ok(!kinds(again).includes('yourTurn'), '同一回合不应重复提示')
})

test('音效判定：结算时赢家有胜利音，输家只有普通提示', () => {
  const table = twoPlayerTable()
  const before = snapshot(table)
  // 小盲直接弃牌，大盲不战而胜。
  table.act(toAct(table), 'fold')
  const after = snapshot(table)
  assert.ok(after.lastResult, '弃牌后应产生结算')

  const winnerId = after.lastResult!.winners[0]!.playerId
  const loserId = winnerId === 'p1' ? 'p2' : 'p1'
  assert.ok(NAMES[winnerId], '赢家应是真实玩家')

  const winnerCues = kinds(cuesOf({ eventType: 'hand.settled', next: after, self: selfState(winnerId), prev: before }))
  assert.ok(winnerCues.includes('win'), '赢家应听到胜利音')

  const loserCues = kinds(cuesOf({ eventType: 'hand.settled', next: after, self: selfState(loserId), prev: before }))
  assert.ok(!loserCues.includes('win'), '输家不应听到胜利音')
  assert.ok(loserCues.includes('ping'), '输家应听到普通结算提示')
})

/*
 * 音效开关默认值：用户反馈「没有音效」，根因是 soundEnabled 默认 false。
 * 默认值策略抽成纯函数 resolveSoundDefault()，直接断言，不启动 Web Audio。
 */
test('音效默认开启、BGM 默认关闭；用户手动关过则尊重持久化选择', async () => {
  const { resolveSoundDefault } = await import('../src/client/sound/index.ts')

  assert.equal(resolveSoundDefault(null), true, '首次访问（localStorage 无记录）音效默认开启')
  assert.equal(resolveSoundDefault('on'), true, '用户手动打开过则保持开启')
  assert.equal(resolveSoundDefault('off'), false, '用户手动关过要保持关闭，不能强制打开')
})
