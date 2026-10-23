import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { TABLE_RULES } from '../../shared/poker.ts'

/**
 * 牌桌倒计时：行动倒计时 + 下一手自动开始倒计时。
 *
 * 从 `TableView.vue` 抽出。设计要点：
 *   - **以服务端截止时间为准**（`turnDeadlineAt` / `nextHandDeadlineAt`），
 *     本地只做「现在离截止还有多久」的换算，再用 `clockOffsetMs` 校正机器时钟偏差；
 *   - 用 `requestAnimationFrame` 驱动，但**只在数值真的变化时**才写 ref
 *     （秒数变了才更新，进度条按 1/200 桶量化），避免每帧触发重渲染；
 *   - 没有截止时间时立刻停掉 rAF，不空转。
 */
export interface TurnTimerOptions {
  /** 行动截止时间戳（服务端毫秒，null = 当前没人需要行动）。 */
  turnDeadlineAt: () => number | null | undefined
  /** 下一手自动开始的截止时间戳（结算阶段才可能非空）。 */
  nextHandDeadlineAt: () => number | null | undefined
  /** 服务端给的每手行动时长（秒）；缺省用桌规默认值。 */
  turnSeconds: () => number | undefined
  /** 客户端与服务端的时钟偏差（毫秒），由握手时测量。 */
  clockOffsetMs: () => number
  /** 当前是否处于结算阶段（决定「下一手」提示是否显示）。 */
  isSettlement: () => boolean
}

export function useTurnTimer(options: TurnTimerOptions) {
  /** 剩余行动秒数（向上取整，0 表示没有倒计时）。 */
  const remainingSeconds = ref(0)
  /** 剩余比例 0–1，给进度条用。 */
  const remainingRatio = ref(1)
  /** 下一手自动开始还剩几秒。 */
  const nextHandRemainingSeconds = ref(0)

  const turnSeconds = computed(() => options.turnSeconds() ?? TABLE_RULES.turnSeconds)

  /** 结算阶段且有下一手截止时间时才显示倒计时。 */
  const nextHandCountdownVisible = computed(
    () => options.isSettlement() && (options.nextHandDeadlineAt() ?? null) !== null,
  )

  let rafId = 0
  let lastUpdateSec = -1
  let lastUpdateRatioBucket = -1

  function stop(): void {
    cancelAnimationFrame(rafId)
    rafId = 0
  }

  function reset(): void {
    lastUpdateSec = -1
    lastUpdateRatioBucket = -1
    remainingSeconds.value = 0
    remainingRatio.value = 0
    nextHandRemainingSeconds.value = 0
  }

  function tick(): void {
    const deadline = options.turnDeadlineAt() ?? null
    const nextHandDeadline = options.nextHandDeadlineAt() ?? null

    if (deadline === null && nextHandDeadline === null) {
      if (remainingSeconds.value !== 0) remainingSeconds.value = 0
      if (remainingRatio.value !== 0) remainingRatio.value = 0
      if (nextHandRemainingSeconds.value !== 0) nextHandRemainingSeconds.value = 0
      rafId = 0
      return
    }

    const now = Date.now() + options.clockOffsetMs()
    const nextRemMs = nextHandDeadline !== null ? Math.max(0, nextHandDeadline - now) : 0
    const nextSec = Math.ceil(nextRemMs / 1000)
    if (nextHandRemainingSeconds.value !== nextSec) nextHandRemainingSeconds.value = nextSec

    const remMs = deadline !== null ? Math.max(0, deadline - now) : 0
    const sec = Math.ceil(remMs / 1000)
    const totalMs = Math.max(1, turnSeconds.value * 1000)
    const ratio = Math.max(0, Math.min(1, remMs / totalMs))

    // 秒数变了才写：每帧都写会让整棵座位树重渲染。
    if (sec !== lastUpdateSec) {
      lastUpdateSec = sec
      remainingSeconds.value = sec
    }

    // 进度条按 1/200 桶量化：视觉上足够平滑，又不会每帧触发。
    const bucket = Math.round(ratio * 200)
    if (bucket !== lastUpdateRatioBucket) {
      lastUpdateRatioBucket = bucket
      remainingRatio.value = ratio
    }

    if (remMs > 0 || nextRemMs > 0) {
      rafId = requestAnimationFrame(tick)
    } else {
      rafId = 0
      remainingSeconds.value = 0
      remainingRatio.value = 0
    }
  }

  // 截止时间一变就重启时钟（新的一手 / 换人行动 / 进入结算）。
  const stopWatch = watch(
    [() => options.turnDeadlineAt() ?? null, () => options.nextHandDeadlineAt() ?? null],
    ([deadline, nextHandDeadline]) => {
      stop()
      lastUpdateSec = -1
      lastUpdateRatioBucket = -1
      if (deadline !== null || nextHandDeadline !== null) tick()
      else reset()
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    stopWatch()
    stop()
  })

  return {
    remainingSeconds,
    remainingRatio,
    nextHandRemainingSeconds,
    nextHandCountdownVisible,
    turnSeconds,
    /** 供测试/调试：主动停表。 */
    stop,
  }
}

/** 便于在模板里直接用 `Readonly<Ref<number>>` 类型。 */
export type TimerRef = Ref<number>
