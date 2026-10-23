import { computed, inject, nextTick, provide, ref, watch, type InjectionKey } from 'vue'
import { CHAT_MAX_LENGTH } from '../../shared/protocol.ts'
import { useChatStore } from '../stores/chat.ts'

/**
 * 牌桌 HUD 浮动面板的状态与行为（聊天 / 计分板 / 手牌历史）。
 *
 * 从 `TableView.vue` 抽出，原因：
 *   - 三块面板是**互斥展开**的一组状态，散在页面组件里时靠三个 watch 互相 `true/false`，
 *     新增面板极易漏掉一处；
 *   - 聊天还有已读锚点、自动滚底、输入法组合、@ 插入等一串细节，
 *     和牌桌渲染逻辑混在 4500 行的文件里很难看懂。
 *
 * 这里只做「面板状态 + 聊天交互」，不碰牌局规则、不发任何命令给服务端；
 * 发送动作通过 `sendChat` 回调注入，便于以后替换传输层。
 */

/** 面板互斥展开：同一时刻最多只有一个 HUD 面板展开。 */
export interface HudPanelsOptions {
  /** 发送一条聊天消息；返回 false 表示未连接。 */
  sendChat: (text: string) => boolean
  /** 当前玩家 id（用于 @ 提醒判定）。 */
  heroPlayerId: () => string | null | undefined
}

/** useHudPanels 的返回值类型（子组件 inject 时复用）。 */
export type HudPanels = ReturnType<typeof useHudPanels>

const HUD_PANELS_KEY: InjectionKey<HudPanels> = Symbol('hud-panels')

/**
 * 在父组件里创建**唯一**实例并提供给子组件。
 *
 * HUD 三个面板拆成了组件，但展开互斥、聊天草稿等状态必须共享同一份；
 * 让每个子组件各自 `useHudPanels()` 会出现两份状态（A 展开 B 不知道）。
 */
export function provideHudPanels(options: HudPanelsOptions): HudPanels {
  const panels = useHudPanels(options)
  provide(HUD_PANELS_KEY, panels)
  return panels
}

/** 子组件取用父组件提供的实例。 */
export function useHudPanelsContext(): HudPanels {
  const panels = inject(HUD_PANELS_KEY)
  if (!panels) throw new Error('HudChatPanel 必须放在调用了 provideHudPanels() 的父组件内')
  return panels
}

