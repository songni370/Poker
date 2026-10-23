import type { Card } from '../../shared/poker.ts'
import type { HandResultPublic } from '../../shared/protocol.ts'

/** 摊牌开牌玩家的展示模型（已按「赢家 → 本人 → 其他」排好序）。 */
export interface HistoryRevealedPlayer {
  playerId: string
  nickname: string
  isHero: boolean
  isWinner: boolean
  winAmount: number
  cards: Card[]
  handName: string
}

/** 一条手牌历史在界面上的展示模型。 */
export interface HistoryRow {
  entry: HandResultPublic
  handNo: number
  potTotal: number
  board: readonly Card[]
  showdown: boolean
  heroWon: boolean
  heroWonAmount: number
  heroShowdown: boolean
  winners: { playerId: string; nickname: string; isHero: boolean; amount: number }[]
  revealedPlayers: HistoryRevealedPlayer[]
}

/**
 * 把服务端下发的历史（旧 → 新）转成展示模型（最新在最前）。
 *
 * 抽成纯函数：不依赖组件状态，便于单测与在多个面板复用（HUD 历史、结算叠层）。
 */
export function buildHistoryRows(
  history: readonly HandResultPublic[],
  options: {
    heroPlayerId: string | null | undefined
    nicknameOf: (playerId: string) => string
  },
): HistoryRow[] {
  const myId = options.heroPlayerId ?? null
  return [...history].reverse().map((entry) => {
    const winners = entry.winners.map((winner: { playerId: string; amount: number }) => ({
      ...winner,
      nickname: options.nicknameOf(winner.playerId),
      isHero: winner.playerId === myId,
    }))

    const heroWinner = winners.find((winner) => winner.isHero)
    const heroWon = Boolean(heroWinner && heroWinner.amount > 0)
    const heroWonAmount = heroWinner ? heroWinner.amount : 0

    // 整合所有在摊牌阶段亮牌的玩家（包含自己和对手）
    const revealedPlayers: HistoryRevealedPlayer[] = (entry.revealed ?? []).map(
      (rev: { playerId: string; cards: Card[]; handName: string }) => {
      const winnerMatch = winners.find((winner) => winner.playerId === rev.playerId)
      return {
        playerId: rev.playerId,
        nickname: options.nicknameOf(rev.playerId),
        isHero: rev.playerId === myId,
        isWinner: Boolean(winnerMatch && winnerMatch.amount > 0),
        winAmount: winnerMatch ? winnerMatch.amount : 0,
        cards: rev.cards ?? [],
        handName: rev.handName,
      }
      },
    )

    // 排序：赢家在最前，其次是本人（若参与了比牌），随后是其他比牌选手
    revealedPlayers.sort((a, b) => {
      if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1
      if (a.isHero !== b.isHero) return a.isHero ? -1 : 1
      return 0
    })

    return {
      entry,
      handNo: entry.handNo,
      potTotal: entry.potTotal,
      board: entry.board ?? [],
      showdown: entry.showdown,
      heroWon,
      heroWonAmount,
      heroShowdown: revealedPlayers.some((player) => player.isHero),
      winners,
      revealedPlayers,
    }
  })
}
