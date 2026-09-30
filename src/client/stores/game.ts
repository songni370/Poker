import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { GameStatePublic, HandResultPublic, LegalAction, PrivateSelfState, SeatPublic } from '../../shared/protocol.ts'
import { HAND_HISTORY_LIMIT } from '../../shared/protocol.ts'

/**
 * 牌局公共状态 + 本人私有状态。
 *
 * 唯一写入入口是 applySnapshot（第 3 阶段由 WebSocket 事件直接调用），
 * 组件只读取这里的数据，不维护任何第二份「筹码真相」。
 */
export const useGameStore = defineStore('game', () => {
  /** 服务端公共状态（已脱敏，绝不含他人未公开底牌）。 */
  const state = ref<GameStatePublic | null>(null)
  /** 只有本人底牌与合法动作。 */
  const self = ref<PrivateSelfState | null>(null)
  /** 本房最近的手牌结算（新→旧由展示层决定），重连时由服务端整体替换。 */
  const history = ref<HandResultPublic[]>([])

  /** 整体替换快照：重连、乱序、丢包都收敛到这一份服务端真相。 */
  function applySnapshot(next: GameStatePublic, nextSelf: PrivateSelfState): void {
    state.value = next
    self.value = nextSelf
  }

  /** 用服务端下发的历史整体替换（进入房间 / 重连）。 */
  function setHistory(next: readonly HandResultPublic[]): void {
    history.value = [...next]
  }

  /** 一手结算后追加，最多保留 HAND_HISTORY_LIMIT 条，且同一 handId 不重复。 */
  function appendHistory(result: HandResultPublic): void {
    if (history.value.some((entry) => entry.handId === result.handId)) return
    history.value = [...history.value, result].slice(-HAND_HISTORY_LIMIT)
  }

  function clear(): void {
    state.value = null
    self.value = null
    history.value = []
  }

  /* ───────────────── 便捷 getter ───────────────── */

  const seats = computed<readonly (SeatPublic | null)[]>(() => state.value?.seats ?? [])
  const board = computed(() => state.value?.board ?? [])
  const potTotal = computed(() => state.value?.potTotal ?? 0)

  /** 本人所在座位；未入座时为 null。 */
  const mySeat = computed<SeatPublic | null>(() => {
    const seat = self.value?.seat
    if (seat === null || seat === undefined) return null
    return state.value?.seats[seat] ?? null
  })

  /** 本人底牌；非本人牌局状态时为空数组。 */
  const myHoleCards = computed(() => self.value?.holeCards ?? [])

  /** 当前行动者座位；无人在行动时为 null。 */
  const actingSeat = computed<SeatPublic | null>(() => {
    const actingId = state.value?.actingPlayerId
    if (!actingId) return null
    return state.value?.seats.find((seat) => seat?.playerId === actingId) ?? null
  })

  /** 是否轮到本人行动。 */
  const isMyTurn = computed(() => {
    const actingId = state.value?.actingPlayerId
    return Boolean(actingId) && actingId === self.value?.playerId
  })

  /** 本人的合法动作（ActionBar 唯一依赖）。 */
  const myLegalActions = computed<LegalAction[]>(() => self.value?.legalActions ?? [])

  /** 是否已入座（用于区分观战者）。 */
  const isSeated = computed(() => (self.value?.seat ?? null) !== null)

  /** 正在参与当前手牌的玩家（含已全下、不含已弃牌）。 */
  const activeSeats = computed<SeatPublic[]>(() =>
    (state.value?.seats ?? []).filter((seat): seat is SeatPublic => Boolean(seat?.inHand && !seat.folded)),
  )

  return {
    state,
    self,
    history,
    applySnapshot,
    setHistory,
    appendHistory,
    clear,
    seats,
    board,
    potTotal,
    mySeat,
    myHoleCards,
    actingSeat,
    isMyTurn,
    myLegalActions,
    isSeated,
    activeSeats,
  }
})
