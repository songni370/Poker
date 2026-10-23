import { computed, ref, watch } from 'vue'
import type { Card, HandResultPublic } from '../../shared/protocol.ts'

/**
 * 结算叠层：何时弹、何时不弹、以及「本人本手底牌」的保底回溯。
 *
 * 从 `TableView.vue` 抽出。这块看起来简单，但踩过两个真实坑，注释保留在代码里：
 *
 *   1. **watch getter 必须返回原始值**。返回数组/对象时每次求值都是新引用，
 *      `Object.is` 永不相等 —— 任何状态广播（别人加入、断线、重连）都会重跑回调，
 *      于是「结算已确认」被重置、叠层在全桌重新弹出。
 *   2. **刷新后不该再弹**已确认的那一手。用 sessionStorage 按房间记 handId。
 */
export interface HandResultOptions {
  /** 房间号（sessionStorage key 用）。 */
  roomId: () => string
  /** 当前牌局最后一手结算（无则 null）。 */
  lastResult: () => HandResultPublic | null | undefined
  /** 手局号。 */
  handNo: () => number | undefined
  /** 阶段。 */
  phase: () => string | undefined
  /** 本人当前底牌（局末可能被清空）。 */
  heroCards: () => readonly Card[]
}

const RESULT_SEEN_KEY = 'poker.resultSeen'

function seenKey(roomId: string): string {
  return `${RESULT_SEEN_KEY}:${roomId}`
}

export function useHandResult(options: HandResultOptions) {
  const resultDismissed = ref(false)

  const result = computed(() => options.lastResult() ?? null)

  /**
   * 已经确认过的结算手牌（handId），按房间存在 sessionStorage。
   * 刷新页面时不会为「自己已经点过知道了」的那一手再弹一次结算。
   */
  const seenResultHandId = ref<string | null>(sessionStorage.getItem(seenKey(options.roomId())))

  /* ───────────── 本人本手底牌保底 ───────────── */

  /**
   * 牌局结束时服务端可能已清空本人底牌，而结算叠层还要显示「你的手牌」。
   * 这里缓存最后一次非空的底牌，给结算用。
   */
  const savedHeroCards = ref<readonly Card[]>([])
  watch(
    () => options.heroCards(),
    (cards) => {
      if (cards && cards.length > 0) savedHeroCards.value = [...cards]
    },
    { immediate: true },
  )

  /** 结算叠层要显示的本人底牌：优先当前值，局末回退到缓存。 */
  const activeHeroCards = computed<readonly Card[]>(() => {
    const current = options.heroCards()
    return current.length > 0 ? current : savedHeroCards.value
  })

  /* ───────────── 何时弹 ───────────── */

  /**
   * 【坑】getter 必须返回字符串这类原始值，不能返回数组。
   * 返回数组时每次求值都是新数组，`Object.is` 永不相等 —— 于是任何状态广播
   * （别人加入、断线、重连、甚至超时提示）都会重跑回调：
   * 结算被标记成「未确认」、叠层重新弹出。实测：一个人刷新页面，全桌都再弹一次。
   */
  /*
   * 结算改为**完全在牌桌上表达**：赢家的座位上出现王冠 + 赢得金额 + 金币特效
   * （见 PlayerSeat 的 .win-badge）。不再弹窗的理由：
   *   · 弹窗挡住牌桌，玩家想看的「谁还有牌、亮的是什么」正好被盖住；
   *   · 必须先手动关掉才能开下一手，打断节奏；
   *   · 「谁赢了多少」本来就是牌桌上最该直接看到的信息。
   *
   * overlayVisible 保留（恒为 false）是为了以后想恢复弹窗时不必推翻整个 composable。
   */
  const overlayVisible = ref(false)

  /** 用户点了「知道了」：记下这一手，刷新后不再弹。 */
  function closeResult(): void {
    resultDismissed.value = true
    overlayVisible.value = false
    const handId = result.value?.handId ?? null
    if (!handId) return
    seenResultHandId.value = handId
    try {
      sessionStorage.setItem(seenKey(options.roomId()), handId)
    } catch {
      // 隐私模式等场景下写不了 sessionStorage：只是刷新后会再弹一次，不影响牌局。
    }
  }

  return {
    result,
    overlayVisible,
    activeHeroCards,
    closeResult,
  }
}
