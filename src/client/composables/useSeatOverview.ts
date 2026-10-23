import { computed } from 'vue'
import type { SeatPublic } from '../../shared/protocol.ts'

/**
 * 牌桌座位概况：谁在座、还剩几个空位、新来的人能坐哪。
 *
 * 观战面板（「贵宾观战席」）与桌面空位渲染都读这一份，避免两处各算一遍
 * 导致「面板说有 3 个空位、桌面上只画了 2 个」这类不一致。
 */
export interface SeatOverviewOptions {
  /** 座位数组（下标即座位号，空位为 null）。 */
  seats: () => readonly (SeatPublic | null)[]
  /** 桌面总席位数（来自服务端）。 */
  maxSeats: () => number | undefined
  /** 本人是否已在座（观战者不算）。 */
  isSeated: () => boolean
  /** 是否已有本人身份（观战者也有，用于判断「能不能入座」而非「是不是在座」）。 */
  hasSelf: () => boolean
}

export function useSeatOverview(options: SeatOverviewOptions) {
  /** 已入座人数。 */
  const occupiedCount = computed(() => options.seats().filter(Boolean).length)

  /** 桌面总席位数（服务端未下发时为 0）。 */
  const maxSeats = computed(() => options.maxSeats() ?? 0)

  /** 剩余空位数（不会为负）。 */
  const emptyCount = computed(() => Math.max(0, maxSeats.value - occupiedCount.value))

  /** 是否满员。 */
  const isTableFull = computed(() => maxSeats.value > 0 && occupiedCount.value >= maxSeats.value)

  /** 牌桌上第一个空席位号（0 起）；满员或无数据时为 null。 */
  const firstAvailableSeat = computed<number | null>(() => {
    const max = maxSeats.value
    if (max <= 0) return null
    const seats = options.seats()
    for (let index = 0; index < max; index += 1) {
      if (!seats[index]) return index
    }
    return null
  })

  /** 观战者是否可以入座：未在座、有空位、且已有房间身份。 */
  const canSitDown = computed(
    () =>
      !options.isSeated() &&
      !isTableFull.value &&
      options.hasSelf() &&
      firstAvailableSeat.value !== null,
  )

  return {
    occupiedCount,
    maxSeats,
    emptyCount,
    isTableFull,
    firstAvailableSeat,
    canSitDown,
  }
}
