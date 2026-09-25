// 牌桌界面用到的纯逻辑单测（不依赖浏览器）：
//   1) 底部「你的底牌」区的当前牌型文案 —— src/engine/evaluate.ts 的 describeHand；
//   2) 操作区快捷额度（1/2、2/3、满池、超池）的换算与夹取 —— action-bar-sizing.ts；
//   3) 邀请面板的复制退路 —— clipboard.ts（局域网 http 明文下没有 navigator.clipboard）。
//
// 这几块共同点：界面上的数字/文案必须与服务端裁定一致，不能只靠目测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeHand, evaluateHand } from '../src/engine/evaluate.ts'
import { clampAmount, quickSizes } from '../src/client/components/action-bar-sizing.ts'
import { copyText } from '../src/client/components/clipboard.ts'
import { parseCard, type Card } from '../src/shared/poker.ts'

const cards = (...values: string[]): Card[] => values.map((value) => parseCard(value))

/* ───────────── 当前牌型文案（底部「你的底牌」区） ───────────── */

test('牌型文案：翻牌前只有两张底牌也给结论（一对 / 高牌）', () => {
  assert.equal(describeHand(cards('Qs', 'Qh')), '一对 Q')
  assert.equal(describeHand(cards('As', '7h')), '高牌 A')
  // 高牌与传参顺序无关：关键牌取较大的那张。
  assert.equal(describeHand(cards('7h', 'As')), '高牌 A')
  assert.equal(describeHand(cards('2c', '3d')), '高牌 3')
})

test('牌型文案：翻牌成对 → 一对，转牌两对 → 两对', () => {
  // 翻牌（底牌 2 张 + 公共牌 3 张）：A A 成对，踢脚 K/7/2。
  assert.equal(describeHand(cards('As', 'Kd', 'Ah', '7c', '2s')), '一对 A')
  // 转牌（6 张）：A 与 K 各成对。
  assert.equal(describeHand(cards('As', 'Kd', 'Ah', 'Kc', '7c', '2s')), '两对（A 与 K）')
})

test('牌型文案：河牌同花与顺子', () => {
  // 7 张全是红桃里最大的五张：A K Q J 9。
  assert.equal(describeHand(cards('Ah', 'Kh', 'Qh', 'Jh', '9h', '2c', '3d')), '同花（A K Q J 9）')
  // 9-8-7-6-5 顺子，关键牌是 9。
  assert.equal(describeHand(cards('9s', '8d', '7h', '6c', '5s', 'Kd', '2d')), '顺子（9 高）')
})

test('牌型文案：公共牌比底牌大时取公共牌（底牌 2/3 + A A A K K = 葫芦 A 带 K）', () => {
  const name = describeHand(cards('2s', '3d', 'Ah', 'Ad', 'Ac', 'Kh', 'Kd'))
  assert.equal(name, '葫芦（A 带 K）')
  // 反向对照：不能给出「两对」这种只看底牌+公共牌配对的错结论。
  assert.notEqual(name, '两对（A 与 K）')
})

test('牌型文案：5 张以上与结算叠层完全同源（等价于 evaluateHand().name）', () => {
  const seven = cards('Ah', 'Kh', 'Qh', 'Jh', '9h', '2c', '3d')
  assert.equal(describeHand(seven), evaluateHand(seven).name)
  const six = cards('As', 'Kd', 'Ah', 'Kc', '7c', '2s')
  assert.equal(describeHand(six), evaluateHand(six).name)
})

test('牌型文案：公共牌每翻一段都跟着更新（翻牌前 → 翻牌 → 转牌 → 河牌）', () => {
  // 界面上的算法就是「本人底牌 + 已翻出的公共牌」，所以这里按四条街依次拼牌验证。
  // 牌例：A♥ K♥ + Q♥ 7♣ 2♦ →（转牌）J♥ →（河牌）T♥，一路从高牌升级到同花顺。
  const hole = cards('Ah', 'Kh')
  assert.equal(describeHand([...hole, ...cards('Qh', '7c', '2d')]), '高牌（A K Q 7 2）')
  assert.equal(describeHand([...hole, ...cards('Qh', '7c', '2d', 'Jh')]), '高牌（A K Q J 7）')
  assert.equal(describeHand([...hole, ...cards('Qh', '7c', '2d', 'Jh', 'Th')]), '同花顺（A 高）')
})

test('牌型文案：凑不出牌型时返回空串，由界面自己决定占位文案', () => {
  assert.equal(describeHand([]), '')
  assert.equal(describeHand(cards('As')), '')
  // 3–4 张（例如本人不在本手时的公共牌）不足以判定，同样返回空串。
  assert.equal(describeHand(cards('As', 'Kd', 'Qh')), '')
})

/* ───────────── 快捷额度（操作区） ───────────── */

