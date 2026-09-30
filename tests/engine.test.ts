import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeck, seededRng, shuffle } from '../src/engine/deck.ts'
import { compareHands, evaluateHand } from '../src/engine/evaluate.ts'
import { awardPots, buildPots } from '../src/engine/pots.ts'
import { HoldemTable, type TableConfig } from '../src/engine/table.ts'
import { parseCard, type Card } from '../src/shared/poker.ts'

const cards = (...values: string[]): Card[] => values.map((value) => parseCard(value))

/** 按真实发牌顺序给出牌序：数组末尾元素是第一个被发出的牌（引擎用 pop 取牌）。 */
const deckFromDealOrder = (dealOrder: string[]): Card[] => dealOrder.map((value) => parseCard(value)).reverse()

const CONFIG: TableConfig = { smallBlind: 10, bigBlind: 20, startingStack: 2000, maxSeats: 9 }

function makeTable(players: [id: string, seat: number, stack: number][], config: TableConfig = CONFIG): HoldemTable {
  const table = new HoldemTable(config)
  for (const [id, seat, stack] of players) table.sit(id, id, seat, stack)
  return table
}

const stackOf = (table: HoldemTable, playerId: string): number => table.seatOf(playerId)!.stack

/* ───────────────────────────── 牌堆与牌型 ───────────────────────────── */

test('牌堆：52 张不重复，洗牌只是重排', () => {
  const deck = createDeck()
  assert.equal(deck.length, 52)
  assert.equal(new Set(deck).size, 52)
  const shuffled = shuffle(deck, seededRng(1))
  assert.deepEqual([...shuffled].sort(), [...deck].sort())
  assert.notDeepEqual(shuffled, deck)
})

test('牌型：A-2-3-4-5 作低顺，且不允许循环顺', () => {
  const wheel = evaluateHand(cards('As', '2h', '3d', '4c', '5s', 'Kh', 'Qd'))
  assert.equal(wheel.category, 'straight')
  assert.deepEqual(wheel.tiebreak, [5])

  const wrapped = evaluateHand(cards('Js', 'Qh', 'Kd', 'Ac', '2s', '7h', '9d'))
  assert.equal(wrapped.category, 'high_card', 'K-A-2 不能构成顺子')
})

test('牌型：同花顺 > 四条 > 葫芦 > 同花 > 顺子', () => {
  const straightFlush = evaluateHand(cards('9s', '8s', '7s', '6s', '5s', '2h', '3d'))
  const quads = evaluateHand(cards('As', 'Ah', 'Ad', 'Ac', '5s', '2h', '3d'))
  const fullHouse = evaluateHand(cards('Ks', 'Kh', 'Kd', '2c', '2s', '7h', '9d'))
  const flush = evaluateHand(cards('As', 'Js', '9s', '5s', '3s', '2h', 'Kd'))

  assert.equal(straightFlush.category, 'straight_flush')
  assert.equal(quads.category, 'quads')
  assert.equal(fullHouse.category, 'full_house')
  assert.equal(flush.category, 'flush')
  assert.ok(compareHands(straightFlush, quads) > 0)
  assert.ok(compareHands(quads, fullHouse) > 0)
  assert.ok(compareHands(fullHouse, flush) > 0)
})

test('踢脚牌参与比较；牌型与踢脚完全相同则平分', () => {
  const withNine = evaluateHand(cards('As', 'Ah', 'Kd', 'Qc', '9s', '7h', '2d'))
  const withEight = evaluateHand(cards('Ac', 'Ad', 'Kh', 'Qs', '8s', '7h', '2d'))
  const sameAsNine = evaluateHand(cards('Ac', 'Ad', 'Kh', 'Qs', '9s', '3h', '2d'))

  assert.equal(withNine.category, 'pair')
  assert.ok(compareHands(withNine, withEight) > 0, '同为一对 A 时 9 踢脚大于 8 踢脚')
  assert.equal(compareHands(withNine, sameAsNine), 0, '牌型与踢脚完全相同应平分')
})

/* ───────────────────────────── 边池 ───────────────────────────── */

