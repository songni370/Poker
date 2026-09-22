<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Drawer from 'primevue/drawer'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Menu from 'primevue/menu'
import type { MenuItem } from 'primevue/menuitem'
import Select from 'primevue/select'
import type { ActionType, Card } from '../../shared/poker.ts'
import { STREET_NAMES, TABLE_RULES, formatCard } from '../../shared/poker.ts'
import type { ChatMessage } from '../../shared/protocol.ts'
import { CHAT_MAX_LENGTH } from '../../shared/protocol.ts'
import { NICKNAME_MAX } from '../../shared/poker.ts'
import {
  SessionError,
  connectRoom,
  fetchRoomInfo,
  joinRoom as apiJoinRoom,
  loadCredentials,
  nextRequestId,
  sendChat,
  sendCommand,
  useSessionStore,
} from '../net/session.ts'
import ActionBar from '../components/ActionBar.vue'
import ConnectionBanner from '../components/ConnectionBanner.vue'
import HandResultOverlay from '../components/HandResultOverlay.vue'
import PlayingCard from '../components/PlayingCard.vue'
import PokerTable from '../components/PokerTable.vue'
import { playPing, soundEnabled, unlockAudio } from '../sound.ts'
import { useChatStore } from '../stores/chat.ts'
import { useConnectionStore } from '../stores/connection.ts'
import { useGameStore } from '../stores/game.ts'
import { useRoomStore } from '../stores/room.ts'

/**
 * 核心牌桌（路由 /table/:roomId）。
 *
 * 【第 3 阶段 WebSocket 接入点】applyMock() 是本文件唯一的模拟数据入口，
 * 上线时把它替换成下面三行即可，其余组件完全不用改动：
 *
 *   ws.onmessage = (message) => {
 *     const event: ServerEvent = JSON.parse(message.data)
 *     game.applySnapshot(event.state, event.self)   // 唯一写入入口
 *     connection.setStatus('online')
 *   }
 *
 * 生产构建下 import.meta.env.DEV 为 false，模拟数据会被摇树移除。
 */
const props = defineProps<{ roomId: string }>()

const route = useRoute()
const router = useRouter()
const game = useGameStore()
const connection = useConnectionStore()
const room = useRoomStore()
const session = useSessionStore()

const isDev = import.meta.env.DEV

/* ═══════════════ 唯一的模拟数据接入点（第 3 阶段替换此处） ═══════════════
 *
 * 生产构建下 import.meta.env.DEV 为 false，下面的动态 import 分支会被静态移除，
 * dev/mock.ts 因此不会进入生产包（已用 grep dist 校验）。
 * 第 3 阶段把 applyScenario 换成真正的 WebSocket 订阅即可：
 *
 *   const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`)
 *   ws.onmessage = (message) => {
 *     const event: ServerEvent = JSON.parse(message.data)
 *     game.applySnapshot(event.state, event.self)  // 唯一写入入口
 *     noticeText.value = event.notice ?? ''
 *     connection.setStatus('online')
 *   }
 */

const scenario = ref(isDev && typeof route.query.mock === 'string' ? route.query.mock : 'flop')
const scenarioOptions = ref<{ label: string; value: string }[]>([])
const noticeText = ref('')
watch(
  () => session.notice,
  (value) => {
    if (value) noticeText.value = value
  },
)
const unavailable = ref(false)

async function applyScenario(name: string): Promise<void> {
  if (!isDev) return
  const mock = await import('../dev/mock.ts')
  scenarioOptions.value = mock.MOCK_SCENARIO_NAMES.map((item) => ({ label: item, value: item }))
  const result = mock.devScenario(name)

  if (result.kind === 'redirect') {
    // 房间关闭 / 被移出 / 已满：转向错误页，此时没有可渲染的牌局快照。
    unavailable.value = true
    void router.push({
      name: 'error',
      query: {
        kind: 'mock',
        code: result.error.error,
        ...(result.error.detail === undefined ? {} : { detail: result.error.detail }),
      },
    })
    return
  }

  unavailable.value = false
  // 与第 3 阶段 WebSocket 完全一致的一次调用：整体替换快照。
  game.applySnapshot(result.snapshot.state, result.snapshot.self)
  noticeText.value = result.snapshot.notice ?? ''
  connection.setStatus('online')
  connection.clockOffsetMs = -120
}

/**
 * 接入优先级：本地有房间凭证 → 真实 WebSocket；否则开发模式用模拟场景；
 * 生产环境没有凭证时**不再跳错误页**：邀请链接直接落在牌桌上，
 * 这里给出「填昵称加入」面板，加入后先是旁观者，再自己选座买入。
 */
onMounted(() => {
  const credentials = room.credentials?.roomId === props.roomId ? room.credentials : loadCredentials(props.roomId)
  if (credentials) {
    room.setCredentials(credentials)
    connectRoom(credentials)
    return
  }
  if (isDev) {
    void applyScenario(scenario.value)
    return
  }
  void loadJoinInfo()
})

/* ───────────── 邀请链接：未加入时的「填昵称进桌」 ───────────── */

const joining = ref(false)
const joinNickname = ref('')
const joinError = ref('')
const joinInfo = ref<{ roomName: string; seated: number; maxSeats: number; status: string } | null>(null)
const joinInfoError = ref('')

/** 先取公开信息（房间名/人数），失败就给出可执行的提示，而不是白屏。 */
async function loadJoinInfo(): Promise<void> {
  try {
    const info = await fetchRoomInfo(props.roomId)
    joinInfo.value = info
  } catch (cause) {
    joinInfoError.value =
      cause instanceof SessionError && cause.code === 'room_not_found'
        ? '这个房间不存在或已经解散，请向房主要一条新的邀请链接。'
        : '暂时连不上服务器，请稍后重试。'
  }
}

async function submitJoin(): Promise<void> {
  joinError.value = ''
  const nickname = joinNickname.value.trim()
  if (!nickname) {
    joinError.value = '请先填写昵称。'
    return
  }
  joining.value = true
  try {
    const credentials = await apiJoinRoom(props.roomId, { nickname })
    room.setCredentials(credentials)
    connectRoom(credentials)
  } catch (cause) {
    joinError.value = cause instanceof SessionError ? cause.message : '加入失败，请稍后重试。'
  } finally {
    joining.value = false
  }
}

// 开发模式下切换场景时仍然可以预览；连上真实房间后不再干预。
watch(scenario, (name) => {
  if (isDev && !room.hasCredentials) void applyScenario(name)
})

/* ───────────── 倒计时（以服务端时间为准） ───────────── */

const nowMs = ref(Date.now())
let rafId = 0

function tick(): void {
  nowMs.value = Date.now()
  rafId = requestAnimationFrame(tick)
}

watch(
  () => game.state?.turnDeadlineAt ?? null,
  (deadline) => {
    cancelAnimationFrame(rafId)
    rafId = 0
    if (deadline !== null) rafId = requestAnimationFrame(tick)
  },
  { immediate: true },
)

onBeforeUnmount(() => cancelAnimationFrame(rafId))

const serverNow = computed(() => nowMs.value + connection.clockOffsetMs)
const remainingMs = computed(() => {
  const deadline = game.state?.turnDeadlineAt
  if (deadline === null || deadline === undefined) return 0
  return Math.max(0, deadline - serverNow.value)
})
const remainingSeconds = computed(() => Math.ceil(remainingMs.value / 1000))
const turnSeconds = computed(() => game.state?.turnSeconds ?? TABLE_RULES.turnSeconds)
const remainingRatio = computed(() => Math.min(1, remainingMs.value / (turnSeconds.value * 1000)))

/* ───────────── 视图数据 ───────────── */

/** 本人底牌、座位、筹码；全部来自服务端快照，不做本地推算。 */
const myCards = computed<readonly Card[]>(() => game.myHoleCards)
const myStack = computed(() => game.mySeat?.stack ?? 0)

const winnerPlayerIds = computed(() => game.state?.lastResult?.winners.map((winner) => winner.playerId) ?? [])
const highlightCards = computed<readonly Card[]>(() => {
  const result = game.state?.lastResult
  if (!result || !result.showdown) return []
  return result.winners.flatMap((winner) => winner.bestFive)
})

const potTotal = computed(() => game.state?.potTotal ?? 0)

/** 无法行动时的可解释原因，直接进入按钮 title 与空态文案。 */
const blockedReason = computed(() => {
  if (!connection.isOnline) return '连接未就绪，恢复后才能操作。'
  if (!game.state) return '正在载入牌局状态…'
  if (!game.isSeated) return '你正在旁观，入座后才能行动。'
  if (game.isMyTurn) return ''
  if (game.mySeat?.folded) return '你已弃牌，本手不再行动。'
  if (game.mySeat?.allIn) return '你已全下，等待发牌与结算。'
  if (game.state.phase === 'waiting') return '等待主持人开局。'
  if (game.state.phase === 'showdown' || game.state.phase === 'settlement') return '本手已结束，等待下一手。'
  if (game.actingSeat) return `等待 ${game.actingSeat.nickname} 行动。`
  return '当前没有需要你处理的动作。'
})