export function useHudPanels(options: HudPanelsOptions) {
  const chat = useChatStore()

  /* ───────────── 面板展开状态 ───────────── */

  const chatOpen = ref(false)
  const scoreOpen = ref(false)
  const historyOpen = ref(false)

  const chatInputRef = ref<HTMLInputElement | null>(null)
  const chatListRef = ref<HTMLElement | null>(null)

  /** 收起除指定面板外的其它面板（互斥展开的唯一实现）。 */
  function exclusive(keep: 'chat' | 'score' | 'history'): void {
    chatOpen.value = keep === 'chat'
    scoreOpen.value = keep === 'score'
    historyOpen.value = keep === 'history'
  }

  /** 全部收起（点空白处、或页面跳转前）。 */
  function collapseAll(): void {
    chatOpen.value = false
    scoreOpen.value = false
    historyOpen.value = false
  }

  function toggleScore(): void {
    if (scoreOpen.value) scoreOpen.value = false
    else exclusive('score')
  }

  function toggleHistory(): void {
    if (historyOpen.value) historyOpen.value = false
    else exclusive('history')
  }

  /** 从结算叠层跳到手牌历史：直接展开历史面板。 */
  function openHistory(): void {
    exclusive('history')
  }

  /* ───────────── 聊天：已读与未读 ───────────── */

  /**
   * 关闭聊天面板时记录「已读锚点」。
   * 锚点 = 此刻的消息条数：下次再打开时，超出这个条数的消息就是「新消息」。
   */
  function markChatRead(): void {
    chat.markRead()
  }

  const unreadText = computed(() => (chat.unread > 99 ? '99+' : String(chat.unread)))

  const mentionCount = computed(
    () => chat.messages.filter((message) => message.kind === 'user' && mentionsMe(message)).length,
  )

  const chatAria = computed(() => {
    const parts = [chat.unread > 0 ? `聊天，${String(chat.unread)} 条未读消息` : '聊天，没有未读消息']
    if (mentionCount.value > 0) parts.push(`${String(mentionCount.value)} 条提到了你`)
    return parts.join('，')
  })

  /* ───────────── 聊天：滚动 ───────────── */

  /** 用户主动往上翻时置为 false：新消息只给提示，不抢滚动位置。 */
  const atBottom = ref(true)
  const hasNews = ref(false)

  function onChatScroll(): void {
    const element = chatListRef.value
    if (!element) return
    atBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
    if (atBottom.value) hasNews.value = false
  }

  /** 滚到底部：只在用户本来就在底部（或自己刚发完消息）时调用。 */
  async function scrollChatToBottom(): Promise<void> {
    await nextTick()
    const element = chatListRef.value
    if (!element) return
    element.scrollTop = element.scrollHeight
    atBottom.value = true
    hasNews.value = false
  }

  /* ───────────── 聊天：输入 ───────────── */

  const draft = ref('')
  const error = ref('')
  /** 中文输入法组合期间的回车只用于确认候选词，不能当成发送。 */
  const composing = ref(false)

  const canSend = computed(() => draft.value.trim().length > 0)

  /**
   * 打开 / 收起聊天面板：唯一的状态写入口。
   *   - 打开：清未读计数，锚点保持「上次离开时」的位置；
   *   - 关闭：记录锚点 = 此刻条数。
   * 这样「关闭 → 新消息 → 再打开」时，超出锚点的就是这一轮的新消息。
   */
  function toggleChat(): void {
    if (chatOpen.value) {
      markChatRead()
      chatOpen.value = false
      return
    }
    chat.clearUnread()
    exclusive('chat')
    nextTick(() => {
      chatInputRef.value?.focus()
      void scrollChatToBottom()
    })
  }

  /** 点击牌桌外部空白处：收起对应面板；收起聊天时同样记录已读锚点。 */
  function handleOutsidePointer(event: PointerEvent, selectors: Record<'chat' | 'score' | 'history', string>): void {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (chatOpen.value && !target.closest(selectors.chat)) {
      markChatRead()
      chatOpen.value = false
    }
    if (scoreOpen.value && !target.closest(selectors.score)) scoreOpen.value = false
    if (historyOpen.value && !target.closest(selectors.history)) historyOpen.value = false
  }

  function insertMention(nickname: string): void {
    const prefix = draft.value.length === 0 || draft.value.endsWith(' ') ? draft.value : `${draft.value} `
    draft.value = `${prefix}@${nickname} `
  }

  /** 点消息里的昵称：插入 @ 并聚焦输入框。 */
  function onSenderClick(nickname: string): void {
    insertMention(nickname)
    chatInputRef.value?.focus()
  }

  function submitChat(): void {
    const text = draft.value.trim()
    if (text.length === 0) return
    if (text.length > CHAT_MAX_LENGTH) {
      error.value = `消息最多 ${String(CHAT_MAX_LENGTH)} 个字，请删减后再发送。`
      return
    }
    if (!options.sendChat(text)) {
      error.value = '未连接，消息未发送'
      return
    }
    draft.value = ''
    error.value = ''
    void scrollChatToBottom()
  }

  function onChatKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    // Shift+Enter 不发送；顺带挡掉单行输入可能触发的原生表单提交。
    if (event.shiftKey) {
      event.preventDefault()
      return
    }
    // 中文输入法组合期间的回车只用于确认候选词。
    if (event.isComposing || composing.value) return
    event.preventDefault()
    submitChat()
  }

  /* ───────────── 聊天：@ 提醒与分组 ───────────── */

  function mentionsMe(message: Parameters<typeof chat.mentionsMe>[0]): boolean {
    return chat.mentionsMe(message, options.heroPlayerId() ?? null)
  }

  /**
   * 聊天分组：同一个人连续发言时，后续消息不再重复昵称。
   * @ 提醒要单独起一组，方便注意到。
   */
  function isChatContinuation(msg: { kind: string; playerId?: string; id: string }): boolean {
    if (msg.kind !== 'user' || !msg.playerId) return false
    const index = chat.messages.findIndex((item) => item.id === msg.id)
    if (index <= 0) return false
    const prev = chat.messages[index - 1]
    return Boolean(prev && prev.kind === 'user' && prev.playerId === msg.playerId)
  }

  /* ───────────── 聊天：被动联动 ───────────── */

  /** 新消息：展开时只滚到底，**不**重置未读锚点（否则「以下为新消息」永远不出现）。 */
  watch(
    () => chat.messages.length,
    () => {
      if (chatOpen.value) nextTick(() => void scrollChatToBottom())
    },
    { flush: 'post' },
  )

  /** 面板展开后滚到底并把焦点交给输入框（移动端可直接打字）。 */
  watch(chatOpen, (open) => {
    if (!open) return
    nextTick(() => {
      void scrollChatToBottom()
      chatInputRef.value?.focus()
    })
  })

  return {
    // 状态
    chat,
    chatOpen,
    scoreOpen,
    historyOpen,
    chatInputRef,
    chatListRef,
    atBottom,
    hasNews,
    draft,
    error,
    composing,
    // 计算
    canSend,
    unreadText,
    mentionCount,
    chatAria,
    // 动作
    exclusive,
    collapseAll,
    toggleChat,
    toggleScore,
    toggleHistory,
    openHistory,
    markChatRead,
    handleOutsidePointer,
    onChatScroll,
    scrollChatToBottom,
    onSenderClick,
    insertMention,
    submitChat,
    onChatKeydown,
    mentionsMe,
    isChatContinuation,
  }
}