test('边池：按投入分层，弃牌者仍出资但失去争夺资格', () => {
  const pots = buildPots([
    { playerId: 'a', amount: 100, folded: false },
    { playerId: 'b', amount: 300, folded: false },
    { playerId: 'c', amount: 500, folded: false },
  ])
  assert.deepEqual(pots, [
    { amount: 300, eligible: ['a', 'b', 'c'] },
    { amount: 400, eligible: ['b', 'c'] },
    { amount: 200, eligible: ['c'] },
  ])
  assert.equal(
    pots.reduce((sum, pot) => sum + pot.amount, 0),
    900,
  )

  const withFolded = buildPots([
    { playerId: 'a', amount: 100, folded: true },
    { playerId: 'b', amount: 100, folded: false },
  ])
  assert.deepEqual(withFolded, [{ amount: 200, eligible: ['b'] }])
})

test('边池分配：除不尽的余数按庄家左手优先发放，筹码守恒', () => {
  const tied = {
    category: 'pair' as const,
    tiebreak: [14, 13, 9, 7],
    bestFive: cards('As', 'Ah', 'Kd', 'Qc', '9s'),
    name: '一对 A',
  }
  const awards = awardPots([{ amount: 101, eligible: ['a', 'b'] }], () => tied, ['b', 'a'])
  assert.deepEqual(
    awards.map((award) => [award.playerId, award.amount]),
    [
      ['b', 51],
      ['a', 50],
    ],
  )
  assert.equal(
    awards.reduce((sum, award) => sum + award.amount, 0),
    101,
  )
})

/* ───────────────────────────── 座位、盲注与行动顺序 ───────────────────────────── */

test('双人桌：庄家即小盲，翻牌前先行动、翻牌后最后行动', () => {
  const table = makeTable([
    ['p1', 0, 1000],
    ['p2', 1, 1000],
  ])
  table.startHand({ handId: 'h1', rng: seededRng(7), buttonSeat: 0 })

  const preflop = table.publicState()
  assert.equal(preflop.actingSeat, 0, '双人桌翻牌前由庄家（小盲）先行动')
  assert.equal(table.seatOf('p1')!.committedStreet, 10, '庄家下小盲')
  assert.equal(table.seatOf('p2')!.committedStreet, 20, '对手下大盲')

  table.act('p1', 'call')
  table.act('p2', 'check')

  const flop = table.publicState()
  assert.equal(flop.street, 'flop')
  assert.equal(flop.board.length, 3)
  assert.equal(flop.actingSeat, 1, '翻牌后由非庄家（大盲）先行动')
})

test('跟注后的流程：翻牌前保留大盲选择权，翻牌后下注被跟注即进入下一街', () => {
  const table = makeTable([['sb', 0, 1000], ['bb', 1, 1000]])
  table.startHand({ handId: 'h-call-flow', rng: seededRng(17), buttonSeat: 0 })
  table.act('sb', 'call')
  assert.equal(table.publicState().actingSeat, 1, '小盲跟注不能跳过大盲的加注选择权')
  assert.ok(table.legalActions('bb').some((action) => action.action === 'check'))
  assert.ok(table.legalActions('bb').some((action) => action.action === 'raise'))

  table.act('bb', 'check')
  for (const [street, nextStreet] of [['flop', 'turn'], ['turn', 'river']] as const) {
    assert.equal(table.publicState().street, street)
    assert.equal(table.publicState().actingSeat, 1)
    table.act('bb', 'bet', 20)
    table.act('sb', 'call')
    assert.equal(table.publicState().street, nextStreet, '跟注后当前街应直接结束')
    assert.equal(table.publicState().actingSeat, 1, '新街才重新轮到大盲行动')
  }
  table.act('bb', 'bet', 20)
  table.act('sb', 'call')
  assert.equal(table.publicState().phase, 'settlement', '河牌跟注后直接摊牌结算')
  assert.equal(table.publicState().actingSeat, null)
})

