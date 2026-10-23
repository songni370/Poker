/**
 * 从「上一份快照」和「这份事件」推断该放哪些音效。
 *
 * 抽成纯函数的好处：对局音效的触发规则可以单测，不必起浏览器、不必有 Web Audio。
 * 服务端每次推送都带完整公共状态，所以音效本质上就是一次快照 diff：
 * 看这次推送相比上次多了什么（牌、下注、弃牌、结算…），就知道发生了什么。
 */

import type { GameStatePublic, PrivateSelfState, SeatPublic } from '../../shared/protocol.ts'

export type SoundCue =
  | { kind: 'deal'; count: number }
  | { kind: 'chips'; amount: number }
  | { kind: 'check' }
  | { kind: 'fold' }
  | { kind: 'yourTurn' }
  | { kind: 'win' }
  | { kind: 'ping' }

/** 一次音效判定需要的上下文。 */
export interface CueContext {
  /** 事件类型，如 hand.started / hand.settled。 */
  eventType: string
  /** 新到达的公共状态。 */
  next: GameStatePublic
  /** 本人私有状态。 */
  self: PrivateSelfState
  /** 处理前的公共状态；首次进入房间为 null。 */
  prev: GameStatePublic | null
  /** 处理前自己是否轮到行动。 */
  wasMyTurn: boolean
}

/**
 * 当前这份快照里所有「下一帧可能产生音效」的座位，带协议下标。
 *
 * 协议约定 `seats` 的下标就是座位号（空位为 null），
 * 所以比较前后两份快照一律按这个下标取，不能按 `seat.seat` 反查。
 */
function indexedSeats(state: GameStatePublic): { index: number; seat: SeatPublic }[] {
  const result: { index: number; seat: SeatPublic }[] = []
  state.seats.forEach((seat, index) => {
    if (seat) result.push({ index, seat })
  })
  return result
}

/**
 * 判定本次推送应播放的音效，按优先级从高到低返回。
 * 返回空数组表示这次推送没有需要发声的事。
 */
export function resolveCues(ctx: CueContext): SoundCue[] {
  const cues: SoundCue[] = []
  const { eventType, next, self, prev, wasMyTurn } = ctx

  // 首次进入房间（prev 为 null）：只补齐“轮到我”的提示，不补发历史动作的声音。
  const firstState = prev === null

  // 1. 轮到我行动：最高优先级。
  const actingId = next.actingPlayerId
  const isMyTurn = Boolean(actingId) && actingId === self.playerId
  if (isMyTurn && (!wasMyTurn || firstState)) cues.push({ kind: 'yourTurn' })

  // 2. 本手结算：赢了给赢家音，其余给普通提示。
  if (eventType === 'hand.settled' && next.lastResult) {
    const result = next.lastResult
    if (result.winners.some((winner) => winner.playerId === self.playerId)) cues.push({ kind: 'win' })
    else cues.push({ kind: 'ping' })
  }

  if (firstState || !prev) return cues

  // 3. 新发出的公共牌：数一下多出来的张数。
  if (next.board.length > prev.board.length) {
    cues.push({ kind: 'deal', count: next.board.length - prev.board.length })
  }

  // 4. 新一手的底牌：开局时给每个入座玩家发两张。
  if (eventType === 'hand.started' && next.handId !== prev.handId && self.holeCards.length > 0) {
    cues.push({ kind: 'deal', count: self.holeCards.length })
  }

  // 5. 下注动作：对比每个座位「本轮已投入」，增加最多的那位就是下注者。
  //
  // 注意盲注：开局那一刻两个盲位的 committedStreet 已经是大盲/小盲额，
  // 而上一份快照是「未开局」（全 0）。若直接相减，会把盲注当成一次下注，
  // 抢在跟注之前响一声筹码声。所以跨手时（handId 变了）或以未开局为基线时，
  // 盲注视为既有投入，不算「新增下注」。
  const handChanged = next.handId !== prev.handId
  let betIncrease = 0
  for (const { index, seat } of indexedSeats(next)) {
    if (!seat.inHand || seat.folded) continue
    const before = prev.seats[index]
    const wasInHand = Boolean(before && before.inHand)
    // 跨手：本手的投入不参与 diff（盲注是开局设定，不是玩家动作）。
    // 同手：只看本轮投入的增量。
    const delta = handChanged || !wasInHand ? 0 : seat.committedStreet - before!.committedStreet
    if (delta > betIncrease) betIncrease = delta
  }
  if (betIncrease > 0) cues.push({ kind: 'chips', amount: betIncrease })

  // 6. 过牌 / 弃牌判定。
  //
  // 不能只靠「行动权变了 + 街没变」：两人桌里大盲过牌会直接把牌推进翻牌，
  // 街变了但这是标准的过牌。改用两个更强的信号：
  //   a) 投入量不变（没人往底池加钱）→ 这一动不可能是下注；
  //   b) 行动者变了，或者街推进了 → 说明确实有人完成了动作。
  const foldedNow = next.seats.some((seat, index) => {
    if (!seat || !seat.folded) return false
    const before = prev.seats[index]
    return Boolean(before && before.inHand && !before.folded)
  })
  const actorChanged = next.actingPlayerId !== null && next.actingPlayerId !== prev.actingPlayerId
  const streetChanged = next.street !== prev.street
  const actedWithoutMoney = betIncrease === 0 && !handChanged && (actorChanged || streetChanged)

  if (foldedNow) cues.push({ kind: 'fold' })
  else if (actedWithoutMoney) cues.push({ kind: 'check' })

  return cues
}