test('快捷额度：1/2、2/3、满池、超池按跟注后的底池折算', () => {
  // 翻牌圈无人下注（callAmount = 0）、底池 100 → 50 / 67 / 100 / 150。
  const list = quickSizes({ min: 20, max: 2000, potTotal: 100, callAmount: 0, action: 'bet' })
  assert.deepEqual(list.map((q) => q.label), ['1/2', '2/3', 'POT', 'OVERBET'])
  assert.deepEqual(list.map((q) => q.value), [50, 67, 100, 150])
  assert.deepEqual(list.map((q) => q.disabled), [false, false, false, false])
})

test('快捷额度：按钮主文本是官方英文、中文只是小字辅助', () => {
  const list = quickSizes({ min: 20, max: 2000, potTotal: 100, callAmount: 0, action: 'bet' })
  assert.deepEqual(list.map((q) => q.en), ['1/2 POT', '2/3 POT', 'POT', 'OVERBET'])
  assert.deepEqual(list.map((q) => q.zh), ['半池', '2/3 池', '满池', '超池'])
  // 无障碍说法里必须同时有中文描述与下注额，读屏用户不依赖英文缩写。
  for (const q of list) {
    assert.match(q.desc, /底池/)
    assert.ok(!q.disabled)
  }
})

test('快捷额度：加注按「跟注后的底池」折算（amount 是目标总额而不是增量）', () => {
  // 底池 120、需跟注 40 → 跟注后 160：40 + 80/107/160/240。
  const list = quickSizes({ min: 80, max: 2000, potTotal: 120, callAmount: 40, action: 'raise' })
  assert.deepEqual(list.map((q) => q.value), [120, 147, 200, 280])
})

test('快捷额度：理想值越界时禁用并说明原因，按钮上的数值仍落在合法区间内', () => {
  // 上限一侧：底池 100、上限 120 → 超池（150）越界。
  const capped = quickSizes({ min: 20, max: 120, potTotal: 100, callAmount: 0, action: 'bet' })
  const over = capped.find((q) => q.key === 'over')!
  assert.equal(over.disabled, true)
  assert.match(over.title, /超过上限 120/)
  // 夹到上限：即使禁用着，按钮上写的数也一定是服务端会接受的数。
  assert.equal(over.value, 120)

  // 下限一侧：底池很小而最小加注很高 → 1/2 底池低于下限，不能悄悄改成小注。
  const floored = quickSizes({ min: 2000, max: 4000, potTotal: 30, callAmount: 20, action: 'raise' })
  const half = floored.find((q) => q.key === 'half')!
  assert.equal(half.disabled, true)
  assert.match(half.title, /低于最小加注 2000/)
  assert.equal(half.value, 2000)

  for (const q of capped) {
    assert.ok(Number.isInteger(q.value), `${q.label} 的额度必须是整数`)
    assert.ok(q.value >= 20 && q.value <= 120, `${q.label} 的额度必须落在 20–120`)
  }
  for (const q of floored) {
    assert.ok(Number.isInteger(q.value), `${q.label} 的额度必须是整数`)
    assert.ok(q.value >= 2000 && q.value <= 4000, `${q.label} 的额度必须落在 2000–4000`)
  }
})

test('快捷额度：区间再窄四个档位也不合并（禁用而不是删掉）', () => {
  const list = quickSizes({ min: 100, max: 100, potTotal: 40, callAmount: 0, action: 'bet' })
  assert.deepEqual(list.map((q) => q.label), ['1/2', '2/3', 'POT', 'OVERBET'])
  for (const q of list) {
    assert.equal(q.value, 100)
    assert.equal(q.disabled, true)
  }
})

test('快捷额度：取整与边界只有一套实现（clampAmount）', () => {
  assert.equal(clampAmount(104.6, 20, 2000), 105)
  assert.equal(clampAmount(5, 20, 2000), 20)
  assert.equal(clampAmount(99999, 20, 2000), 2000)
})

/* ───────────── 邀请面板的复制（src/client/components/clipboard.ts） ───────────── */

test('复制：拿到剪贴板就写进去，文本原样不加工', async () => {
  const written: string[] = []
  const result = await copyText('http://192.168.1.5:3000/table/482913', {
    writeText: (text: string) => {
      written.push(text)
      return Promise.resolve()
    },
  })
  assert.equal(result, 'copied')
  assert.deepEqual(written, ['http://192.168.1.5:3000/table/482913'])
})

test('复制：没有剪贴板 API（局域网 http 明文）返回 manual，让界面走「已选中，按 Ctrl/⌘+C」', async () => {
  // 非安全上下文下 navigator.clipboard 是 undefined，硬调会抛错、按钮看起来没反应。
  assert.equal(await copyText('482913', undefined), 'manual')
})

test('复制：权限被拒（writeText 抛错）也算 manual，不能把异常抛到界面上', async () => {
  const result = await copyText('482913', {
    writeText: () => Promise.reject(new Error('NotAllowedError')),
  })
  assert.equal(result, 'manual')
})