test('筹码不足最小加注时只能全下，不能伪装为普通加注', () => {
  const table = makeTable([['short', 0, 55], ['deep', 1, 1000]])
  table.startHand({ handId: 'h-short-raise', rng: seededRng(19), buttonSeat: 0 })
  table.act('short', 'call')
  table.act('deep', 'check')
  table.act('deep', 'bet', 20)
  const actions = table.legalActions('short')
  assert.ok(actions.some((action) => action.action === 'call' && action.amount === 20))
  assert.ok(actions.some((action) => action.action === 'all_in' && action.amount === 35))
  assert.ok(!actions.some((action) => action.action === 'raise'))
  assert.throws(() => table.act('short', 'raise', 35), /当前不合法操作/)
  table.act('short', 'all_in')
  assert.equal(table.publicState().currentBet, 35)
})

test('三人桌：翻牌前由大盲左手第一位（庄家）先行动', () => {
  const table = makeTable([
    ['p1', 0, 2000],
    ['p2', 1, 2000],
    ['p3', 2, 2000],
  ])
  table.startHand({ handId: 'h1', rng: seededRng(11), buttonSeat: 0 })

  assert.equal(table.seatOf('p2')!.committedStreet, 10, '小盲在庄家左手')
  assert.equal(table.seatOf('p3')!.committedStreet, 20, '大盲在小盲左手')
  assert.equal(table.publicState().actingSeat, 0)
})

test('三人桌：每位玩家对下注表态后结束当前街，不再要求额外过牌', () => {
  const table = makeTable([['button', 0, 1000], ['sb', 1, 1000], ['bb', 2, 1000]])
  table.startHand({ handId: 'h-three-call-flow', rng: seededRng(23), buttonSeat: 0 })
  table.act('button', 'call')
  table.act('sb', 'call')
  assert.equal(table.publicState().actingSeat, 2, '大盲保留翻牌前选择权')
  table.act('bb', 'check')
  assert.equal(table.publicState().street, 'flop')
  assert.equal(table.publicState().actingSeat, 1)
  table.act('sb', 'bet', 40)
  table.act('bb', 'call')
  assert.equal(table.publicState().street, 'flop', '还有一名玩家未回应下注')
  table.act('button', 'call')
  assert.equal(table.publicState().street, 'turn')
  assert.equal(table.publicState().actingSeat, 1)
})

test('最小加注与未满额 All-in：不重新开放已行动玩家的加注权', () => {
  const table = makeTable([
    ['p1', 0, 2000],
    ['p2', 1, 2000],
    ['p3', 2, 110],
    ['p4', 3, 2000],
  ])
  table.startHand({ handId: 'h1', rng: seededRng(3), buttonSeat: 0 })

  assert.equal(table.publicState().actingSeat, 3, '大盲左手第一位先行动')
  table.act('p4', 'call')
  table.act('p1', 'raise', 100)
  assert.equal(table.publicState().minRaise, 80, '本次加注增量成为新的最小加注')
  assert.equal(table.publicState().actingSeat, 1, '加注后应从加注者左手继续')

  table.act('p2', 'call')
  table.act('p3', 'all_in') // 110 - 100 = 10 < 最小加注 80 → 未满额加注

  assert.equal(table.publicState().actingSeat, 3, '行动权回到尚未对加注表态的 p4')
  const p4Raise = table.legalActions('p4').find((action) => action.action === 'raise')
  assert.ok(p4Raise, 'p4 尚未表态，保留加注权')
  assert.equal(p4Raise.min, 190, '最小加注到 110 + 80')

  table.act('p4', 'call')
  assert.equal(table.publicState().actingSeat, 0, '轮到已经行动过的 p1')

  const p1Actions = table.legalActions('p1')
  assert.ok(
    !p1Actions.some((action) => action.action === 'raise'),
    '未满额 all-in 后，已行动过的 p1 不得再加注',
  )
  assert.ok(!p1Actions.some((action) => action.action === 'all_in'), '不能用全下绕过未重开的加注权')
  assert.throws(() => table.act('p1', 'all_in'), /当前不合法操作/)
  assert.equal(p1Actions.find((action) => action.action === 'call')!.amount, 10, 'p1 仍需补齐 10')

  table.act('p1', 'call')
  table.act('p2', 'call')
  const flop = table.publicState()
  assert.equal(flop.street, 'flop')
  assert.equal(flop.potTotal, 440, '四人各投入 110')
})

