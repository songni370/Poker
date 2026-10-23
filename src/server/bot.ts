import type { ActionType, Card } from '../shared/poker.ts'
import type { LegalAction } from '../shared/protocol.ts'
import { evaluateHand } from '../engine/evaluate.ts'
import { HAND_CATEGORIES } from '../shared/poker.ts'

/**
 * 机器人决策：纯函数，不碰网络、不碰引擎状态，只根据「能看到的信息」决定打什么。
 *
 * 为什么单独一层：机器人最怕的是「偷偷用了对手底牌」——
 * 那会让它看起来很强，但实际是在作弊，也会让单机测试失去意义。
 * 所以这里只接受三类输入（自己的底牌、公共牌、合法动作），
 * 看不到任何别人的牌，从类型上就杜绝了。
 *
 * 策略刻意"像个新手"而不是最强 AI：目标是能陪你把整个流程跑通
 * （下注、加注、全下、弃牌、摊牌、结算），而不是赢你。
 */

/** 机器人性格：影响激进度，方便同一局里出现不同风格的对手。 */
export type BotStyle = 'tight' | 'loose' | 'balanced'

export interface BotDecisionInput {
  /** 自己的两张底牌。 */
  holeCards: readonly Card[]
  /** 公共牌（0/3/4/5 张）。 */
  board: readonly Card[]
  /** 服务端给出的合法动作（机器人只能从中挑一个）。 */
  legalActions: readonly LegalAction[]
  /** 自己的剩余筹码。 */
  stack: number
  /** 底池总额（含本轮所有下注）。 */
  potTotal: number
  /** 本轮需要跟注的金额（0 表示可以免费过牌）。 */
  callAmount: number
  /** 性格。 */
  style: BotStyle
  /** 随机源，注入以便单测可复现。 */
  random: () => number
}

export interface BotDecision {
  action: ActionType
  amount?: number
}

/**
 * 牌力分档：0（垃圾）到 1（怪兽）。
 *
 * 用引擎的 `evaluateHand` 拿到牌型，再按牌型类别给分——
 * 这比手写一堆 if 更可靠，也保证与最终结算用的是同一套判定。
 */
function handStrength(holeCards: readonly Card[], board: readonly Card[], random: () => number): number {
  const all = [...holeCards, ...board]
  if (holeCards.length < 2) return 0

  /*
   * 翻牌前没有五张牌，只能按底牌本身估。
   * 口袋对是最强的一类起手牌（AA 到 22 都该打得凶），所以给小口袋对也留足分量：
   * 对子基础 0.72，再按点数从 AA(+0.2) 线性降到 22(+0)。
   */
  if (all.length < 5) {
    const [a, b] = holeCards
    if (!a || !b) return 0
    if (a[0] === b[0]) return Math.min(1, 0.72 + (rankValue(a[0]) - 2) / 12 * 0.2)
    const high = Math.max(rankValue(a[0]), rankValue(b[0])) / 14
    const low = Math.min(rankValue(a[0]), rankValue(b[0])) / 14
    const suited = a[1] === b[1] ? 0.1 : 0
    // 两张高牌 + 同花加成；最大的垃圾牌（如 72o）约 0.2。
    return Math.min(0.65, high * 0.32 + low * 0.2 + suited)
  }

  const evaluated = evaluateHand(all)
  // 牌型类别转成 0–1：高牌最低、皇家同花顺最高。
  // category 是字符串（'high_card' | 'pair' | …），要查它的序号而不是直接算数。
  const index = botCategoryIndex(evaluated.category)
  const base = Math.min(1, (index + 1) / HAND_CATEGORIES.length)
  return Math.min(1, base + random() * 0.05)
}

/** 牌型名 → 强度序号（高牌 0、对子 1 ……）。 */
function botCategoryIndex(category: string): number {
  const index = HAND_CATEGORIES.indexOf(category as (typeof HAND_CATEGORIES)[number])
  return index < 0 ? 0 : index
}

