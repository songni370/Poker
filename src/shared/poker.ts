/**
 * 扑克基础类型与显示文案（客户端与服务端共用）。
 * 筹码一律为整数 chips，虚拟且不可兑换。
 */

export const SUITS = ['s', 'h', 'd', 'c'] as const
export type Suit = (typeof SUITS)[number]

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const
export type Rank = (typeof RANKS)[number]

/** 牌用两字符表示：A♠ = 'As'、10♦ = 'Td'。 */
export type Card = `${Rank}${Suit}`

export const SUIT_SYMBOL: Record<Suit, string> = { s: '♠', h: '♥', d: '♦', c: '♣' }
export const SUIT_NAME: Record<Suit, string> = { s: '黑桃', h: '红桃', d: '方块', c: '梅花' }
export const RANK_LABEL: Record<Rank, string> = {
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  T: '10',
  J: 'J',
  Q: 'Q',
  K: 'K',
  A: 'A',
}

/** 2 → 2 … A → 14；A 亦可作 1 用于 A-2-3-4-5（不循环）。 */
export function rankValue(rank: Rank): number {
  return RANKS.indexOf(rank) + 2
}

export function isRedSuit(suit: Suit): boolean {
  return suit === 'h' || suit === 'd'
}

export function parseCard(value: string): Card {
  const rank = value[0] as Rank
  const suit = value[1] as Suit
  if (!RANKS.includes(rank) || !SUITS.includes(suit)) throw new Error(`非法牌面：${value}`)
  return `${rank}${suit}` as Card
}

export function isCard(value: unknown): value is Card {
  return typeof value === 'string' && value.length === 2 && isParsedCard(value)
}

function isParsedCard(value: string): boolean {
  return (RANKS as readonly string[]).includes(value[0]!) && (SUITS as readonly string[]).includes(value[1]!)
}

export function formatCard(card: Card): string {
  const rank = card[0] as Rank
  const suit = card[1] as Suit
  return `${RANK_LABEL[rank]}${SUIT_SYMBOL[suit]}`
}

/** 牌型由弱到强；索引即强度，可直接比较。 */
export const HAND_CATEGORIES = [
  'high_card',
  'pair',
  'two_pair',
  'trips',
  'straight',
  'flush',
  'full_house',
  'quads',
  'straight_flush',
] as const
export type HandCategory = (typeof HAND_CATEGORIES)[number]

export const HAND_CATEGORY_NAMES: Record<HandCategory, string> = {
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

/** 底牌/公共牌的公开描述（不含任何未公开信息）。 */
export type Street = 'preflop' | 'flop' | 'turn' | 'river'
export const STREET_NAMES: Record<Street, string> = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
}

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in'
export const ACTION_NAMES: Record<ActionType, string> = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  bet: '下注',
  raise: '加注',
  all_in: '全下',
}

/** 默认桌规与房主可设置的金额上限。 */
export const TABLE_RULES = {
  minSeats: 2,
  maxSeats: 9,
  /**
   * 起始筹码 = 房主设定的「初始筹码」默认值。
   * 每个玩家落座时的买入额由自己选，范围是 [初始筹码, 买入上限]：
   *   - `startingStack`（初始筹码，默认 2000）：上桌最低要买入多少；
   *   - `maxBuyInDefault`（买入上限，默认 5000）：一次最多能带多少上桌。
   * 两者都由房主在创建房间时设定，服务端只做区间收敛与步进取整。
   */
  startingStack: 2000,
  /** 默认买入上限（用户指定默认 5000）。 */
  maxBuyInDefault: 5000,
  smallBlind: 10,
  bigBlind: 20,
  /** 保证 10 个大盲的最低买入仍可落在买入上限内。 */
  maxBigBlind: 1000,
  turnSeconds: 30,
  minTurnSeconds: 30,
  maxTurnSeconds: 300,
  /** 0 保持房主手动开下一手；正数表示结算后的自动开局间隔。 */
  nextHandSeconds: 5,
  maxNextHandSeconds: 120,
  /** 房主可选买入区间的允许范围；步进等于小盲。 */
  minBuyInFloor: 200,
  maxBuyInLimit: 20000,
} as const

/**
 * 把买入额夹到本桌允许的范围并按小盲取整。
 * 区间由房间配置给出（房主设定的「初始筹码 ~ 买入上限」），不再写死「10 个大盲」。
 */
export function normalizeBuyIn(amount: number, minBuyIn: number, maxBuyIn: number, smallBlind: number): number {
  const min = Math.min(minBuyIn, maxBuyIn)
  const max = Math.max(minBuyIn, maxBuyIn)
  const first = Math.ceil(min / smallBlind) * smallBlind
  const last = Math.floor(max / smallBlind) * smallBlind
  if (first > last) throw new RangeError('买入范围内没有符合小盲步进的金额')
  return Math.max(first, Math.min(last, Math.round(amount / smallBlind) * smallBlind))
}

export const ROOM_NAME_MAX = 24
export const NICKNAME_MAX = 12

/** 房间号位数：纯数字（首位非 0），方便口头传达与手工输入。 */
export const ROOM_ID_DIGITS = 6
export const ROOM_PASSWORD_DIGITS = 6