test('多次短额全下累计成完整加注后，给先前行动者重新开放加注', () => {
  const config = { ...CONFIG, smallBlind: 50, bigBlind: 100 }
  let table = makeTable([
    ['c', 0, 2000],
    ['d', 1, 200],
    ['e', 2, 2000],
    ['a', 3, 2000],
    ['b', 4, 125],
  ], config)
  table.startHand({ handId: 'h-cumulative', rng: seededRng(1), buttonSeat: 0 })
  table.act('a', 'call')
  table.act('b', 'all_in') // 100 → 125
  const oldSnapshot = table.serialize()
  delete oldSnapshot.lastActedBet
  table = HoldemTable.restore(oldSnapshot)
  table.act('c', 'call')
  table.act('d', 'all_in') // 125 → 200；两次短额合计等于完整的 100 加注
  table.act('e', 'call')

  assert.equal(table.publicState().actingSeat, 3)
  assert.equal(table.publicState().minRaise, 100)
  assert.equal(table.legalActions('a').find((action) => action.action === 'raise')?.min, 300)
  table.act('a', 'raise', 300)
  assert.equal(table.publicState().currentBet, 300)
})

test('非法操作被拒绝且不改变状态', () => {
  const table = makeTable([
    ['p1', 0, 2000],
    ['p2', 1, 2000],
    ['p3', 2, 2000],
  ])
  table.startHand({ handId: 'h1', rng: seededRng(5), buttonSeat: 0 })
  const before = table.publicState()

  assert.throws(() => table.act('p2', 'call'), /还没轮到你行动/)
  assert.throws(() => table.act('p1', 'check'), /当前不合法操作/)
  assert.throws(() => table.act('p1', 'raise', 30), /最少要下注到/)
  assert.throws(() => table.act('p1', 'raise', 999999), /超过你的筹码/)

  assert.equal(table.publicState().actingSeat, before.actingSeat)
  assert.equal(table.publicState().potTotal, before.potTotal)
  assert.equal(table.totalChips(), 6000)
})

/* ───────────────────────────── 摊牌与边池结算 ───────────────────────────── */

test('三家不同筹码全下：主池与边池按牌力分配，未被跟注部分退回', () => {
  const table = makeTable([
    ['p1', 0, 3000],
    ['p2', 1, 1000],
    ['p3', 2, 500],
  ])
  // 发牌顺序：庄家左手起顺时针 [p2, p3, p1]；每位两张 + 三张翻牌 + 转牌 + 河牌。
  const deck = deckFromDealOrder([
    'Ks', 'As', 'Qs',
    'Kh', 'Ah', 'Qh',
    '3c', '2c', '7d', '9h',
    '5d', 'Js',
    '6h', '4c',
  ])
  table.startHand({ handId: 'h1', rng: seededRng(1), buttonSeat: 0, deck })

  table.act('p1', 'all_in') // 3000
  table.act('p2', 'all_in') // 1000：全下跟注，不改变当前下注
  table.act('p3', 'all_in') // 500：全下跟注

  const state = table.publicState()
  assert.equal(state.phase, 'settlement')
  assert.equal(state.board.join(' '), '2c 7d 9h Js 4c')
  assert.equal(state.result!.showdown, true)
  assert.equal(state.result!.potTotal, 4500)

  // p3 拿 AA 赢主池 1500；p2 拿 KK 赢边池 1000；p1 的 2000 未被跟注，原样退回。
  assert.equal(stackOf(table, 'p3'), 1500)
  assert.equal(stackOf(table, 'p2'), 1000)
  assert.equal(stackOf(table, 'p1'), 2000)
  assert.equal(table.totalChips(), 4500)

  const byPlayer = new Map(state.result!.winners.map((winner) => [winner.playerId, winner.amount]))
  assert.equal(byPlayer.get('p3'), 1500)
  assert.equal(byPlayer.get('p2'), 1000)
  assert.equal(byPlayer.get('p1'), 2000)
})