const streetText = computed(() => {
  const street = game.state?.street
  if (!street) return game.state?.status === 'waiting' ? '等待开局' : '本手已结束'
  return STREET_NAMES[street]
})

const overlayVisible = ref(false)
const resultDismissed = ref(false)
const result = computed(() => game.state?.lastResult ?? null)

/**
 * 已经确认过的结算手牌（handId），按房间存在 sessionStorage。
 * 刷新页面时不会为「自己已经点过知道了」的那一手再弹一次结算。
 */
const RESULT_SEEN_KEY = 'poker.resultSeen'
function seenKey(roomId: string): string {
  return `${RESULT_SEEN_KEY}:${roomId}`
}
const seenResultHandId = ref<string | null>(sessionStorage.getItem(seenKey(props.roomId)))

/**
 * 【坑】这两个 watch 的 getter 必须返回字符串/布尔这类原始值，不能返回数组。
 * 返回数组时每次求值都是新数组，`Object.is` 永不相等 —— 于是**任何**状态广播
 * （别人加入、断线、重连、甚至超时提示）都会重跑回调：结算被标记成「未确认」、
 * 叠层重新弹出。实测：一个人刷新页面，全桌所有人都会再弹一次结算叠层。
 */
watch(
  () => `${String(game.state?.handNo ?? -1)}:${game.state?.phase ?? ''}`,
  () => {
    resultDismissed.value = false
  },
)

watch(
  () =>
    `${String(game.state?.handNo ?? -1)}:${game.state?.phase ?? ''}:${String(Boolean(game.state?.lastResult))}`,
  () => {
    const state = game.state
    const hasResult = Boolean(state?.lastResult)
    const handId = state?.lastResult?.handId ?? null
    const settled = state?.phase === 'showdown' || state?.phase === 'settlement'
    // 本人已经确认过这一手的结算（例如刷新前点过「知道了」）就不再弹。
    const alreadySeen = handId !== null && handId === seenResultHandId.value
    overlayVisible.value = hasResult && settled && !resultDismissed.value && !alreadySeen
  },
  { immediate: true },
)

function closeResult(): void {
  resultDismissed.value = true
  overlayVisible.value = false
  const handId = result.value?.handId ?? null
  if (handId) {
    seenResultHandId.value = handId
    try {
      sessionStorage.setItem(seenKey(props.roomId), handId)
    } catch {
      // 隐私模式等场景下写不了 sessionStorage：只是刷新后会再弹一次，不影响牌局。
    }
  }
}

/** 屏幕阅读器公告：超时弃牌、断线等系统提示与行动倒计时。 */
const announcement = ref('')
watch(
  () => noticeText.value,
  (next) => {
    if (next && next !== announcement.value) announcement.value = next
  },
  { immediate: true },
)
watch(
  () => (game.isMyTurn ? game.state?.handNo : null),
  (handNo) => {
    if (handNo !== null && handNo !== undefined) announcement.value = `轮到你行动，请在 ${String(turnSeconds.value)} 秒内选择动作。`
  },
)

/* ───────────── 交互 ───────────── */

const drawerOpen = ref(false)
const drawerSection = ref<'rules' | 'history' | 'chat'>('rules')

/* ── 中等宽度收纳：顶栏按钮太多会折行（实测 ≤1000px 时顶栏从 61px 变 121px），
 * 把「规则 / 历史 / 聊天 / 提示音」收进「更多」菜单，退出与开始下一手始终露在外面。 ── */
const moreMenu = ref<InstanceType<typeof Menu> | null>(null)

const moreItems = computed<MenuItem[]>(() => [
  { label: '规则摘要', icon: 'pi pi-book', command: () => openDrawer('rules') },
  {
    label: game.history.length > 0 ? `手牌历史（${String(game.history.length)} 手）` : '手牌历史',
    icon: 'pi pi-list',
    command: () => openDrawer('history'),
  },
  {
    label: chat.unread > 0 ? `聊天（${String(chat.unread)} 条未读）` : '聊天',
    icon: 'pi pi-comments',
    command: () => openDrawer('chat'),
  },
  {
    label: `提示音：${soundEnabled.value ? '开' : '关'}`,
    icon: soundEnabled.value ? 'pi pi-volume-up' : 'pi pi-volume-off',
    command: () => toggleSound(),
  },
])

/** 「更多」按钮的无障碍名称要带上未读与手数，折叠后信息不能丢。 */
const moreAria = computed(() => {
  const parts = ['更多操作']
  if (game.history.length > 0) parts.push(`${String(game.history.length)} 手历史`)
  if (chat.unread > 0) parts.push(`${String(chat.unread)} 条未读聊天`)
  return parts.join('，')
})

function toggleMore(event: Event): void {
  moreMenu.value?.toggle(event)
}

function openDrawer(section: 'rules' | 'history' | 'chat'): void {
  drawerSection.value = section
  drawerOpen.value = true
}

/* ───────────── 聊天（抽屉内的 chat 分节） ─────────────
 * 数据全部来自 chat store（服务端广播），这里只负责展示、未读与滚动行为。 */

const chat = useChatStore()

/**
 * 时间交给 Intl 格式化，不硬编码 HH:mm。
 * 界面语言固定为简体中文（<html lang="zh-CN">），这里显式指定区域，
 * 避免浏览器区域是 en-US 时出现「06:48 PM」这类与界面不一致的格式。
 */
const chatTimeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })
const chatDayFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

function isOwnMessage(message: ChatMessage): boolean {
  const selfId = game.self?.playerId
  return Boolean(selfId) && message.playerId === selfId
}

function chatTime(at: number): string {
  return Number.isFinite(at) ? chatTimeFormat.format(at) : ''
}

function chatFullTime(at: number): string {
  return Number.isFinite(at) ? chatDayFormat.format(at) : ''
}

/** <time datetime> 用：时间戳异常时不抛错，只省略属性。 */
function chatIso(at: number): string | undefined {
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined
}

/** 抽屉是否正停在聊天分节：决定未读是否清零、消息是否即时标记已读。 */
const chatPanelVisible = computed(() => drawerOpen.value && drawerSection.value === 'chat')
/** 打开面板那一刻的第一条未读消息 id：用于「以下为新消息」分隔线（记住后不再随未读清零而消失）。 */
const unreadBoundaryId = ref<string | null>(null)

const chatText = ref('')
/** 聊天搜索关键词：只过滤展示，不改动消息本身。 */
const chatQuery = ref('')
const mentionMenu = ref<InstanceType<typeof Menu> | null>(null)
const chatError = ref('')
/** 中文输入法组合期间的回车只用于确认候选词，不能当成发送。 */
const composing = ref(false)

const chatRemaining = computed(() => CHAT_MAX_LENGTH - chatText.value.length)
const canSendChat = computed(() => chatText.value.trim().length > 0)

const chatListRef = ref<HTMLElement | null>(null)
/** 用户主动往上翻时置为 false：新消息只给提示，不抢滚动位置。 */
const chatAtBottom = ref(true)
const chatHasNews = ref(false)

function onChatScroll(): void {
  const element = chatListRef.value
  if (!element) return
  chatAtBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
  if (chatAtBottom.value) chatHasNews.value = false
}

