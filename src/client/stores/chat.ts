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

  function setHistory(history: readonly ChatMessage[]): void {
    messages.value = [...history]
  }

  function append(message: ChatMessage): void {
    messages.value = [...messages.value, message]
    unread.value += 1
  }

  function markRead(): void {
    unread.value = 0
  }

  function clear(): void {
    messages.value = []
    unread.value = 0
  }

  const latest = computed(() => messages.value[messages.value.length - 1] ?? null)
  const count = computed(() => messages.value.length)

  return { messages, unread, latest, count, setHistory, append, markRead, clear }
})
