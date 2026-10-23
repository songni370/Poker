import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ChatMessage } from '../../shared/protocol.ts'

/**
 * 房间聊天。
 *
 * 消息由服务端广播，客户端只做展示：进入/重连时用 chatHistory 整体替换，
 * 之后每收到一条 chat.message 追加一条。文本以纯文本渲染（Vue 默认转义），
 * 不做任何 HTML 注入。
 */
export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([])
  /** 未读计数：抽屉关闭时累加，打开时清零。 */
  const unread = ref(0)
  /**
   * 「以下为新消息」分隔线锚点：记录「上次离开聊天面板时」的消息条数。
   * 再次打开时，超出这个条数的消息就是这一轮的未读内容。
   * 用条数而不是 id：服务端下发的 id 可能被替换/去重，条数永远单调递增。
   */
  const readAnchorCount = ref<number | null>(null)

  function setHistory(history: readonly ChatMessage[]): void {
    messages.value = [...history]
  }

  /** 追加一条消息；系统消息（房间事件）不计入未读，避免「XX 入座」也亮红点。 */
  function append(message: ChatMessage): void {
    messages.value = [...messages.value, message]
    if (message.kind === 'user') unread.value += 1
  }

  /** 清零未读计数（不移动锚点）。 */
  function clearUnread(): void {
    unread.value = 0
  }

  /**
   * 记录「已读锚点」= 当前消息条数。只在离开聊天面板时调用，
   * 之后到达的消息都会显示在「以下为新消息」分隔线之下。
   */
  function markRead(): void {
    unread.value = 0
    readAnchorCount.value = messages.value.length
  }

  /** 这条消息是否在「上次已读锚点」之后（用于渲染分隔线）。 */
  function isAfterReadAnchor(message: ChatMessage): boolean {
    const anchor = readAnchorCount.value
    if (anchor === null) return false
    return messages.value.indexOf(message) >= anchor
  }

  /** 本轮第一条新消息（分隔线插在它前面）；没有新消息时返回 null。 */
  const firstUnreadId = computed(() => {
    const anchor = readAnchorCount.value
    if (anchor === null || anchor >= messages.value.length) return null
    return messages.value[anchor]?.id ?? null
  })

  function clear(): void {
    messages.value = []
    unread.value = 0
    readAnchorCount.value = null
  }

  const latest = computed(() => messages.value[messages.value.length - 1] ?? null)
  const count = computed(() => messages.value.length)

  /** 是否有人在这条消息里 @ 了我（服务端解析并校验过昵称）。 */
  function mentionsMe(message: ChatMessage, playerId: string | null | undefined): boolean {
    return Boolean(playerId) && (message.mentions ?? []).includes(playerId as string)
  }

  return {
    messages,
    unread,
    readAnchorCount,
    firstUnreadId,
    latest,
    count,
    mentionsMe,
    isAfterReadAnchor,
    clearUnread,
    setHistory,
    append,
    markRead,
    clear,
  }
})