test('全下后离座仍参与边池，坐回时不能在本手中重新买入或换座', () => {
  const table = makeTable([
    ['a', 0, 1000],
    ['b', 1, 500],
    ['c', 2, 500],
  ])
  table.startHand({ handId: 'h-away-allin', rng: seededRng(9), buttonSeat: 0 })
  table.act('a', 'all_in')
  table.leave('a')
  assert.equal(table.seatOf('a')!.folded, false)
  assert.throws(() => table.reSit('a', 'a', 3), /本手牌结束后才能换座/)
  table.sit('a', 'a', 0, 2000)
  assert.equal(table.seatOf('a')!.stack, 0, '本手仍在进行，不可补充筹码')
  table.act('b', 'all_in')
  table.act('c', 'all_in')

  const result = table.publicState().result!
  assert.equal(result.potTotal, 2000)
  assert.equal(result.winners.reduce((sum, winner) => sum + winner.amount, 0), 2000)
  assert.equal(table.totalChips(), 2000)
})

test('全员弃牌：最后一人直接收池，不进入摊牌', () => {
  const table = makeTable([
    ['p1', 0, 2000],
    ['p2', 1, 2000],
    ['p3', 2, 2000],
  ])
  table.startHand({ handId: 'h1', rng: seededRng(9), buttonSeat: 0 })
  table.act('p1', 'raise', 100)
  table.act('p2', 'fold')
  table.act('p3', 'fold')

  const state = table.publicState()
  assert.equal(state.phase, 'settlement')
  assert.equal(state.result!.showdown, false)
  assert.equal(state.result!.winners.length, 1)
  assert.equal(state.result!.winners[0]!.playerId, 'p1')
  assert.equal(stackOf(table, 'p1'), 2000 + 30, '赢下小盲 10 + 大盲 20')
  assert.equal(stackOf(table, 'p2'), 1990)
  assert.equal(stackOf(table, 'p3'), 1980)
  assert.equal(table.totalChips(), 6000)
})

/* ───────────────────────────── 不变量与随机对局 ───────────────────────────── */

test('随机对局不变量：筹码守恒、无人负筹码、底牌不重复、每人最多两张', () => {
  const table = makeTable([
    ['p1', 0, 2000],
    ['p2', 1, 2000],
    ['p3', 2, 2000],
    ['p4', 3, 2000],
    ['p5', 4, 2000],
    ['p6', 5, 2000],
  ])
  const rng = seededRng(20260921)
  let expectedTotal = 12000
  let played = 0

  for (let handNo = 1; handNo <= 80; handNo++) {
    if (table.seatedPlayers().filter((player) => player.stack > 0).length < 2) break
    table.startHand({ handId: `h${handNo}`, rng })
    played += 1

    let guard = 0
    while (table.isHandRunning()) {
      const state = table.publicState()
      assert.ok(state.actingSeat !== null, '有对局进行时必须有行动者')
      const seat = state.seats.find((entry) => entry.seat === state.actingSeat)!
      const legal = table.legalActions(seat.playerId)
      assert.ok(legal.length > 0, '行动者必须至少有一个合法动作')

      const pick = legal[Math.floor(rng() * legal.length)]!
      const amount =
        pick.action === 'bet' || pick.action === 'raise'
          ? pick.min! + Math.floor(rng() * ((pick.max ?? pick.min!) - pick.min! + 1))
          : undefined
      table.act(seat.playerId, pick.action, amount)

      if (++guard > 400) assert.fail(`第 ${handNo} 手未能在合理步数内结束`)
    }

    // 唯一行动者
    assert.equal(table.publicState().actingSeat, null)

    // 筹码守恒 + 非负
    assert.equal(table.totalChips(), expectedTotal, `第 ${handNo} 手后筹码不守恒`)
    for (const seat of table.publicState().seats) {
      assert.ok(seat.stack >= 0, '筹码不得为负')
      assert.ok(seat.committedHand >= 0)
    }

    // 底牌唯一且每人最多两张
    const seen = new Set<string>()
    let dealt = 0
    for (const player of table.seatedPlayers()) {
      const hole = table.holeCardsOf(player.playerId)
      assert.ok(hole.length <= 2, '每人最多两张底牌')
      dealt += hole.length
      for (const card of hole) {
        assert.ok(!seen.has(card), `底牌重复：${card}`)
        seen.add(card)
      }
    }
    assert.ok(dealt <= 12)

    const board = table.publicState().board
    assert.ok([0, 3, 4, 5].includes(board.length), `公共牌数量异常：${board.length}`)
    for (const card of board) {
      assert.ok(!seen.has(card), `公共牌与底牌重复：${card}`)
      seen.add(card)
    }
    assert.equal(new Set(board).size, board.length, '公共牌不得重复')

    // 破产玩家离座重入（等价于现实中重新买入），同步抬高筹码总量基准，让模拟能持续覆盖 all-in 路径。
    for (const player of table.seatedPlayers()) {
      if (player.stack > 0) continue
      table.leave(player.playerId)
      table.sit(player.playerId, player.nickname, player.seat, CONFIG.startingStack)
      expectedTotal += CONFIG.startingStack
    }
  }

  assert.ok(played >= 20, `随机对局样本过少：${played} 手`)
})

