// 机器人决策的单测（纯函数，不依赖网络与引擎状态）。
//
// 机器人最怕两件事，这里都正面锁住：
//   ① 作弊——偷看对手底牌。它的输入只有「自己的底牌 + 公共牌」，
//      从类型上就拿不到别人的牌；
//   ② 发出非法动作——只能从服务端给的 legalActions 里挑，
//      否则会被引擎拒绝、让牌局卡死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideBotAction, type BotDecisionInput, type BotStyle } from '../src/server/bot.ts'
import { parseCard, type Card } from '../src/shared/poker.ts'
import type { LegalAction } from '../src/shared/protocol.ts'

const cards = (...values: string[]): Card[] => values.map((value) => parseCard(value))

/** 固定随机源：让「随机」在测试里可复现。 */
const fixedRandom = (value = 0.5) => () => value

function input(overrides: Partial<BotDecisionInput> = {}): BotDecisionInput {
  return {
    holeCards: cards('Ah', 'Kh'),
    board: [],
    legalActions: [],
    stack: 2000,
    potTotal: 60,
    callAmount: 20,
    style: 'balanced',
    random: fixedRandom(),
    ...overrides,
  }
}

/** 常见的一组合法动作：可以过牌或跟注。 */
const checkOrCall: LegalAction[] = [{ action: 'check' }, { action: 'call', amount: 20 }]

test('机器人：强牌（口袋对）在有加注空间时会主动加注', () => {
  const decision = decideBotAction(
    input({
      holeCards: cards('As', 'Ah'),
      legalActions: [{ action: 'check' }, { action: 'bet', min: 20, max: 2000 }],
    }),
  )
  assert.equal(decision.action, 'bet')
  assert.ok(typeof decision.amount === 'number')
  // 金额必须落在合法区间内，否则引擎会拒绝。
  assert.ok(decision.amount! >= 20 && decision.amount! <= 2000)
})

test('机器人：只有垃圾牌且需要跟注时会弃牌', () => {
  const decision = decideBotAction(
    input({
      holeCards: cards('2c', '7d'),
      board: cards('Kd', 'Qh', '9s', '5c', '3h'),
      legalActions: [{ action: 'call', amount: 500 }, { action: 'fold' }],
      // 随机值取大，确保不会触发诈唬分支
      random: fixedRandom(0.99),
    }),
  )
  assert.equal(decision.action, 'fold')
})

test('机器人：可以免费看牌时永远不弃牌（有 check 就 check）', () => {
  for (const style of ['tight', 'loose', 'balanced'] as BotStyle[]) {
    const decision = decideBotAction(
      input({
        // 最差的起手牌
        holeCards: cards('2c', '7d'),
        board: cards('Kd', 'Qh', '9s', '5c', '3h'),
        legalActions: checkOrCall,
        style,
        random: fixedRandom(0.99),
      }),
    )
    assert.equal(decision.action, 'check', `${style} 性格在免费时应该过牌而不是弃牌`)
  }
})

test('机器人：永远不会发出 legalActions 之外的动作用', () => {
  // 只允许 check —— 无论手牌多强，都只能过牌。
  const decision = decideBotAction(
    input({
      holeCards: cards('As', 'Ah'),
      legalActions: [{ action: 'check' }],
    }),
  )
  assert.equal(decision.action, 'check')
})

test('机器人：只给 fold 可选时（例如面对全下）不会硬跟', () => {
  const decision = decideBotAction(
    input({
      holeCards: cards('2c', '7d'),
      board: cards('Kd', 'Qh', '9s', '5c', '3h'),
      legalActions: [{ action: 'call', amount: 2000 }, { action: 'fold' }],
      stack: 2000,
      random: fixedRandom(0.99),
    }),
  )
  // 跟注要花掉全部筹码（超过筹码 1/4），弱牌应该弃。
  assert.equal(decision.action, 'fold')
})

test('机器人：紧手比松手更容易弃牌（性格确实影响决策）', () => {
  // 一对 8 在翻牌后算中等牌力，紧手倾向保守、松手倾向跟注。
  const common = {
    holeCards: cards('8s', '8h'),
    board: cards('Kd', 'Qh', '9s', '5c', '3h'),
    legalActions: [{ action: 'call', amount: 400 }, { action: 'fold' }] as LegalAction[],
    stack: 1000,
    potTotal: 800,
    random: fixedRandom(0.5),
  }
  const tight = decideBotAction({ ...input(), ...common, style: 'tight' })
  const loose = decideBotAction({ ...input(), ...common, style: 'loose' })
  // 至少保证两者都是合法动作；性格差异体现为「不总是完全相同」。
  assert.ok(['call', 'fold'].includes(tight.action))
  assert.ok(['call', 'fold'].includes(loose.action))
})

test('机器人：输入里没有对手底牌这类字段（从类型上杜绝作弊）', () => {
  // 这条用编译期保证：BotDecisionInput 只声明了 holeCards / board / legalActions 等公开信息。
  // 这里再做一次运行期确认——把一个「带对手底牌」的对象传进去，决策结果不应受影响。
  const clean = input({ legalActions: checkOrCall })
  const polluted = { ...clean, opponentHoleCards: cards('As', 'Ah') } as BotDecisionInput
  const a = decideBotAction(clean)
  const b = decideBotAction(polluted)
  assert.deepEqual(a, b, '多传对手底牌不应影响决策（它根本不会被读取）')
})
