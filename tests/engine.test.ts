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
  assert.equal(p1Actions.find((action) => action.action === 'call')!.amount, 10, 'p1 仍需补齐 10')

  table.act('p1', 'call')
  table.act('p2', 'call')
  const flop = table.publicState()
  assert.equal(flop.street, 'flop')
  assert.equal(flop.potTotal, 440, '四人各投入 110')
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
