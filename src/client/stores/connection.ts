import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline'

/**
 * 链路状态、时钟偏移与重连计数。
 *
 * 第 3 阶段接入 WebSocket：服务端 heartbeat/pong 携带 serverTime，
 * 用 (serverTime - 本地发送时刻的往返中点) 得到 clockOffsetMs，
 * 所有倒计时都以「服务端时间 + 偏移」为准，避免本地时钟不准。
 */
export const useConnectionStore = defineStore('connection', () => {
  const status = ref<ConnectionStatus>('idle')
  /** 服务端时间 − 本地时间（毫秒）。 */
  const clockOffsetMs = ref(0)
  /** 连续重连次数，用于提示与退避展示。 */
  const reconnectCount = ref(0)
  /** 最近一次收到服务端时间的本地时刻，便于排查链路问题。 */
  const lastSyncedAt = ref<number | null>(null)

  function setStatus(next: ConnectionStatus): void {
    status.value = next
    if (next === 'online') reconnectCount.value = 0
    if (next === 'reconnecting') reconnectCount.value += 1
  }

  /** 用一次心跳往返估算时钟偏移；rttMs 为往返总耗时。 */
  function syncClock(serverTime: number, sentAt: number, rttMs: number): void {
    clockOffsetMs.value = Math.round(serverTime - (sentAt + rttMs / 2))
    lastSyncedAt.value = Date.now()
  }

  function reset(): void {
    status.value = 'idle'
    clockOffsetMs.value = 0
    reconnectCount.value = 0
    lastSyncedAt.value = null
  }

  /** 当前服务端时间估算值。 */
  const serverNow = computed(() => Date.now() + clockOffsetMs.value)
  const isOnline = computed(() => status.value === 'online')
  /** 是否需要在界面上提示链路异常。 */
  const isDegraded = computed(
    () => status.value === 'reconnecting' || status.value === 'offline' || status.value === 'connecting',
  )

  return {
    status,
    clockOffsetMs,
    reconnectCount,
    lastSyncedAt,
    setStatus,
    syncClock,
    reset,
    serverNow,
    isOnline,
    isDegraded,
  }
})