/* ───────────────────────────── 第 4 阶段：可恢复快照 ───────────────────────────── */

/** 确定性对局驱动：优先过牌，其次跟注，保证一定走到摊牌。 */
function playDeterministic(table: HoldemTable, stopAfter = Number.POSITIVE_INFINITY): number {
  let steps = 0
  while (table.isHandRunning() && steps < stopAfter) {
    const state = table.publicState()
    if (state.actingSeat === null) break
    const seat = state.seats.find((entry) => entry.seat === state.actingSeat)
    if (!seat) break
    const legal = table.legalActions(seat.playerId)
    const pick = legal.find((a) => a.action === 'check') ?? legal.find((a) => a.action === 'call') ?? legal[0]!
    table.act(seat.playerId, pick.action, pick.amount)
    steps += 1
  }
  return steps
}

function buildDeterministicTable(): HoldemTable {
  const table = makeTable([
    ['p1', 0, 2000],
    ['p2', 1, 2000],
    ['p3', 2, 2000],
  ])
  // 固定发牌顺序，保证两次构建拿到完全相同的一手牌；剩余牌补足 52 张（永不被发出）。
  const dealOrder = ['As', 'Kd', 'Qh', 'Ah', 'Ks', 'Qd', '2c', '3d', '4h', '5s', '6c', '7d', '8h']
  const used = new Set(dealOrder)
  const deck = deckFromDealOrder([...dealOrder, ...createDeck().filter((card) => !used.has(card))])
  assert.equal(deck.length, 52)
  table.startHand({ handId: 'h-restore', rng: seededRng(7), buttonSeat: 0, deck })
  return table
}

test('快照往返：中局序列化再恢复，状态逐字节一致且能继续打完同一结果', () => {
  const original = buildDeterministicTable()
  const playedBefore = playDeterministic(original, 3)
  assert.equal(playedBefore, 3, '应至少能连续行动 3 次')

  const snapshot = original.serialize()
  const restored = HoldemTable.restore(JSON.parse(JSON.stringify(snapshot)) as typeof snapshot)

  // 1) 往返后私有状态完全一致（含牌堆、底牌、行动游标）
  assert.deepEqual(restored.serialize(), snapshot, '序列化 → 恢复 → 再序列化 必须完全相同')

  // 2) 公开状态与本人合法动作一致
  assert.deepEqual(restored.publicState(), original.publicState())
  const actingSeat = original.publicState().actingSeat!
  const actingPlayerId = original.publicState().seats.find((s) => s.seat === actingSeat)!.playerId
  assert.deepEqual(restored.legalActions(actingPlayerId), original.legalActions(actingPlayerId))
  for (const playerId of ['p1', 'p2', 'p3']) {
    assert.deepEqual(restored.holeCardsOf(playerId), original.holeCardsOf(playerId), `${playerId} 底牌应一致`)
  }

  // 3) 两边用同一个确定性策略继续打，最终筹码与结算结果必须完全一致
  playDeterministic(original)
  playDeterministic(restored)
  assert.equal(restored.publicState().phase, 'settlement')
  assert.equal(original.publicState().phase, 'settlement')
  for (const playerId of ['p1', 'p2', 'p3']) {
    assert.equal(stackOf(restored, playerId), stackOf(original, playerId), `${playerId} 最终筹码应一致`)
  }
  assert.deepEqual(restored.publicState().result, original.publicState().result)
  assert.equal(restored.totalChips(), 6000, '恢复后继续打完仍须筹码守恒')
})