/** 牌的 rank 字符转数值（用于翻牌前的粗略强度）。 */
function rankValue(rank: string): number {
  if (rank === 'A') return 14
  if (rank === 'K') return 13
  if (rank === 'Q') return 12
  if (rank === 'J') return 11
  if (rank === 'T') return 10
  return Number(rank)
}

/** 各性格的「加注阈值」与「跟注容忍度」。 */
const STYLE_PROFILE: Record<BotStyle, { raiseAt: number; callUntil: number; bluffChance: number }> = {
  // 紧凶：牌好才加注，牌差早弃。
  tight: { raiseAt: 0.62, callUntil: 0.3, bluffChance: 0.03 },
  // 松弱：什么牌都想跟一手，很少主动加注。
  loose: { raiseAt: 0.78, callUntil: 0.12, bluffChance: 0.02 },
  // 均衡：默认。
  balanced: { raiseAt: 0.7, callUntil: 0.22, bluffChance: 0.06 },
}

/**
 * 决定这一手打什么。
 *
 * 决策顺序：
 *   1. 手上有牌力（≥ raiseAt）→ 能加注就加注，否则跟注；
 *   2. 有一点点牌力（≥ callUntil）→ 免费就过牌，要付钱就跟注（但不超过筹码的 1/4）；
 *   3. 没牌力 → 免费就过牌；要付钱就弃牌（偶尔诈唬）。
 *
 * 全程只用 `legalActions` 里真实合法的动作，不会发出服务端会拒绝的命令。
 */
export function decideBotAction(input: BotDecisionInput): BotDecision {
  const { legalActions, style, random } = input
  const byAction = new Map<ActionType, LegalAction>(legalActions.map((entry) => [entry.action, entry]))

  const check = byAction.get('check')
  const call = byAction.get('call')
  const bet = byAction.get('bet')
  const raise = byAction.get('raise')
  const allIn = byAction.get('all_in')
  const fold = byAction.get('fold')

  const strength = handStrength(input.holeCards, input.board, random)
  const profile = STYLE_PROFILE[style]

  // 能加注时优先加注到「底池的一半」，但夹在 min/max 之间。
  const raiseTarget = (): number | undefined => {
    const sizing = bet ?? raise
    if (!sizing) return undefined
    const min = sizing.min ?? 0
    const max = sizing.max ?? input.stack
    const halfPot = Math.max(min, Math.round(input.potTotal / 2))
    return Math.min(max, Math.max(min, halfPot))
  }

  const raiseAction: BotDecision | null = (() => {
    const amount = raiseTarget()
    if (amount === undefined) return null
    return bet ? { action: 'bet', amount } : { action: 'raise', amount }
  })()

  // ① 强牌：加注；加不了就跟注 / 全下。
  if (strength >= profile.raiseAt) {
    if (raiseAction) return raiseAction
    if (call) return { action: 'call' }
    if (allIn) return { action: 'all_in' }
    if (check) return { action: 'check' }
  }

  // ② 中等牌力：免费就过牌；要付钱就跟注，但金额不超过筹码的 1/4（避免被大注绑住）。
  if (strength >= profile.callUntil) {
    if (check) return { action: 'check' }
    if (call) {
      const cost = call.amount ?? input.callAmount
      if (cost <= Math.max(0, input.stack) / 4 || cost === 0) return { action: 'call' }
    }
    if (fold) return { action: 'fold' }
  }

  // ③ 弱牌：免费过牌；否则弃牌，偶尔诈唬一下（守住「不会每手都弃」的真实感）。
  if (check) return { action: 'check' }
  if (raiseAction && random() < profile.bluffChance) return raiseAction
  if (fold) return { action: 'fold' }
  // 兜底：理论上不会走到这里（有下注时必然有 fold 或 call）。
  if (call) return { action: 'call' }
  return { action: 'check' }
}
