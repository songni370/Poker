import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { RoomCredentials, RoomMemberPublic } from '../../shared/protocol.ts'

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
  /**
   * 房间成员名单（含旁观者）：只有主持人主动查询时服务端才下发，
   * 平时为空数组，因此不构成第二份「牌局真相」。
   */
  const members = ref<RoomMemberPublic[]>([])

  function setCredentials(next: RoomCredentials): void {
    credentials.value = next
    ready.value = false
  }

  function setReady(value: boolean): void {
    ready.value = value
  }

  /** 整体替换成员名单（服务端每次下发都是完整的一份）。 */
  function setMembers(next: readonly RoomMemberPublic[]): void {
    members.value = [...next]
  }

  function clear(): void {
    credentials.value = null
    ready.value = false
    members.value = []
  }

  const roomId = computed(() => credentials.value?.roomId ?? null)
  const nickname = computed(() => credentials.value?.nickname ?? '')
  const playerId = computed(() => credentials.value?.playerId ?? null)
  const isHost = computed(() => credentials.value?.isHost ?? false)
  const hasCredentials = computed(() => credentials.value !== null)

  /** 邀请链接：直接落在牌桌上（先旁观，自己选座买入）。 */
  const inviteUrl = computed(() =>
    credentials.value ? `${window.location.origin}/table/${credentials.value.roomId}` : '',
  )

  return {
    credentials,
    ready,
    members,
    setCredentials,
    setReady,
    setMembers,
    clear,
    roomId,
    nickname,
    playerId,
    isHost,
    hasCredentials,
    inviteUrl,
  }
})