/** 滚到底部：只在用户本来就在底部（或自己刚发完消息）时调用。 */
async function scrollChatToBottom(): Promise<void> {
  await nextTick()
  const element = chatListRef.value
  if (!element) return
  element.scrollTop = element.scrollHeight
  chatAtBottom.value = true
  chatHasNews.value = false
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

/* ── @ 提醒：服务端按昵称解析 mentions，这里负责高亮与「插入 @」。 ── */

const myPlayerId = computed(() => game.self?.playerId ?? null)

function mentionsMe(message: ChatMessage): boolean {
  return chat.mentionsMe(message, myPlayerId.value)
}

/**
 * 消息里有没有 @ 提醒（服务端已把昵称解析成 playerId）。
 * 分组时按「任何 @ 提醒」断开，而不是只按「提到了我」：
 * 否则同一条消息在发送方和接收方会落进不同的分组，带 @ 的话被并进上一条里很容易漏看。
 */
function hasMention(message: ChatMessage): boolean {
  return (message.mentions?.length ?? 0) > 0
}

/** 被 @ 到的玩家一览（排除自己）；没有别人时菜单为空。 */
const mentionItems = computed<MenuItem[]>(() =>
  game.seats
    .filter((seat): seat is NonNullable<typeof seat> => Boolean(seat) && seat?.playerId !== myPlayerId.value)
    .map((seat) => ({
      label: seat.nickname,
      icon: 'pi pi-at',
      command: () => insertMention(seat.nickname),
    })),
)

function toggleMentionMenu(event: Event): void {
  mentionMenu.value?.toggle(event)
}

function insertMention(nickname: string): void {
  const prefix = chatText.value.length === 0 || chatText.value.endsWith(' ') ? chatText.value : `${chatText.value} `
  chatText.value = `${prefix}@${nickname} `
}

function submitChat(): void {
  const text = chatText.value.trim()
  if (text.length === 0) return
  if (text.length > CHAT_MAX_LENGTH) {
    chatError.value = `消息最多 ${String(CHAT_MAX_LENGTH)} 个字，请删减后再发送。`
    return
  }
  if (!sendChat(text)) {
    chatError.value = '未连接，消息未发送'
    return
  }
  chatText.value = ''
  chatError.value = ''
  void scrollChatToBottom()
}

/** 提到了我的消息条数（用于按钮提示，不只靠红点）。 */
const mentionCount = computed(
  () => chat.messages.filter((message) => message.kind === 'user' && mentionsMe(message)).length,
)

const unreadText = computed(() => (chat.unread > 99 ? '99+' : String(chat.unread)))
/** 按钮名称里同时报未读与「提到了你」，折叠进「更多」菜单后信息也不丢。 */
const chatAria = computed(() => {
  const parts = [chat.unread > 0 ? `聊天，${String(chat.unread)} 条未读消息` : '聊天，没有未读消息']
  if (mentionCount.value > 0) parts.push(`${String(mentionCount.value)} 条提到了你`)
  return parts.join('，')
})
const chatTitle = computed(() => (chat.unread > 0 ? `聊天（${String(chat.unread)} 条未读）` : '聊天'))

/**
 * 打开面板时把「第一条未读」记下来，用于渲染「以下为新消息」分隔线。
 * 必须在 markRead 之前取，否则未读数已被清零。
 */
watch(
  chatPanelVisible,
  (visible) => {
    if (!visible) {
      unreadBoundaryId.value = null
      return
    }
    const boundary = chat.messages[chat.messages.length - chat.unread]
    unreadBoundaryId.value = chat.unread > 0 && boundary ? boundary.id : null
    chat.markRead()
    void scrollChatToBottom()
  },
  { immediate: true },
)

/** 相邻消息间隔超过这个值就补一个时间分隔。 */
const CHAT_GAP_MS = 5 * 60 * 1000

type ChatRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'gap'; key: string; label: string }
  | { kind: 'unread'; key: string }
  /** groupStart=false：与上一条同人消息同组，只显示正文（昵称/时间由组首给出）。 */
  | { kind: 'message'; key: string; message: ChatMessage; groupStart: boolean }