test('摊牌后的亮牌快照能恢复，且亮牌必须等于该玩家的底牌', () => {
  const table = makeTable([
    ['a', 0, 20],
    ['b', 1, 20],
  ])
  table.startHand({ handId: 'h-showdown-restore', rng: seededRng(2), buttonSeat: 0 })
  table.act('a', 'call')
  const snapshot = table.serialize()
  assert.equal(snapshot.phase, 'settlement')
  assert.deepEqual(HoldemTable.restore(snapshot).publicState(), table.publicState())

  const corrupted = structuredClone(snapshot)
  corrupted.seats[0]!.revealedCards = [...corrupted.seats[1]!.holeCards]
  assert.throws(() => HoldemTable.restore(corrupted), /快照亮牌与底牌不一致/)
})

test('结算前退出的玩家底牌仍计入私有快照的 52 张校验', () => {
  const table = makeTable([
    ['a', 0, 1000],
    ['b', 1, 1000],
    ['c', 2, 1000],
  ])
  table.startHand({ handId: 'h-removed-cards', rng: seededRng(4), buttonSeat: 0 })
  table.removePlayer('a')
  table.removePlayer('b')
  const snapshot = table.serialize()
  assert.equal(snapshot.phase, 'settlement')
  assert.equal(snapshot.removedHoleCards?.length, 4)
  assert.deepEqual(HoldemTable.restore(snapshot).publicState(), table.publicState())

  const corrupted = structuredClone(snapshot)
  corrupted.removedHoleCards!.pop()
  assert.throws(() => HoldemTable.restore(corrupted), /快照牌数不为 52/)
})

test('快照校验：损坏或版本不符的快照必须被拒绝，不能带病恢复', () => {
  const table = buildDeterministicTable()
  playDeterministic(table, 2)
  const good = table.serialize()

  assert.throws(
    () => HoldemTable.restore({ ...good, schemaVersion: 999 }),
    /快照版本不兼容/,
    '版本不符应拒绝',
  )
  assert.throws(
    () => HoldemTable.restore({ ...good, config: { ...good.config, smallBlind: 0 } }),
    /桌规不合法/,
    '非法桌规应拒绝',
  )
  assert.throws(
    () => HoldemTable.restore({ ...good, seats: good.seats.map((s, i) => (i === 0 ? { ...s, stack: -1 } : s)) }),
    /负筹码/,
    '负筹码应拒绝',
  )
  assert.throws(
    () =>
      HoldemTable.restore({
        ...good,
        board: [...good.board, good.deck[0]!],
      }),
    /快照公共牌数量异常|重复的牌|牌数不为 52/,
    '公共牌数量异常应拒绝',
  )
  // 把一张牌同时放进牌堆和公共牌，制造重复
  const duplicated = { ...good, deck: [...good.deck.slice(0, -1), good.board[0] ?? good.deck[0]!] }
  assert.throws(() => HoldemTable.restore(duplicated), /重复的牌|牌数不为 52/, '重复牌应拒绝')
  assert.throws(
    () => HoldemTable.restore({ ...good, seats: good.seats.map((s, i) => (i === 0 ? { ...s, folded: true, allIn: true } : s)) }),
    /同时标记弃牌与全下/,
    '弃牌与全下互斥',
  )
  assert.throws(
    () => HoldemTable.restore({ ...good, actingSeat: 99 }),
    /行动者不在待行动集合中/,
    '行动者非法应拒绝',
  )
})
