import { compareHands, type HandValue } from './evaluate.ts'

export interface SidePot {
  amount: number
  /** 有资格争夺该池的玩家（已弃牌者不在其中）。 */
  eligible: string[]
}

export interface Contribution {
  playerId: string
  amount: number
  folded: boolean
}

/**
 * 按投入额分层构建主池与边池。
 * 弃牌玩家已投入的筹码仍留在池中，但失去争夺资格；
 * 超出其他人之和的「未被跟注部分」会自然形成只含该玩家的池，等于自动退回。
 */
export function buildPots(contributions: readonly Contribution[]): SidePot[] {
  const levels = [...new Set(contributions.filter((c) => c.amount > 0).map((c) => c.amount))].sort((a, b) => a - b)
  const pots: SidePot[] = []
  let previous = 0

  for (const level of levels) {
    let amount = 0
    const eligible: string[] = []
    for (const contribution of contributions) {
      amount += Math.max(0, Math.min(contribution.amount, level) - previous)
      if (!contribution.folded && contribution.amount >= level) eligible.push(contribution.playerId)
    }
    previous = level
    if (amount > 0) pots.push({ amount, eligible })
  }

  return pots
}

export interface Award {
  playerId: string
  amount: number
  potIndex: number
  hand: HandValue | null
}

/**
 * 分配每个池：合格玩家中牌型最大者平分；除不尽的余数按固定规则
 * （庄家左手第一位优先）逐枚发放，保证筹码守恒。
 */
export function awardPots(
  pots: readonly SidePot[],
  rankOf: (playerId: string) => HandValue | null,
  orderFromButton: readonly string[],
): Award[] {
  const awards: Award[] = []

  pots.forEach((pot, potIndex) => {
    const live = pot.eligible
      .map((playerId) => ({ playerId, hand: rankOf(playerId) }))
      .filter((entry): entry is { playerId: string; hand: HandValue } => entry.hand !== null)

    if (live.length === 0) {
      // 安全网：理论上不会发生（最高投入者不可能已弃牌）。宁可退回也不让筹码消失。
      const fallback = pot.eligible.find((id) => orderFromButton.includes(id)) ?? pot.eligible[0]
      if (fallback) awards.push({ playerId: fallback, amount: pot.amount, potIndex, hand: null })
      return
    }

    let best = live[0]!
    for (const entry of live) {
      if (compareHands(entry.hand, best.hand) > 0) best = entry
    }
    const winners = live.filter((entry) => compareHands(entry.hand, best.hand) === 0)
    const share = Math.floor(pot.amount / winners.length)
    let remainder = pot.amount - share * winners.length

    const ordered = orderFromButton.filter((id) => winners.some((w) => w.playerId === id))
    for (const playerId of ordered) {
      const extra = remainder > 0 ? 1 : 0
      remainder -= extra
      awards.push({ playerId, amount: share + extra, potIndex, hand: best.hand })
    }
  })

  return awards
}