function chatDayKey(at: number): string {
  const date = new Date(at)
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1)}-${String(date.getDate())}`
}

function chatDayLabel(at: number): string {
  const date = new Date(at)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  if (chatDayKey(at) === chatDayKey(today.getTime())) return '今天'
  if (chatDayKey(at) === chatDayKey(yesterday.getTime())) return '昨天'
  return chatDayFormat.format(date)
}

/**
 * 聊天渲染行：日期分隔 + 间隔较久时的时间分隔 + 未读分隔线 + 消息本身。
 * 分组只影响展示，消息数组仍是服务端下发的原始顺序。
 *
 * 同一个人连续发言会折叠成一组：只有组首显示昵称与时间，后续只显示正文。
 * 连续发言的判定必须够保守——日期分隔、时间分隔、未读分隔线、系统消息、
 * @ 提醒、搜索过滤后的相邻关系都会打断分组，否则会把不相干的话并成一组。
 */
const chatRows = computed<ChatRow[]>(() => {
  const query = chatQuery.value.trim().toLowerCase()
  const source = query
    ? chat.messages.filter(
        (message) =>
          message.text.toLowerCase().includes(query) || message.nickname.toLowerCase().includes(query),
      )
    : chat.messages
  const rows: ChatRow[] = []
  let previous: ChatMessage | null = null
  let previousDay = ''
  /** 当前分组的组首消息；为 null 表示下一条必须重新起组。 */
  let groupAnchor: ChatMessage | null = null
  for (const message of source) {
    // 搜索时不再插入日期/间隔/未读分隔，也不做分组：过滤后的相邻关系是假象，
    // 每条结果都带上昵称更好读。
    if (query) {
      rows.push({ kind: 'message', key: message.id, message, groupStart: true })
      previous = message
      groupAnchor = null
      continue
    }
    const day = chatDayKey(message.at)
    if (day !== previousDay) {
      rows.push({ kind: 'day', key: `day-${day}`, label: chatDayLabel(message.at) })
      previousDay = day
      groupAnchor = null
    } else if (previous && message.at - previous.at > CHAT_GAP_MS) {
      rows.push({ kind: 'gap', key: `gap-${message.id}`, label: chatTime(message.at) })
      groupAnchor = null
    }
    if (unreadBoundaryId.value === message.id) {
      rows.push({ kind: 'unread', key: 'unread-divider' })
      groupAnchor = null
    }

    const grouped =
      groupAnchor !== null &&
      groupAnchor.kind === 'user' &&
      message.kind === 'user' &&
      groupAnchor.playerId === message.playerId &&
      !hasMention(groupAnchor) &&
      !hasMention(message)

    rows.push({ kind: 'message', key: message.id, message, groupStart: !grouped })
    if (message.kind !== 'user') groupAnchor = null
    else if (!grouped) groupAnchor = message
    // grouped 为真时保持原组首，继续把后续同人消息并进同一组。
    previous = message
  }
  return rows
})

watch(
  () => chat.count,
  () => {
    if (chatPanelVisible.value) chat.markRead()
    if (chatAtBottom.value) void scrollChatToBottom()
    else chatHasNews.value = true
  },
)

/** 搜索结果提示：仅在有查询词时显示。 */
const chatSearchText = computed(() => {
  const query = chatQuery.value.trim()
  if (!query) return ''
  const shown = chatRows.value.filter((row) => row.kind === 'message').length
  return `匹配 ${String(shown)} 条`
})

/* ───────────── 手牌历史（抽屉内的 history 分节） ───────────── */

/** 昵称以当前座位快照为准；已离座玩家退化为占位文案。 */
function nicknameOf(playerId: string): string {
  return game.seats.find((seat) => seat?.playerId === playerId)?.nickname ?? '已离座玩家'
}

function boardText(cards: readonly Card[]): string {
  return cards.map((card) => formatCard(card)).join(' ')
}

/** 旧→新的服务端历史，展示时反转为最新在最上面。 */
const historyRows = computed(() =>
  [...game.history].reverse().map((entry) => ({
    ...entry,
    boardLabel: boardText(entry.board),
    winners: entry.winners.map((winner) => ({
      ...winner,
      nickname: nicknameOf(winner.playerId),
      isHero: winner.playerId === game.self?.playerId,
    })),
  })),
)

const historyAria = computed(() =>
  game.history.length > 0
    ? `手牌历史，已记录 ${String(game.history.length)} 手`
    : '手牌历史，暂无记录',
)

/* ───────────── 提示音开关 ─────────────
 * soundEnabled 已持久化；打开时必须由用户手势解锁音频上下文。 */

const soundAria = computed(() => `提示音：${soundEnabled.value ? '开' : '关'}`)

function toggleSound(): void {
  soundEnabled.value = !soundEnabled.value
  if (soundEnabled.value) {
    // 顺序不能反：ensureContext 会先检查开关是否打开。
    unlockAudio()
    playPing()
    announcement.value = '提示音已打开。'
    return
  }
  announcement.value = '提示音已关闭。'
}

/* ───────────── 观战者面板 ───────────── */

const occupiedCount = computed(() => game.seats.filter(Boolean).length)
const maxSeats = computed(() => game.state?.maxSeats ?? 0)

/** 第一个空座位号；没有空位时为 null（入座按钮据此禁用）。 */
const firstFreeSeat = computed<number | null>(() => {
  const total = maxSeats.value
  for (let index = 0; index < total; index += 1) {
    if (!game.seats[index]) return index
  }
  return null
})

/** 所有空座位号（观战者可以自己挑，而不是只能坐第一个）。 */
const freeSeats = computed(() => {
  const seats: number[] = []
  for (let index = 0; index < maxSeats.value; index += 1) {
    if (!game.seats[index]) seats.push(index)
  }
  return seats
})

const freeSeatText = computed(() => freeSeats.value.map((seat) => `${String(seat + 1)} 号`).join('、'))

/* 落座前先确认买入额：房主定上限，下限 10 个大盲，步进 = 小盲（服务端同样校验）。 */
const buyInOpen = ref(false)
const buyInSeat = ref<number | null>(null)
const buyInAmount = ref(0)

const buyInMin = computed(() => game.state?.buyInMin ?? 0)
const buyInMax = computed(() => game.state?.buyInMax ?? 0)
const buyInStep = computed(() => game.state?.buyInStep ?? TABLE_RULES.smallBlind)

/** 打开买入弹窗：默认给满上限（最少点击），下限/上限/步进都来自服务端。 */
function openBuyIn(seat: number): void {
  buyInSeat.value = seat
  buyInAmount.value = buyInMax.value || TABLE_RULES.startingStack
  buyInOpen.value = true
}

function confirmBuyIn(): void {
  const seat = buyInSeat.value
  if (seat === null) return
  const amount = Math.round(Number(buyInAmount.value) / buyInStep.value) * buyInStep.value
  if (!sendCommand({ type: 'seat.take', requestId: nextRequestId(), seat, buyIn: amount })) {
    announcement.value = '尚未连接到服务器，入座请求未发送。'
    return
  }
  announcement.value = `正在坐到 ${String(seat + 1)} 号座位，买入 ${String(amount)} 筹码。`
  buyInOpen.value = false
  buyInSeat.value = null
}

function takeSeatAt(seat: number): void {
  openBuyIn(seat)
}

function takeFreeSeat(): void {
  const seat = firstFreeSeat.value
  if (seat === null) return
  openBuyIn(seat)
}

/* ── 座位挑选（旁观者与离座者） ── */

/** 本人离座但座位仍被保留（只有本人能坐回）。 */
const mySeatAway = computed(() => game.mySeat?.away ?? false)

/** 本人保留的座位号（离座后仍是本人的座位；没离座则为 null）。 */
const myReservedSeat = computed(() => (mySeatAway.value ? (game.self?.seat ?? null) : null))

/** 能不能在桌面上挑座位：未入座（旁观）或已离座但保留座位。 */
const canPickSeat = computed(() => Boolean(game.self) && (!game.isSeated || mySeatAway.value))

/** 点桌面空位：自己保留的座位直接坐回（筹码还在就没必要再买入），其他空位走买入确认。 */
function onPickSeat(seat: number): void {
  if (myReservedSeat.value === seat) {
    resit()
    return
  }
  openBuyIn(seat)
}

/* ── 坐回保留座位 / 离座 / 退出房间（第 6 项） ── */

/** 本人保留座位里的筹码：>0 直接坐回，=0 说明输光了，需要重新买入。 */
const myReservedStack = computed(() => game.mySeat?.stack ?? 0)

function resit(): void {
  const seat = game.self?.seat
  if (seat === null || seat === undefined) return
  if (myReservedStack.value > 0) {
    if (!sendCommand({ type: 'seat.take', requestId: nextRequestId(), seat })) {
      announcement.value = '尚未连接到服务器，坐回请求未发送。'
      return
    }
    announcement.value = `正在坐回 ${String(seat + 1)} 号座位。`
    return
  }
  // 筹码为 0：走买入弹窗，重新买入后再入座。
  openBuyIn(seat)
}

/** 本手里还在牌局中（未弃牌）：离座会同时弃牌，先让玩家确认。 */
const inLiveHand = computed(() => Boolean(game.mySeat?.inHand && !game.mySeat.folded && !mySeatAway.value))
const leaveSeatOpen = ref(false)
const exitRoomOpen = ref(false)

function requestLeaveSeat(): void {
  if (inLiveHand.value) {
    leaveSeatOpen.value = true
    return
  }
  leaveSeat()
}

function leaveSeat(): void {
  leaveSeatOpen.value = false
  if (!sendCommand({ type: 'seat.leave', requestId: nextRequestId() })) {
    announcement.value = '尚未连接到服务器，离座请求未发送。'
    return
  }
  announcement.value = '已离座，座位与筹码为你保留，随时可以坐回。'
}

function exitRoom(): void {
  exitRoomOpen.value = false
  if (!sendCommand({ type: 'room.leave', requestId: nextRequestId() })) {
    announcement.value = '尚未连接到服务器，退出请求未发送。'
    return
  }
  room.clear()
  void router.push({ name: 'lobby' })
}

function submitAction(payload: { action: ActionType; amount?: number }): void {
  const state = game.state
  if (!state || !state.handId) {
    announcement.value = '牌局尚未开始，无法行动。'
    return
  }
  const sent = sendCommand({
    type: 'game.action',
    requestId: nextRequestId(),
    handId: state.handId,
    expectedVersion: state.version,
    action: payload.action,
    ...(payload.amount === undefined ? {} : { amount: payload.amount }),
  })
  announcement.value = sent ? '已提交动作，等待服务端裁定。' : '尚未连接到服务器，动作未发送。'
}

/** 是否已经开过手：决定按钮文案是「开始牌局」还是「开始下一手」。 */
const hasPlayedHand = computed(() => (game.state?.handNo ?? 0) > 0)

/** 主持人开始下一手（结算后无需回到等待区）。 */
const canStartNextHand = computed(
  () => room.isHost && !!game.state && (game.state.phase === 'waiting' || game.state.phase === 'settlement'),
)

function startNextHand(): void {
  if (!sendCommand({ type: 'game.start', requestId: nextRequestId() })) {
    announcement.value = '尚未连接到服务器，无法开始下一手。'
  }
}


</script>

<template>
  <div class="table-view">
    <!-- 邀请链接落地页：还没加入这个房间，先填昵称进桌（进去后是旁观者，自己选座买入）。
         开发模式的模拟场景用 game.state 判定，不会被这块面板挡住。 -->
    <main v-if="!room.hasCredentials && !game.state" id="main" class="join-gate">
      <section class="panel join-card" aria-labelledby="join-gate-title">
        <p class="mark">私人牌局 · 邀请制</p>
        <h1 id="join-gate-title" class="join-title">
          {{ joinInfo ? `加入「${joinInfo.roomName}」` : '加入这桌牌局' }}
        </h1>
        <p v-if="joinInfo" class="hint">
          已入座 {{ joinInfo.seated }}/{{ joinInfo.maxSeats }} · 进桌后先旁观，点空位确认买入即可落座。
        </p>
        <p v-else-if="joinInfoError" class="join-error" role="alert">{{ joinInfoError }}</p>
        <p v-else class="hint">正在读取房间信息…</p>

        <label class="field" for="join-nickname">
          <span class="label">你的昵称</span>
          <InputText
            id="join-nickname"
            v-model="joinNickname"
            :maxlength="NICKNAME_MAX"
            placeholder="例如：小满"
            autocomplete="nickname"
            fluid
            @keyup.enter="submitJoin"
          />
        </label>
        <p v-if="joinError" class="join-error" role="alert">{{ joinError }}</p>
        <div class="join-actions">
          <Button :disabled="joining || Boolean(joinInfoError)" @click="submitJoin">
            <i class="pi pi-sign-in" aria-hidden="true" />
            <span>进入牌桌</span>
          </Button>
          <Button text :title="'回到大厅'" @click="router.push({ name: 'lobby' })">
            <i class="pi pi-home" aria-hidden="true" />
            <span>回大厅</span>
          </Button>
        </div>
      </section>
    </main>

    <template v-else>
    <ConnectionBanner />

    <!-- 顶部：房间名、盲注、连接状态、设置与退出（规格书 §3.3）。 -->
    <header class="bar">
      <h1 class="bar-title">{{ game.state?.roomName || '牌桌' }}</h1>
      <span class="stat"><span>盲注</span><b class="num">{{ TABLE_RULES.smallBlind }}/{{ TABLE_RULES.bigBlind }}</b></span>
      <span class="stat stat--hand"><span>第</span><b class="num">{{ game.state?.handNo ?? 0 }}</b><span>手</span></span>
      <span class="stat stat--stage"><span>阶段</span><b>{{ streetText }}</b></span>
      <span
        class="link-state"
        :class="connection.isOnline ? 'is-online' : 'is-offline'"
        role="status"
      >
        <i :class="connection.isOnline ? 'pi pi-wifi' : 'pi pi-exclamation-triangle'" aria-hidden="true" />
        <span>{{ connection.isOnline ? '已连接' : '连接异常' }}</span>
      </span>

      <span class="bar-spacer" />

      <!-- 开发期场景切换：生产构建不渲染。 -->
      <label v-if="isDev" class="scenario">
        <span class="sr-only">切换模拟场景</span>
        <Select v-model="scenario" :options="scenarioOptions" option-label="label" option-value="value" size="small" />
      </label>

      <Button
        size="small"
        text
        class="bar-secondary"
        aria-label="规则"
        :title="'查看规则摘要'"
        @click="openDrawer('rules')"
      >
        <i class="pi pi-book" aria-hidden="true" />
        <span>规则</span>
      </Button>
      <Button size="small" text class="bar-secondary" :aria-label="historyAria" :title="'查看手牌历史'" @click="openDrawer('history')">
        <i class="pi pi-list" aria-hidden="true" />
        <span>历史</span>
        <!-- 手数只在宽屏显示，窄屏交给 aria-label 说明。 -->
        <span v-if="game.history.length > 0" class="count-chip count-chip--history num" aria-hidden="true">{{ game.history.length }}</span>
      </Button>
      <Button size="small" text class="bar-secondary" :aria-label="chatAria" :title="chatTitle" @click="openDrawer('chat')">
        <i class="pi pi-comments" aria-hidden="true" />
        <span>聊天</span>
        <!-- 未读数：数字 + aria-label 双重说明，不靠颜色或红点单独表意。 -->
        <span v-if="chat.unread > 0" class="count-chip count-chip--unread num" aria-hidden="true">{{ unreadText }}</span>
      </Button>
      <Button
        size="small"
        text
        class="bar-secondary"
        :aria-label="soundAria"
        :aria-pressed="soundEnabled"
        :title="`${soundAria}，点击切换`"
        @click="toggleSound"
      >
        <i :class="soundEnabled ? 'pi pi-volume-up' : 'pi pi-volume-off'" aria-hidden="true" />
        <span>提示音：{{ soundEnabled ? '开' : '关' }}</span>
      </Button>
      <Button
        size="small"
        text
        class="bar-more"
        :aria-label="moreAria"
        :title="'更多操作（规则 / 历史 / 聊天 / 提示音）'"
        aria-haspopup="true"
        aria-controls="bar-more-menu"
        @click="toggleMore"
      >
        <i class="pi pi-ellipsis-h" aria-hidden="true" />
        <span>更多</span>
        <span v-if="chat.unread > 0" class="count-chip count-chip--unread num" aria-hidden="true">{{ unreadText }}</span>
      </Button>
      <Menu id="bar-more-menu" ref="moreMenu" :model="moreItems" :popup="true" />

      <Button
        v-if="canStartNextHand"
        size="small"
        :title="hasPlayedHand ? '开始下一手牌' : '开始第一手牌'"
        @click="startNextHand"
      >
        <i class="pi pi-play" aria-hidden="true" />
        <span>{{ hasPlayedHand ? '开始下一手' : '开始牌局' }}</span>
      </Button>
      <Button size="small" outlined aria-label="退出房间" :title="'退出房间（释放座位）'" @click="exitRoomOpen = true">
        <i class="pi pi-sign-out" aria-hidden="true" />
        <span>退出</span>
      </Button>
    </header>

    <!-- 屏幕阅读器公告区：超时、断线、轮到自己。 -->
    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement }}</p>

    <!-- 横屏引导：竖屏窄屏时提示，同时保留桌面基本信息与操作。 -->
    <p class="rotate-hint">
      <i class="pi pi-mobile" aria-hidden="true" />
      <span>把手机横过来视野更完整；竖屏下牌桌信息仍然可读、操作按钮仍然可用。</span>
    </p>

    <main id="main" class="stage">
      <PokerTable
        v-if="game.state && !unavailable"
        :seats="game.seats"
        :max-seats="game.state.maxSeats"
        :board="game.board"
        :pot-total="potTotal"
        :pots="game.state.pots"
        :current-bet="game.state.currentBet"
        :hero-seat="game.self?.seat ?? null"
        :hero-player-id="game.self?.playerId ?? null"
        :acting-player-id="game.state.actingPlayerId"
        :remaining-ratio="remainingRatio"
        :remaining-seconds="remainingSeconds"
        :turn-seconds="turnSeconds"
        :winner-player-ids="winnerPlayerIds"
        :highlight-cards="highlightCards"
        :street="game.state.street"
        :notice="noticeText"
        :can-pick-seat="canPickSeat"
        :reserved-seat="myReservedSeat"
        @pick-seat="onPickSeat"
      />
      <!-- 加载中 / 场景不可用。 -->
      <p v-else-if="!unavailable" class="loading" role="status">
        <i class="pi pi-spin pi-spinner" aria-hidden="true" />
        <span>正在载入牌局…</span>
      </p>
      <p v-else class="loading" role="status">
        <i class="pi pi-exclamation-triangle" aria-hidden="true" />
        <span>当前牌局不可用，正在打开提示页…</span>
      </p>
    </main>

    <!-- 底部：本人底牌、剩余筹码、倒计时、下注控件与动作区。 -->
    <footer v-if="!unavailable" class="hero">
      <div v-if="game.isSeated && !mySeatAway" class="hero-cards">
        <span class="hero-label">你的底牌</span>
        <div class="cards">
          <PlayingCard v-for="card in myCards" :key="card" size="lg" upright :card="card" />
          <span v-if="myCards.length === 0" class="muted hint">本手没有底牌</span>
        </div>
        <span class="hero-stack">
          <span class="muted">筹码</span>
          <b class="num">{{ myStack }}</b>
        </span>
        <span class="hero-seat-actions">
          <Button size="small" text :title="'离座（座位与筹码为你保留）'" @click="requestLeaveSeat">
            <i class="pi pi-sign-out" aria-hidden="true" />
            <span>离座</span>
          </Button>
          <Button size="small" text :title="'退出房间（释放座位）'" @click="exitRoomOpen = true">
            <i class="pi pi-times" aria-hidden="true" />
            <span>退出房间</span>
          </Button>
        </span>
      </div>

      <!-- 观战者：只显示公开信息与入座入口，绝不渲染任何玩家的底牌。 -->
      <section v-else-if="game.self" class="spectator" aria-labelledby="spectator-state">
        <p id="spectator-state" class="spectator-state">
          <i :class="mySeatAway ? 'pi pi-user-minus' : 'pi pi-eye'" aria-hidden="true" />
          <b>{{ mySeatAway ? '已离座' : '观战中' }}</b>
          <span class="muted">
            {{
              mySeatAway
                ? `座位与筹码保留着（${String((game.self.seat ?? 0) + 1)} 号位），随时可以坐回。`
                : '你正在旁观这桌牌局，只能看到已经公开的牌。'
            }}
          </span>
        </p>

        <p class="spectator-seats">
          <span class="muted">已入座</span>
          <b class="num">{{ occupiedCount }}/{{ maxSeats }}</b>
          <span v-if="freeSeats.length > 0" class="muted">· 空位：{{ freeSeatText }}</span>
        </p>

        <!-- 空位可选：观战者自己挑座位，而不是只能坐第一个。离座者只看自己的座位。 -->
        <div v-if="freeSeats.length > 0 && !mySeatAway" class="spectator-seat-picker">
          <span id="seat-picker-label" class="muted">选择座位</span>
          <div class="seat-picker" role="group" aria-labelledby="seat-picker-label">
            <Button
              v-for="seat in freeSeats"
              :key="seat"
              size="small"
              outlined
              :aria-label="`坐到 ${String(seat + 1)} 号座位`"
              :title="`坐到 ${String(seat + 1)} 号座位`"
              @click="takeSeatAt(seat)"
            >
              <span class="num">{{ seat + 1 }}</span>
            </Button>
          </div>
        </div>

        <div class="spectator-actions">
          <Button
            v-if="mySeatAway"
            :title="`坐回 ${String((game.self.seat ?? 0) + 1)} 号座位`"
            @click="resit"
          >
            <i class="pi pi-user-plus" aria-hidden="true" />
            <span>坐回 {{ (game.self.seat ?? 0) + 1 }} 号位</span>
          </Button>
          <Button
            v-else
            :disabled="firstFreeSeat === null"
            :title="firstFreeSeat === null ? '座位已满，等有人离座' : `坐到 ${String(firstFreeSeat + 1)} 号座位`"
            @click="takeFreeSeat"
          >
            <i class="pi pi-user-plus" aria-hidden="true" />
            <span>{{ firstFreeSeat === null ? '入座' : `入座 ${firstFreeSeat + 1} 号位` }}</span>
          </Button>
          <Button outlined :title="'退出房间（释放座位）'" @click="exitRoomOpen = true">
            <i class="pi pi-times" aria-hidden="true" />
            <span>退出房间</span>
          </Button>
        </div>

        <p v-if="mySeatAway" class="hint" role="status">
          座位为你保留着，点「坐回 {{ (game.self.seat ?? 0) + 1 }} 号位」就能接着玩。
        </p>
        <p v-else-if="firstFreeSeat === null" class="hint" role="status">座位已满，等有人离座。</p>
        <p v-else class="hint spectator-tip">入座后即可参与下一手牌；观战期间不下注、不行动。</p>
      </section>

      <p v-else class="hint">正在载入你的座位信息…</p>

      <ActionBar
        v-if="game.isSeated && !mySeatAway"
        class="hero-actions"
        :legal-actions="game.myLegalActions"
        :pot-total="potTotal"
        :current-bet="game.state?.currentBet ?? 0"
        :my-stack="myStack"
        :is-my-turn="game.isMyTurn"
        :remaining-seconds="remainingSeconds"
        :turn-seconds="turnSeconds"
        :blocked-reason="blockedReason"
        :enabled="connection.isOnline"
        @action="submitAction"
      />
    </footer>

    <!-- 侧边抽屉：规则 / 手牌历史 / 聊天；默认收起，不抢占桌面宽度。 -->
    <Drawer v-model:visible="drawerOpen" position="right" :header="'牌桌信息'" :style="{ width: 'min(92vw, 360px)' }">
      <div class="drawer-inner">
          <div class="drawer-tabs" role="tablist" aria-label="牌桌信息分类">
          <Button
            size="small"
            :severity="drawerSection === 'rules' ? 'help' : 'secondary'"
            :outlined="drawerSection !== 'rules'"
            role="tab"
            :aria-selected="drawerSection === 'rules'"
            :title="'规则摘要'"
            @click="drawerSection = 'rules'"
          >
            <span>规则</span>
          </Button>
          <Button
            size="small"
            :severity="drawerSection === 'history' ? 'help' : 'secondary'"
            :outlined="drawerSection !== 'history'"
            role="tab"
            :aria-selected="drawerSection === 'history'"
            :title="'手牌历史'"
            @click="drawerSection = 'history'"
          >
            <span>历史</span>
          </Button>
          <Button
            size="small"
            :severity="drawerSection === 'chat' ? 'help' : 'secondary'"
            :outlined="drawerSection !== 'chat'"
            role="tab"
            :aria-selected="drawerSection === 'chat'"
            :title="'聊天'"
            @click="drawerSection = 'chat'"
          >
            <span>聊天</span>
          </Button>
        </div>

        <section v-if="drawerSection === 'rules'" class="drawer-body" aria-label="规则摘要">
          <h3>本桌规则</h3>
          <dl>
            <div><dt>游戏</dt><dd>无限注德州扑克，52 张牌</dd></div>
            <div><dt>盲注</dt><dd class="num">{{ TABLE_RULES.smallBlind }}/{{ TABLE_RULES.bigBlind }}</dd></div>
            <div>
              <dt>买入范围</dt>
              <dd class="num">
                {{ game.state?.buyInMin ?? TABLE_RULES.startingStack }}–{{
                  game.state?.buyInMax ?? TABLE_RULES.startingStack
                }}（步进 {{ game.state?.buyInStep ?? TABLE_RULES.smallBlind }}，上限由主持人设定）
              </dd>
            </div>
            <div><dt>行动时间</dt><dd>{{ turnSeconds }} 秒，超时自动过牌或弃牌</dd></div>
            <div><dt>离座</dt><dd>离座保留座位与筹码，随时可以坐回；退出房间才释放座位</dd></div>
            <div><dt>牌型大小</dt><dd>同花顺 &gt; 四条 &gt; 葫芦 &gt; 同花 &gt; 顺子 &gt; 三条 &gt; 两对 &gt; 一对 &gt; 高牌</dd></div>
            <div><dt>边池</dt><dd>每个边池只由该池合格玩家争夺</dd></div>
            <div><dt>筹码性质</dt><dd>虚拟分数，不可充值、不可兑换、不可转让</dd></div>
          </dl>
        </section>

        <section v-else-if="drawerSection === 'history'" class="drawer-body" aria-label="手牌历史">
          <h3>手牌历史</h3>
          <template v-if="historyRows.length > 0">
            <p class="hint">已记录 {{ historyRows.length }} 手，最新的在最上面。</p>
            <ul class="history">
              <li v-for="entry in historyRows" :key="entry.handId" class="history-item">
                <p class="history-head">
                  <b class="history-no">第 {{ entry.handNo }} 手</b>
                  <span class="history-pot">
                    <span class="muted">底池</span>
                    <b class="num">{{ entry.potTotal }}</b>
                  </span>
                </p>

                <p class="history-board">
                  <span class="history-board-label">公共牌</span>
                  <span v-if="entry.board.length > 0" class="num board-cards">{{ entry.boardLabel }}</span>
                  <span v-else class="muted">翻牌前结束，未发公共牌</span>
                </p>

                <ul class="history-winners">
                  <li v-for="row in entry.winners" :key="`${row.playerId}-${String(row.potIndex)}`">
                    <span class="winner-name" :class="{ 'is-hero': row.isHero }">{{ row.nickname }}</span>
                    <span class="num winner-amount">+{{ row.amount }}</span>
                    <span class="winner-hand">{{ row.handName ?? (entry.showdown ? '未亮牌' : '未摊牌') }}</span>
                    <span class="winner-pot muted">
                      {{ row.potIndex === 0 ? '主池' : `边池 ${String(row.potIndex)}` }}
                    </span>
                  </li>
                </ul>

                <p v-if="entry.winners.length > 1" class="hint">
                  本手 {{ entry.winners.length }} 位玩家平分底池。
                </p>
                <p v-else-if="!entry.showdown" class="hint">其余玩家弃牌，底牌未公开。</p>
              </li>
            </ul>
          </template>
          <p v-else class="hint">还没有打完的手牌</p>
        </section>

        <section v-else class="drawer-body drawer-body--chat" aria-label="聊天">
          <h3>聊天</h3>

          <!-- 搜索：只过滤展示，不改动消息本身；有关键词时不再插入日期/未读分隔。 -->
          <div class="chat-search">
            <label class="sr-only" for="chat-search">搜索聊天记录</label>
            <InputText
              id="chat-search"
              v-model="chatQuery"
              size="small"
              class="chat-search-input"
              type="search"
              autocomplete="off"
              placeholder="搜索消息…"
            />
            <Button v-if="chatQuery" size="small" text :title="'清除搜索'" @click="chatQuery = ''">
              <i class="pi pi-times" aria-hidden="true" />
              <span>清除</span>
            </Button>
            <span v-if="chatSearchText" class="muted num" role="status">{{ chatSearchText }}</span>
          </div>

          <div
            ref="chatListRef"
            class="chat-list thin-scroll"
            role="log"
            aria-live="polite"
            aria-label="聊天消息"
            @scroll.passive="onChatScroll"
          >
            <!-- 用「有没有可渲染的行」判断，这样搜索无结果也能给出空态 -->
            <ol v-if="chatRows.length > 0" class="chat-msgs">
              <template v-for="row in chatRows" :key="row.key">
                <li v-if="row.kind === 'day'" class="chat-day">
                  <span>{{ row.label }}</span>
                </li>
                <li v-else-if="row.kind === 'gap'" class="chat-gap">
                  <span class="num">{{ row.label }}</span>
                </li>
                <li v-else-if="row.kind === 'unread'" class="chat-unread" role="separator">
                  <span>以下为新消息</span>
                </li>
                <li v-else-if="row.message.kind === 'system'" class="chat-system">
                  <span>{{ row.message.text }}</span>
                  <time class="num" :datetime="chatIso(row.message.at)">{{ chatTime(row.message.at) }}</time>
                </li>
                <li
                  v-else
                  class="chat-msg"
                  :class="{
                    'is-own': isOwnMessage(row.message),
                    'is-mention': mentionsMe(row.message),
                    'is-continuation': !row.groupStart,
                  }"
                >
                  <!-- 组首：昵称 + 提及标记 + 时间。 -->
                  <p v-if="row.groupStart" class="chat-meta">
                    <span class="chat-who">{{ isOwnMessage(row.message) ? '你' : row.message.nickname }}</span>
                    <span v-if="mentionsMe(row.message)" class="chat-mention-tag">提到了你</span>
                    <time
                      class="chat-time num"
                      :datetime="chatIso(row.message.at)"
                      :title="chatFullTime(row.message.at)"
                    >
                      {{ chatTime(row.message.at) }}
                    </time>
                  </p>
                  <!-- 组内后续消息：视觉上共用组首的昵称，但屏幕阅读器仍要听到是谁说的。 -->
                  <p v-else class="sr-only">
                    {{ isOwnMessage(row.message) ? '你' : row.message.nickname }}，{{ chatFullTime(row.message.at) }}
                  </p>
                  <p class="chat-text">{{ row.message.text }}</p>
                </li>
              </template>
            </ol>
            <p v-else class="hint chat-empty">{{ chatQuery ? '没有匹配的消息' : '还没有人说话' }}</p>
          </div>

          <!-- 用户往上翻时出现：跳到底部由用户自己决定，不抢滚动位置。 -->
          <Button v-if="chatHasNews" size="small" text class="chat-jump" :title="'跳到最新消息'" @click="scrollChatToBottom">
            <i class="pi pi-arrow-down" aria-hidden="true" />
            <span>有新消息，跳到最新</span>
          </Button>

          <form class="chat-form" @submit.prevent="submitChat">
            <Button
              type="button"
              size="small"
              text
              :aria-label="'插入 @ 提及'"
              :title="'插入 @ 提及'"
              aria-haspopup="true"
              aria-controls="mention-menu"
              :disabled="mentionItems.length === 0"
              @click="toggleMentionMenu"
            >
              <i class="pi pi-at" aria-hidden="true" />
            </Button>
            <Menu id="mention-menu" ref="mentionMenu" :model="mentionItems" :popup="true" />

            <label class="sr-only" for="chat-input">聊天输入框</label>
            <InputText
              id="chat-input"
              v-model="chatText"
              class="chat-input"
              type="text"
              autocomplete="off"
              :maxlength="CHAT_MAX_LENGTH"
              :placeholder="'说点什么…'"
              aria-describedby="chat-counter"
              @keydown="onChatKeydown"
              @compositionstart="composing = true"
              @compositionend="composing = false"
              @input="chatError = ''"
            />
            <Button type="submit" :disabled="!canSendChat" :title="canSendChat ? '发送消息（Enter）' : '请先输入内容'">
              <i class="pi pi-send" aria-hidden="true" />
              <span>发送</span>
            </Button>
          </form>

          <p id="chat-counter" class="chat-counter muted num">
            还可输入 {{ chatRemaining }} 字（上限 {{ CHAT_MAX_LENGTH }}）
          </p>
          <p v-if="chatError" class="chat-error" role="alert">{{ chatError }}</p>
          <p class="hint">Enter 发送，Shift+Enter 不发送；消息仅本房间可见。</p>
        </section>
      </div>
    </Drawer>

    <!-- 结算叠层：赢家、牌型与各边池分配。 -->
    <HandResultOverlay
      v-if="result"
      :result="result"
      :seats="game.seats"
      :hero-player-id="game.self?.playerId ?? null"
      :visible="overlayVisible"
      @close="closeResult"
      @history="openDrawer('history')"
    />

    <!-- 买入确认：房主定的上限 + 服务端校验的下限/步进 -->
    <Dialog
      v-model:visible="buyInOpen"
      modal
      :header="buyInSeat === null ? '确认买入' : `买入并入座 ${String(buyInSeat + 1)} 号位`"
      :style="{ width: 'min(92vw, 380px)' }"
      @hide="buyInSeat = null"
    >
      <div class="buyin">
        <p class="buyin-line">
          <span class="muted">买入额</span>
          <b class="num">{{ buyInAmount }}</b>
          <span class="muted">筹码</span>
        </p>
        <InputNumber
          v-model="buyInAmount"
          :min="buyInMin"
          :max="buyInMax"
          :step="buyInStep"
          :use-grouping="false"
          show-buttons
          fluid
          aria-label="买入筹码数量"
        />
        <div class="buyin-quick">
          <Button size="small" outlined :title="`最小买入 ${String(buyInMin)}`" @click="buyInAmount = buyInMin">
            <span>最小 {{ buyInMin }}</span>
          </Button>
          <Button
            size="small"
            outlined
            :title="`一半 ${String(Math.round(buyInMax / 2))}`"
            @click="buyInAmount = Math.round(buyInMax / 2 / buyInStep) * buyInStep"
          >
            <span>一半</span>
          </Button>
          <Button size="small" outlined :title="`上限 ${String(buyInMax)}`" @click="buyInAmount = buyInMax">
            <span>上限 {{ buyInMax }}</span>
          </Button>
        </div>
        <p class="hint">
          买入范围 {{ buyInMin }}–{{ buyInMax }}，步进 {{ buyInStep }}。筹码是虚拟分数，不可充值、不可兑换。
        </p>
      </div>
      <template #footer>
        <Button text :title="'取消'" @click="buyInOpen = false"><span>取消</span></Button>
        <Button :title="'确认买入并入座'" @click="confirmBuyIn">
          <i class="pi pi-check" aria-hidden="true" />
          <span>确认买入</span>
        </Button>
      </template>
    </Dialog>

    <!-- 离座确认（本手仍在牌局中会同时弃牌） -->
    <Dialog
      v-model:visible="leaveSeatOpen"
      modal
      header="离座并弃牌？"
      :style="{ width: 'min(92vw, 380px)' }"
    >
      <p class="hint">
        你还在这一手里。离座会同时弃牌，已投入的筹码留在底池。
        座位与筹码会为你保留，随时可以坐回。
      </p>
      <template #footer>
        <Button text :title="'继续打这一手'" @click="leaveSeatOpen = false"><span>继续打</span></Button>
        <Button severity="danger" :title="'离座并弃牌'" @click="leaveSeat">
          <i class="pi pi-sign-out" aria-hidden="true" />
          <span>离座并弃牌</span>
        </Button>
      </template>
    </Dialog>

    <!-- 退出房间确认：真正释放座位（与「离座」不同，会销毁座位里的筹码） -->
    <Dialog
      v-model:visible="exitRoomOpen"
      modal
      header="退出房间？"
      :style="{ width: 'min(92vw, 380px)' }"
    >
      <p class="hint">
        退出会释放你的座位并离开这个房间（座位里的筹码不再保留）。
        只想暂时离开的话请用「离座」——座位与筹码都会留着。
      </p>
      <template #footer>
        <Button text :title="'取消'" @click="exitRoomOpen = false"><span>取消</span></Button>
        <Button severity="danger" :title="'退出房间'" @click="exitRoom">
          <i class="pi pi-times" aria-hidden="true" />
          <span>退出房间</span>
        </Button>
      </template>
    </Dialog>
    </template>
  </div>
</template>

<style scoped>
.table-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.link-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.76rem;
}

.link-state.is-online {
  color: var(--positive);
}

.link-state.is-offline {
  color: var(--danger);
}

.scenario {
  min-width: 132px;
}

.stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-2) var(--space-2) 0;
  min-height: 0;
}

.loading {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--muted);
}

.rotate-hint {
  display: none;
  margin: var(--space-1) var(--space-2) 0;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--muted);
  font-size: 0.78rem;
  gap: 6px;
  align-items: center;
}

.hero {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2) var(--space-2);
}

.hero-cards {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.hero-label {
  font-size: 0.78rem;
  color: var(--muted);
}

.cards {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hero-stack {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  margin-left: auto;
  font-size: 0.86rem;
}

.hero-stack b {
  color: var(--gold);
  font-size: 1rem;
}

.hero-actions {
  width: 100%;
  max-width: 760px;
  margin-inline: auto;
}

.drawer-inner {
  display: flex;
  flex-direction: column;
  /* 不少于抽屉可视高度：内容少时输入区仍贴底，内容多时整段可滚动。 */
  min-height: 100%;
}

.drawer-tabs {
  display: flex;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
}

.drawer-body h3 {
  margin: 0 0 var(--space-1);
  font-size: 0.95rem;
  color: var(--gold);
}

.drawer-body dl {
  display: grid;
  gap: 6px;
  margin: 0;
}

.drawer-body dl div {
  display: flex;
  gap: var(--space-1);
  font-size: 0.84rem;
}

.drawer-body dt {
  min-width: 76px;
  color: var(--muted);
}

.drawer-body dd {
  margin: 0;
}

/* ───────────── 顶栏角标：手数 / 未读数（数字 + aria-label 双重表意） ───────────── */

.count-chip {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--gold-dim);
  color: var(--gold);
  font-size: 0.68rem;
  line-height: 1;
}

.count-chip--unread {
  background: var(--action);
  color: #ffffff;
  font-weight: 700;
}

/* ───────────── 观战者面板（!game.isSeated 时替换「你的底牌」区） ───────────── */

.spectator {
  display: grid;
  gap: 6px;
  padding: var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.spectator-state {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 0.88rem;
}

.spectator-state b {
  color: var(--gold);
  /* 「观战中」在窄屏不折行。 */
  white-space: nowrap;
}

.spectator-seats {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 0.82rem;
}

.spectator-seats b {
  color: var(--text);
}

.spectator-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.spectator .hint {
  font-size: 0.78rem;
}

/* ───────────── 手牌历史（最新在最上面） ───────────── */

.history {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-1) 0 0;
  padding: 0;
  list-style: none;
}

.history-item {
  display: grid;
  gap: 4px;
  padding: var(--space-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.history-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  margin: 0;
  font-size: 0.86rem;
}

.history-no {
  color: var(--gold);
}

.history-pot {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  margin-left: auto;
  font-size: 0.78rem;
}

.history-board {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 0.78rem;
}

.history-board-label {
  color: var(--muted);
}

.board-cards {
  /* 长牌面（5 张）允许换行，不横向撑破抽屉。 */
  overflow-wrap: anywhere;
}

.history-winners {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.8rem;
}

.history-winners li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.winner-name {
  font-weight: 600;
  /* 长昵称截断，避免把金额挤出可视区。 */
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.winner-name.is-hero {
  color: var(--gold);
}

.winner-amount {
  color: var(--positive);
}

.winner-hand,
.winner-pot {
  font-size: 0.74rem;
  color: var(--muted);
}

/* ───────────── 聊天 ───────────── */

.drawer-body--chat {
  display: flex;
  flex-direction: column;
  /* 抽屉高度内部分配：消息列表滚动，输入区固定在底部。 */
  flex: 1;
  gap: 6px;
  min-height: 0;
}

.chat-list {
  flex: 1;
  min-height: 120px;
  max-height: 60vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg);
}

.chat-msgs {
  display: grid;
  /* 组内贴紧、组间留白：间距本身承担「这是一组」的表达，不需要额外装饰。 */
  gap: 2px;
  margin: 0;
  padding: var(--space-1);
  list-style: none;
}

.chat-msg {
  display: grid;
  gap: 2px;
  max-width: 88%;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

/* 同一个人连续发言：组首与上一条拉开距离，组内后续消息紧贴组首。 */
.chat-msg:not(.is-continuation) {
  margin-top: 6px;
}

.chat-msg:first-child {
  margin-top: 0;
}

/* 自己的消息：靠右 + 「你」标记 + 左侧描边，不只靠颜色区分。 */
.chat-msg.is-own {
  justify-self: end;
  border-color: var(--gold-soft);
  border-left-width: 3px;
  text-align: right;
}

.chat-meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 0.72rem;
  color: var(--muted);
}

.chat-msg.is-own .chat-meta {
  flex-direction: row-reverse;
}

.chat-who {
  font-weight: 600;
  color: var(--text);
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-msg.is-own .chat-who {
  color: var(--gold);
}

.chat-text {
  margin: 0;
  font-size: 0.84rem;
  line-height: 1.45;
  /* 长文本与长英文串在气泡内换行，不撑破抽屉。 */
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.chat-empty {
  padding: var(--space-1);
}

.chat-jump {
  justify-self: start;
}

.chat-form {
  display: flex;
  align-items: center;
  gap: 6px;
}

.chat-input {
  flex: 1;
  min-width: 0;
}

.chat-counter {
  margin: 0;
  font-size: 0.72rem;
}

.chat-error {
  margin: 0;
  color: var(--danger);
  font-size: 0.78rem;
}

/* 竖屏窄屏：给出横屏引导；牌桌与操作区保持可用。 */
@media (orientation: portrait) and (max-width: 560px) {
  .rotate-hint {
    display: flex;
  }

  .hero-cards {
    gap: var(--space-1);
  }

  /* 顶栏收成图标按钮，避免换行占掉牌桌高度。 */
  .bar {
    gap: var(--space-1);
    padding: 4px var(--space-1);
  }

  .bar-title {
    font-size: 0.94rem;
  }

  .stat--stage,
  .stat--hand {
    display: none;
  }

  .bar :deep(.p-button) {
    min-width: 40px;
    padding-inline: 10px;
  }

  .bar :deep(.p-button-label) {
    display: none;
  }

  .bar :deep(.p-button > span:not([class])) {
    display: none;
  }

  /* 手数角标窄屏省略（按钮 aria-label 仍带手数）；未读角标始终保留。 */
  .count-chip--history {
    display: none;
  }

  .spectator {
    padding: var(--space-1);
  }

  .chat-list {
    max-height: none;
  }

  .hero-label {
    display: none;
  }

  .hero {
    gap: 6px;
    padding-bottom: var(--space-2);
  }

  .hero-actions :deep(.p-button) {
    font-size: 0.86rem;
  }
}

/* 横屏手机：压缩顶栏与底部区域，把高度让给牌桌。 */
@media (max-height: 430px) {
  .stage {
    padding-top: var(--space-1);
  }

  .bar {
    padding: 2px var(--space-1);
    gap: 6px;
    flex-wrap: nowrap;
  }

  .hero {
    gap: 2px;
    padding: 2px var(--space-2);
  }

  /* 本人底牌靠左竖排，右侧让给倒计时、动作按钮与下注金额。 */
  .hero-cards {
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
  }

  .hero-stack {
    font-size: 0.76rem;
  }

  .hero-label {
    display: none;
  }

  .cards {
    flex-direction: row;
  }

  .cards :deep(.card) {
    --cw: 36px;
  }

  .hero-stack {
    margin-left: 0;
  }

  .hero-actions {
    max-width: none;
  }

  .rotate-hint {
    margin-top: 2px;
  }

  /* 观战面板在矮屏排成一行，把高度让给牌桌。 */
  .spectator {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 6px var(--space-1);
  }

  .spectator-state {
    font-size: 0.82rem;
  }

  /* 说明性提示让位；「座位已满」这类状态提示仍然保留。 */
  .spectator-tip {
    display: none;
  }

  .spectator-actions :deep(.p-button) {
    padding-block: 8px;
  }

  .chat-list {
    max-height: none;
    min-height: 84px;
  }
}

@media (max-height: 430px) and (max-width: 1100px) {
  /* 空间紧张：顶栏带文字的按钮收成纯图标（title 与 aria-label 仍在）。 */
  .bar-title {
    font-size: 0.9rem;
    max-width: 30vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stat--stage,
  .link-state {
    display: none;
  }

  .bar :deep(.p-button) {
    min-width: 40px;
    padding-inline: 10px;
  }

  .bar :deep(.p-button-label) {
    display: none;
  }

  .bar :deep(.p-button > span:not([class])) {
    display: none;
  }

  .scenario {
    min-width: 104px;
  }

  /* 手数角标在矮屏省略（按钮 aria-label 仍带手数）。 */
  .count-chip--history {
    display: none;
  }
}

@media (max-height: 380px) {
  .stat--hand {
    display: none;
  }

  .stage {
    padding-top: 2px;
  }

  .hero {
    padding-bottom: 0;
  }
}
/*
 * 中等宽度收纳：顶栏 6 个按钮在 ≤1000px 会折成两行（实测顶栏 61px → 121px）。
 * ≤1100px 时把二级操作收进「更多」菜单，只保留「开始下一手」与「退出」。
 */
.bar-more {
  display: none;
}

@media (max-width: 1100px) {
  .bar-more {
    display: inline-flex;
  }

  .bar .bar-secondary {
    display: none;
  }
}
/*
 * 更窄（≤820px）：连收纳后的顶栏也放不下，隐藏「阶段」与连接状态文案
 * （阶段在牌桌中央已有显示；连接异常时 ConnectionBanner 会明确提示），
 * 并限制房间名宽度，保证盲注、手数、更多、开始下一手、退出都在一行内。
 */
@media (max-width: 820px) {
  .bar .stat--stage,
  .bar .link-state {
    display: none;
  }

  .bar-title {
    max-width: 26vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

/* 观战者选座：一排小号按钮。窄屏（9 人桌最多 8 个空位）改为横向滚动，
 * 不换行——换行会把底部区域撑高，把牌桌挤掉一截（紧凑标签的通用规则：宁可滚动不折行）。 */
.spectator-seat-picker {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.spectator-seat-picker > .muted {
  flex: none;
}

.seat-picker {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: nowrap;
  gap: 6px;
  min-width: 0;
  /* 滚动容器会裁掉溢出内容，这里留出内边距，键盘焦点环（outline-offset: 2px）不被切掉。 */
  padding: 3px 3px 4px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
}

.seat-picker :deep(.p-button) {
  /* 触控目标不参与收缩：宁可横向滚动，也不把按钮压到 40px 以下。 */
  flex: 0 0 auto;
  min-width: 40px;
  padding-inline: 8px;
}

/* 聊天分组：日期 / 时间间隔 / 未读分隔线。 */
.chat-day,
.chat-gap,
.chat-unread {
  list-style: none;
  text-align: center;
  font-size: 0.72rem;
  color: var(--muted);
  margin: 6px 0 2px;
}

.chat-day span,
.chat-gap span {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
}

.chat-unread {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--gold);
}

.chat-unread::before,
.chat-unread::after {
  content: '';
  flex: 1;
  height: 1px;
  background: currentColor;
  opacity: 0.45;
}

/* 聊天搜索与 @ 提醒。 */
.chat-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.chat-search-input {
  flex: 1;
  min-width: 0;
}

.chat-mention-tag {
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--gold) 26%, transparent);
  color: var(--gold);
  font-size: 0.68rem;
}

.chat-msg.is-mention {
  border-inline-start: 3px solid var(--gold);
  background: color-mix(in srgb, var(--gold) 10%, transparent);
  border-radius: var(--radius-sm);
  padding-inline: 6px;
}

/* 房间事件（系统消息）：居中细线，与玩家发言区分开。 */
.chat-system {
  list-style: none;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 6px;
  margin: 4px 0;
  font-size: 0.72rem;
  color: var(--muted);
  text-align: center;
}

</style>
