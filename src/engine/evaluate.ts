import { HAND_CATEGORIES, RANKS, RANK_LABEL, rankValue, type Card, type HandCategory, type Rank } from '../shared/poker.ts'

export interface HandValue {
  category: HandCategory
  /** 同牌型比较用的关键点数，降序。 */
  tiebreak: number[]
  /** 参与比较的最佳五张（展示用）。 */
  bestFive: Card[]
  /** 形如「葫芦（K 带 7）」的中文描述。 */
  name: string
}

const CATEGORY_INDEX: Record<HandCategory, number> = Object.fromEntries(
  HAND_CATEGORIES.map((category, index) => [category, index]),
) as Record<HandCategory, number>

interface Combo5 {
  category: HandCategory
  tiebreak: number[]
}

function evaluate5(cards: readonly Card[]): Combo5 {
  const values = cards.map((card) => rankValue(card[0] as Rank)).sort((a, b) => b - a)
  const isFlush = cards.every((card) => card[1] === cards[0]![1])

  const counts = new Map<number, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  // 先按出现次数、再按点数降序：两对/葫芦/四条的分组顺序都由它决定。
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const distinct = [...counts.keys()].sort((a, b) => b - a)

  let straightHigh = 0
  if (distinct.length === 5) {
    if (distinct[0]! - distinct[4]! === 4) straightHigh = distinct[0]!
    // A-2-3-4-5：A 作 1，且不允许 Q-K-A-2-3 这类循环顺。
    else if (distinct[0] === 14 && distinct[1] === 5) straightHigh = 5
  }

  if (isFlush && straightHigh) return { category: 'straight_flush', tiebreak: [straightHigh] }
  if (groups[0]![1] === 4) return { category: 'quads', tiebreak: [groups[0]![0], groups[1]![0]] }
  if (groups[0]![1] === 3 && groups[1]?.[1] === 2) {
    return { category: 'full_house', tiebreak: [groups[0]![0], groups[1]![0]] }
  }
  if (isFlush) return { category: 'flush', tiebreak: values }
  if (straightHigh) return { category: 'straight', tiebreak: [straightHigh] }
  if (groups[0]![1] === 3) {
    return { category: 'trips', tiebreak: [groups[0]![0], groups[1]![0], groups[2]![0]] }
  }
  if (groups[0]![1] === 2 && groups[1]?.[1] === 2) {
    return { category: 'two_pair', tiebreak: [groups[0]![0], groups[1]![0], groups[2]![0]] }
  }
  if (groups[0]![1] === 2) {
    return { category: 'pair', tiebreak: [groups[0]![0], groups[1]![0], groups[2]![0], groups[3]![0]] }
  }
  return { category: 'high_card', tiebreak: values }
}

/** 比较两个牌型：> 0 表示 a 更强。 */
export function compareHands(a: Combo5, b: Combo5): number {
  const byCategory = CATEGORY_INDEX[a.category] - CATEGORY_INDEX[b.category]
  if (byCategory !== 0) return byCategory
  for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i++) {
    const diff = (a.tiebreak[i] ?? 0) - (b.tiebreak[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function combinations<T>(items: readonly T[], pick: number): T[][] {
  const result: T[][] = []
  const current: T[] = []
  const walk = (start: number): void => {
    if (current.length === pick) {
      result.push(current.slice())
      return
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]!)
      walk(i + 1)
      current.pop()
    }
  }
  walk(0)
  return result
}

function describe(value: Combo5): string {
  const base: Record<HandCategory, string> = {
    high_card: '高牌',
    pair: '一对',
    two_pair: '两对',
    trips: '三条',
    straight: '顺子',
    flush: '同花',
    full_house: '葫芦',
    quads: '四条',
    straight_flush: '同花顺',
  }
  const label = (value: number): string => {
    const rank = RANKS[value - 2]
    return rank ? RANK_LABEL[rank] : String(value)
  }
  switch (value.category) {
    case 'quads':
      return `四条 ${label(value.tiebreak[0]!)}`
    case 'full_house':
      return `葫芦（${label(value.tiebreak[0]!)} 带 ${label(value.tiebreak[1]!)}）`
    case 'flush':
    case 'high_card':
      return `${base[value.category]}（${value.tiebreak.slice(0, 5).map(label).join(' ')}）`
    case 'straight':
    case 'straight_flush':
      return `${base[value.category]}（${label(value.tiebreak[0]!)} 高）`
    case 'trips':
      return `三条 ${label(value.tiebreak[0]!)}`
    case 'two_pair':
      return `两对（${label(value.tiebreak[0]!)} 与 ${label(value.tiebreak[1]!)}）`
    case 'pair':
      return `一对 ${label(value.tiebreak[0]!)}`
  }
}

/**
 * 取 5–7 张牌中的最大牌型。
 * 7 张时枚举 C(7,5)=21 种组合逐一比较——21 次足够快，且无需维护查表器。
 */
export function evaluateHand(cards: readonly Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluateHand 需要 5–7 张牌，收到 ${cards.length} 张`)
  }
  let best: Combo5 | null = null
  let bestFive: Card[] = []
  for (const combo of combinations(cards, 5)) {
    const value = evaluate5(combo)
    if (!best || compareHands(value, best) > 0) {
      best = value
      bestFive = combo
    }
  }
  const chosen = best!
  return { category: chosen.category, tiebreak: chosen.tiebreak, bestFive, name: describe(chosen) }
}
