import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { RoomCredentials } from '../../shared/protocol.ts'

/**
 * 房间与玩家身份。
 *
 * credentials 第 3 阶段由 HTTP（建房 / 加房 / 邀请链接落地）写入，
 * WebSocket 连接时从这里读取 roomId / playerId / reconnectToken。
 * 第 1 阶段不含真实网络，准备状态只在本地维护。
 */
export const useRoomStore = defineStore('room', () => {
  /** 房间凭证：含 roomId / playerId / reconnectToken。 */
  const credentials = ref<RoomCredentials | null>(null)
  /** 本地准备状态；第 3 阶段由服务端快照与 room.ready 命令接管。 */
  const ready = ref(false)

  function setCredentials(next: RoomCredentials): void {
    credentials.value = next
    ready.value = false
  }

  function setReady(value: boolean): void {
    ready.value = value
  }

  function clear(): void {
    credentials.value = null
    ready.value = false
  }

  const roomId = computed(() => credentials.value?.roomId ?? null)
  const nickname = computed(() => credentials.value?.nickname ?? '')
  const playerId = computed(() => credentials.value?.playerId ?? null)
  const isHost = computed(() => credentials.value?.isHost ?? false)
  const hasCredentials = computed(() => credentials.value !== null)

  /** 邀请链接（同源路径，第 3 阶段可直接分享）。 */
  const inviteUrl = computed(() =>
    credentials.value ? `${window.location.origin}/room/${credentials.value.roomId}` : '',
  )

  return {
    credentials,
    ready,
    setCredentials,
    setReady,
    clear,
    roomId,
    nickname,
    playerId,
    isHost,
    hasCredentials,
    inviteUrl,
  }
})
