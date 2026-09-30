<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Password from 'primevue/password'
import type { ActionType, Card } from '../../shared/poker.ts'
import { ROOM_PASSWORD_DIGITS, STREET_NAMES, TABLE_RULES } from '../../shared/poker.ts'
import { describeHand } from '../../engine/evaluate.ts'
import type { ChatMessage, RoomInfoResponse, RoomMemberPublic } from '../../shared/protocol.ts'
import { CHAT_MAX_LENGTH } from '../../shared/protocol.ts'
import { NICKNAME_MAX } from '../../shared/poker.ts'
import {
  SessionError,
  connectRoom,
  fetchRoomInfo,
  forgetCredentials,
  joinRoom as apiJoinRoom,
  loadCredentials,
  nextRequestId,
  onFatalRoomError,
  sendChat,
  sendCommand,
  useSessionStore,
} from '../net/session.ts'
import ActionBar from '../components/ActionBar.vue'
import ConnectionBanner from '../components/ConnectionBanner.vue'
import HandResultOverlay from '../components/HandResultOverlay.vue'
import NoticeStrip from '../components/NoticeStrip.vue'
import PlayingCard from '../components/PlayingCard.vue'
import PokerTable from '../components/PokerTable.vue'
import RoomConfigDialog from '../components/RoomConfigDialog.vue'
import { copyText } from '../components/clipboard.ts'
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
 * 只有开发模式的 /table/dev 使用模拟数据；真实房间号始终走服务端。
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

const scenario = typeof route.query.mock === 'string' ? route.query.mock : 'flop'
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
 * 接入优先级：本地有房间凭证 → 真实 WebSocket；开发模式的 /table/dev → 模拟场景；
 * 真实房间没有凭证时显示「填昵称加入」面板，加入后先旁观，再选座买入。
 */
onMounted(() => {
  window.addEventListener('pointerdown', handleHudPointerDown)
  const credentials = room.credentials?.roomId === props.roomId ? room.credentials : loadCredentials(props.roomId)
  if (credentials) {
    room.setCredentials(credentials)
    connectRoom(credentials)
    return
  }
  if (isDev && props.roomId === 'dev') {
    void applyScenario(scenario)
    return
  }
  void loadJoinInfo()
})

/* ───────────── 邀请链接：未加入时的「填昵称进桌」 ───────────── */

const joining = ref(false)
const joinNickname = ref(room.nickname || '')
const joinPassword = ref('')
const joinError = ref('')
const joinInfo = ref<RoomInfoResponse | null>(null)
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
  if (!new RegExp(`^\\d{${ROOM_PASSWORD_DIGITS}}$`).test(joinPassword.value)) {
    joinError.value = `请输入 ${String(ROOM_PASSWORD_DIGITS)} 位数字房间密码。`
    return
  }
  joining.value = true
  try {
    const credentials = await apiJoinRoom(props.roomId, { nickname, password: joinPassword.value })
    room.setCredentials(credentials)
    connectRoom(credentials)
  } catch (cause) {
    joinError.value = cause instanceof SessionError ? cause.message : '加入失败，请稍后重试。'
  } finally {
    joining.value = false
  }
}


/* ───────────── 倒计时（以服务端时间为准，高性能低负载时钟） ───────────── */

const remainingSeconds = ref(0)
const remainingRatio = ref(1)
const nextHandRemainingSeconds = ref(0)
const nextHandCountdownVisible = computed(() => game.state?.phase === 'settlement' && game.state.nextHandDeadlineAt != null)
const turnSeconds = computed(() => game.state?.turnSeconds ?? TABLE_RULES.turnSeconds)

let rafId = 0
let lastUpdateSec = -1
let lastUpdateRatioBucket = -1

function tick(): void {
  const deadline = game.state?.turnDeadlineAt
  const nextHandDeadline = game.state?.nextHandDeadlineAt
  if (!deadline && !nextHandDeadline) {
    if (remainingSeconds.value !== 0) remainingSeconds.value = 0
    if (remainingRatio.value !== 0) remainingRatio.value = 0
    if (nextHandRemainingSeconds.value !== 0) nextHandRemainingSeconds.value = 0
    rafId = 0
    return
  }

  const now = Date.now() + connection.clockOffsetMs
  const nextRemMs = nextHandDeadline ? Math.max(0, nextHandDeadline - now) : 0
  const nextSec = Math.ceil(nextRemMs / 1000)
  if (nextHandRemainingSeconds.value !== nextSec) nextHandRemainingSeconds.value = nextSec
  const remMs = deadline ? Math.max(0, deadline - now) : 0
  const sec = Math.ceil(remMs / 1000)
  const totalMs = Math.max(1, turnSeconds.value * 1000)
  const ratio = Math.max(0, Math.min(1, remMs / totalMs))

  if (sec !== lastUpdateSec) {
    lastUpdateSec = sec
    remainingSeconds.value = sec
  }

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

watch(
  [() => game.state?.turnDeadlineAt ?? null, () => game.state?.nextHandDeadlineAt ?? null],
  ([deadline, nextHandDeadline]) => {
    cancelAnimationFrame(rafId)
    rafId = 0
    lastUpdateSec = -1
    lastUpdateRatioBucket = -1
    if (deadline !== null || nextHandDeadline !== null) {
      tick()
    } else {
      remainingSeconds.value = 0
      remainingRatio.value = 0
      nextHandRemainingSeconds.value = 0
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => cancelAnimationFrame(rafId))

/* ───────────── 视图数据 ───────────── */

/** 本人底牌、座位、筹码；全部来自服务端快照，不做本地推算。 */
const myCards = computed<readonly Card[]>(() => game.myHoleCards)
const myStack = computed(() => game.mySeat?.stack ?? 0)

/** 结算叠层手牌保底：即使局末快照重置也能稳定回溯本人本手底牌 */
const savedHeroCards = ref<readonly Card[]>([])
watch(
  () => game.myHoleCards,
  (cards) => {
    if (cards && cards.length > 0) savedHeroCards.value = [...cards]
  },
  { immediate: true },
)
watch(
  () => game.state?.handNo,
  () => {
    if (game.state?.street === 'preflop') {
      savedHeroCards.value = []
    }
  },
)
const activeHeroCards = computed<readonly Card[]>(() =>
  myCards.value.length > 0 ? myCards.value : savedHeroCards.value,
)

/**
 * 一手牌是否处于进行中活跃状态（非 waiting 且非 settlement）。
 * 一手结束后，手牌区域和公牌都不展示上一手的牌，干净等待下一手发牌。
 */
const isHandActive = computed(() => {
  const phase = game.state?.phase
  return phase !== undefined && phase !== null && phase !== 'waiting' && phase !== 'settlement'
})

/** 本人手牌展示：一手结束后不展示上一手手牌，等待下一手发牌。 */
const displayHeroCards = computed<readonly Card[]>(() => {
  if (!isHandActive.value) return []
  return myCards.value
})

/** 牌桌公共牌展示：一手结束后清空上一手公共牌，呈现空牌槽。 */
const displayBoard = computed<readonly Card[]>(() => {
  if (!isHandActive.value) return []
  return game.board
})

/** 牌桌当前轮次：一手结束后置空。 */
const displayStreet = computed(() => {
  if (!isHandActive.value) return null
  return game.state?.street ?? null
})

/** 牌桌座位手牌/亮牌展示：一手结束后清空各席位上一手的摊牌与牌背。 */
const displaySeats = computed(() => {
  if (!isHandActive.value) {
    return game.seats.map((seat) => {
      if (!seat) return null
      return {
        ...seat,
        holeCardCount: 0,
        revealedCards: null,
      }
    })
  }
  return game.seats
})

/**
 * 当前最大牌型文案（「你的底牌」区，紧挨筹码）。
 * 只有手牌活跃且本人手上确实有 2 张底牌时才给出结论，结算后隐藏。
 */
const currentHandName = computed(() =>
  isHandActive.value && displayHeroCards.value.length === 2
    ? describeHand([...displayHeroCards.value, ...displayBoard.value])
    : '',
)

const winnerPlayerIds = computed(() => game.state?.lastResult?.winners.map((winner) => winner.playerId) ?? [])
const highlightCards = computed<readonly Card[]>(() => {
  if (!isHandActive.value) return []
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
  if (game.state.phase === 'settlement') {
    if (!nextHandCountdownVisible.value) return '本手已结束，等待下一手。'
    return nextHandRemainingSeconds.value > 0
      ? `本手已结束，下一手 ${String(nextHandRemainingSeconds.value)} 秒后自动开始。`
      : '本手已结束，下一手即将开始。'
  }
  if (game.mySeat?.folded) return '你已弃牌，本手不再行动。'
  if (game.mySeat?.allIn) return '你已全下，等待发牌与结算。'
  if (game.state.phase === 'waiting') return '等待主持人开局。'
  if (game.state.phase === 'showdown') return '本手已结束，等待结算。'
  if (game.actingSeat) return `等待 ${game.actingSeat.nickname} 行动。`
  return '当前没有需要你处理的动作。'
})

const streetText = computed(() => {
  if (!isHandActive.value) return game.state?.status === 'waiting' ? '等待开局' : '等待下一手发牌'
  const street = game.state?.street
  if (!street) return '等待发牌'
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
watch(
  () => game.state?.nextHandDeadlineAt ?? null,
  (deadline) => {
    if (deadline !== null) announcement.value = `下一手将在 ${String(Math.max(0, Math.ceil((deadline - Date.now() - connection.clockOffsetMs) / 1000)))} 秒后自动开始。`
  },
)

/* ───────────── 交互 ───────────── */

/** 独立邀请朋友弹窗显隐 */
const inviteDialogOpen = ref(false)
const configDialogOpen = ref(false)
/** 桌面右上角 HUD 历史面板折叠状态（默认关闭，点击展开） */
const hudHistoryCollapsed = ref(true)
const hudScoreCollapsed = ref(true)
const scoreRows = computed(() => [...(game.state?.scores ?? [])].sort((a, b) => b.net - a.net || b.totalBuyIn - a.totalBuyIn))
const scoreTotalBuyIn = computed(() => scoreRows.value.reduce((sum, row) => sum + row.totalBuyIn, 0))

/* ── 邀请朋友：房间号是 6 位纯数字（见 §6.8），这里把它和邀请链接摆出来给朋友。 ── */
/** 房间号：以凭证为准；没有凭证（理论上进不了牌桌）时回落到路由里那串。 */
const roomCode = computed(() => room.roomId ?? props.roomId)
/** 邀请链接：store 里已有唯一定义，兜底按当前域名拼一份。 */
const inviteLink = computed(() => room.inviteUrl || `${window.location.origin}/table/${props.roomId}`)
const codeText = ref<HTMLElement | null>(null)
const linkField = ref<{ $el?: HTMLInputElement } | null>(null)
const copyStatus = ref('')

/**
 * 复制房间号 / 邀请链接。
 * 成功 → 「已复制…」；局域网 http 明文下没有剪贴板 API（见 components/clipboard.ts）→
 * 把文字选中并提示用户自己按 Ctrl/⌘ + C，不能让按钮看起来「点了没反应」。
 */
async function copyInvite(kind: 'link' | 'code'): Promise<void> {
  const text = kind === 'link' ? inviteLink.value : roomCode.value
  if ((await copyText(text)) === 'copied') {
    copyStatus.value = kind === 'link' ? '已复制邀请链接' : '已复制房间号'
    return
  }
  if (kind === 'link') {
    linkField.value?.$el?.focus()
    linkField.value?.$el?.select()
  } else if (codeText.value) {
    const range = document.createRange()
    range.selectNodeContents(codeText.value)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  copyStatus.value = '已选中，按 Ctrl/⌘ + C 复制'
}

/** 链接框一获得焦点就全选：这样手按 Ctrl/⌘ + C 也能复制（见 copyInvite 的退路）。 */
function selectLinkValue(event: Event): void {
  const input = event.target as HTMLInputElement
  input.select()
}

/** 关闭或再次打开邀请时清掉上一次的复制反馈，免得回来看到过期的「已复制」。 */
watch(inviteDialogOpen, () => {
  copyStatus.value = ''
})

function openInviteDialog(): void {
  inviteDialogOpen.value = true
}

function toggleHistory(): void {
  hudHistoryCollapsed.value = !hudHistoryCollapsed.value
  if (!hudHistoryCollapsed.value) {
    hudChatCollapsed.value = true
    hudScoreCollapsed.value = true
  }
}

function openHistory(): void {
  hudHistoryCollapsed.value = false
  hudChatCollapsed.value = true
  hudScoreCollapsed.value = true
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

function chatTime(at: number): string {
  return Number.isFinite(at) ? chatTimeFormat.format(at) : ''
}

/* ───────────── 聊天（桌面左上角 HUD 浮层） ─────────────
 * 消息流常驻在牌桌左上角，半透明黑晶背景，支持实时滚屏与快捷打字。默认关闭。 */
const hudChatCollapsed = ref(true)
const hudChatInputRef = ref<HTMLInputElement | null>(null)

/**
 * 历史与聊天面板展开互斥联动：展开一个自动收起另一个
 */
watch(hudHistoryCollapsed, (collapsed) => {
  if (!collapsed) {
    hudChatCollapsed.value = true
    hudScoreCollapsed.value = true
  }
})

watch(hudScoreCollapsed, (collapsed) => {
  if (!collapsed) {
    hudChatCollapsed.value = true
    hudHistoryCollapsed.value = true
  }
})

watch(hudChatCollapsed, (collapsed) => {
  if (!collapsed) {
    hudHistoryCollapsed.value = true
    hudScoreCollapsed.value = true
  }
})

function toggleChat(): void {
  hudChatCollapsed.value = !hudChatCollapsed.value
  if (!hudChatCollapsed.value) {
    hudHistoryCollapsed.value = true
    hudScoreCollapsed.value = true
    nextTick(() => {
      hudChatInputRef.value?.focus()
      void scrollChatToBottom()
    })
  }
}

/** 点击牌桌外部空白区域时，自动顺畅收起已展开的 HUD 浮动面板 */
function handleHudPointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement | null
  if (!target) return
  if (!hudChatCollapsed.value && !target.closest('.hud-chat-anchor')) {
    hudChatCollapsed.value = true
  }
  if (!hudHistoryCollapsed.value && !target.closest('.hud-history-anchor')) {
    hudHistoryCollapsed.value = true
  }
  if (!hudScoreCollapsed.value && !target.closest('.hud-score-anchor')) {
    hudScoreCollapsed.value = true
  }
}

function onSenderClick(nickname: string): void {
  insertMention(nickname)
  hudChatInputRef.value?.focus()
}

const chatText = ref('')
const chatError = ref('')
/** 中文输入法组合期间的回车只用于确认候选词，不能当成发送。 */
const composing = ref(false)

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

const unreadText = computed(() => (chat.unread > 99 ? '99+' : String(chat.unread)))
const chatAria = computed(() => {
  const parts = [chat.unread > 0 ? `聊天，${String(chat.unread)} 条未读消息` : '聊天，没有未读消息']
  const mentions = chat.messages.filter((message) => message.kind === 'user' && mentionsMe(message)).length
  if (mentions > 0) parts.push(`${String(mentions)} 条提到了你`)
  return parts.join('，')
})

/** 监听新消息：在展开状态下自动滚到底部并标记已读 */
watch(
  () => chat.messages.length,
  () => {
    if (!hudChatCollapsed.value) {
      chat.markRead()
      nextTick(() => {
        void scrollChatToBottom()
      })
    }
  },
  { flush: 'post' },
)

watch(hudChatCollapsed, (collapsed) => {
  if (!collapsed) {
    chat.markRead()
    nextTick(() => {
      void scrollChatToBottom()
    })
  }
})



/* ───────────── 手牌历史（抽屉内的 history 分节） ───────────── */

/** 昵称以当前座位快照为准；已离座玩家退化为占位文案。 */
function nicknameOf(playerId: string): string {
  return game.seats.find((seat) => seat?.playerId === playerId)?.nickname ?? '已离座玩家'
}

interface HistoryRevealedPlayer {
  playerId: string
  nickname: string
  isHero: boolean
  isWinner: boolean
  winAmount: number
  cards: Card[]
  handName: string
}

/** 旧→新的服务端历史，展示时反转为最新在最上面。 */
const historyRows = computed(() => {
  const myId = game.self?.playerId
  return [...game.history].reverse().map((entry) => {
    const winners = entry.winners.map((winner) => ({
      ...winner,
      nickname: nicknameOf(winner.playerId),
      isHero: winner.playerId === myId,
    }))

    const heroWinner = winners.find((w) => w.isHero)
    const heroWon = Boolean(heroWinner && heroWinner.amount > 0)
    const heroWonAmount = heroWinner ? heroWinner.amount : 0

    // 整合所有在摊牌阶段亮牌的玩家（包含自己和对手）
    const revealedPlayers: HistoryRevealedPlayer[] = (entry.revealed || []).map((rev) => {
      const winnerMatch = winners.find((w) => w.playerId === rev.playerId)
      return {
        playerId: rev.playerId,
        nickname: nicknameOf(rev.playerId),
        isHero: rev.playerId === myId,
        isWinner: Boolean(winnerMatch && winnerMatch.amount > 0),
        winAmount: winnerMatch ? winnerMatch.amount : 0,
        cards: rev.cards || [],
        handName: rev.handName,
      }
    })

    // 排序：赢家排在最前，其次是本人（若参与了比牌），随后是其他比牌选手
    revealedPlayers.sort((a, b) => {
      if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1
      if (a.isHero !== b.isHero) return a.isHero ? -1 : 1
      return 0
    })

    const heroShowdown = revealedPlayers.some((p) => p.isHero)

    return {
      ...entry,
      board: entry.board || [],
      heroWon,
      heroWonAmount,
      heroShowdown,
      winners,
      revealedPlayers,
    }
  })
})


/* ───────────── 观战者面板 ───────────── */

const occupiedCount = computed(() => game.seats.filter(Boolean).length)
const maxSeats = computed(() => game.state?.maxSeats ?? 0)
const emptyCount = computed(() => Math.max(0, maxSeats.value - occupiedCount.value))
const isTableFull = computed(() => maxSeats.value > 0 && occupiedCount.value >= maxSeats.value)

/** 找到牌桌上的第一个空席位号（0-indexed）；满员或无数据时为 null */
const firstAvailableSeat = computed<number | null>(() => {
  const max = maxSeats.value
  if (max <= 0) return null
  for (let i = 0; i < max; i++) {
    if (!game.seats[i]) return i
  }
  return null
})

/** 观战者是否可以入座：未在座、有空位且已连接到房间 */
const canSitDown = computed(() => !game.isSeated && !isTableFull.value && Boolean(game.self) && firstAvailableSeat.value !== null)


/* 落座前先确认买入额：房主定上限，下限 10 个大盲，步进 = 小盲（服务端同样校验）。 */
const buyInOpen = ref(false)
const buyInSeat = ref<number | null>(null)
const buyInAmount = ref(0)

const buyInMin = computed(() => game.state?.buyInMin ?? 0)
const buyInMax = computed(() => game.state?.buyInMax ?? 0)
const buyInStep = computed(() => game.state?.buyInStep ?? TABLE_RULES.smallBlind)
const canRebuy = computed(() =>
  game.mySeat?.stack === 0 && !game.mySeat.away &&
  (game.state?.phase === 'waiting' || game.state?.phase === 'settlement') && connection.isOnline,
)
const isRebuyDialog = computed(() =>
  buyInSeat.value !== null && buyInSeat.value === game.self?.seat &&
  game.mySeat?.stack === 0 && !game.mySeat.away,
)

/** 打开买入弹窗：默认给满上限（最少点击），下限/上限/步进都来自服务端。 */
function openBuyIn(seat: number): void {
  buyInSeat.value = seat
  buyInAmount.value = buyInMax.value || TABLE_RULES.startingStack
  buyInOpen.value = true
}

function openRebuy(): void {
  const seat = game.self?.seat
  if (seat !== null && seat !== undefined && canRebuy.value) openBuyIn(seat)
}

function confirmBuyIn(): void {
  const seat = buyInSeat.value
  if (seat === null) return
  const rebuy = isRebuyDialog.value
  const amount = Math.round(Number(buyInAmount.value) / buyInStep.value) * buyInStep.value
  if (!sendCommand({ type: 'seat.take', requestId: nextRequestId(), seat, buyIn: amount })) {
    announcement.value = '尚未连接到服务器，入座请求未发送。'
    return
  }
  announcement.value = rebuy
    ? `正在重新买入 ${String(amount)} 筹码。`
    : `正在坐到 ${String(seat + 1)} 号座位，买入 ${String(amount)} 筹码。`
  buyInOpen.value = false
  buyInSeat.value = null
}

/* ── 座位挑选（旁观者与离座者） ── */

/** 本人离座但座位仍被保留（只有本人能坐回）。 */
const mySeatAway = computed(() => game.mySeat?.away ?? false)

/** 本人保留的座位号（离座后仍是本人的座位；没离座则为 null）。 */
const myReservedSeat = computed(() => (mySeatAway.value ? (game.self?.seat ?? null) : null))

/** 能不能在桌面上挑座位：未入座（旁观）或已离座但保留座位。 */
const canPickSeat = computed(() => Boolean(game.self) && (!game.isSeated || mySeatAway.value))

/**
 * 点桌面空位：
 *   - 还没入座（旁观者）→ 弹买入确认（房主设定的买入区间）；
 *   - 已离座、要换座位（第 4 项需求）→ **不弹窗、直接坐下**：筹码跟人走，不用再买入；
 *     只有原筹码为 0（输光了）时才走买入弹窗重新买入。
 *   - 点自己保留的那个位子 → 直接坐回（等价于上面第二条）。
 */
function onPickSeat(seat: number): void {
  const away = mySeatAway.value
  if (away && myReservedStack.value > 0) {
    takeSeatWithoutBuyIn(seat)
    return
  }
  openBuyIn(seat)
}

/**
 * 离座玩家换到任意空位：直接发 seat.take。
 * 服务端会把自己的筹码原样转到新座位（筹码属于玩家，不属于座位）。
 */
function takeSeatWithoutBuyIn(seat: number): void {
  if (
    !sendCommand({
      type: 'seat.take',
      requestId: nextRequestId(),
      seat,
      buyIn: myReservedStack.value,
    })
  ) {
    announcement.value = '尚未连接到服务器，换座请求未发送。'
    return
  }
  announcement.value = `正在坐到 ${String(seat + 1)} 号座位，筹码原样带回。`
}

/* ── 坐回保留座位 / 离座 / 退出房间（第 6 项） ── */

/** 本人保留座位里的筹码：>0 直接坐回，=0 说明输光了，需要重新买入。 */
const myReservedStack = computed(() => game.mySeat?.stack ?? 0)

function resit(): void {
  const seat = game.self?.seat
  if (seat === null || seat === undefined) return
  if (myReservedStack.value > 0) {
    takeSeatWithoutBuyIn(seat)
    return
  }
  // 筹码为 0（输光了）：走买入弹窗，重新买入后再入座。
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

/* ───────────── 主持人移除玩家（room.kick） ─────────────
 * 名单里有旁观者，而公共状态只描述座位，所以打开弹窗时按需向服务端查询一次；
 * 房间成员变化（有人加入/离开）时如果弹窗正开着就自动刷新。 */

const kickOpen = ref(false)
/** 正在二次确认的那一行：确认框就地画在名单里，不引入全局 ConfirmService。 */
const kickTarget = ref<RoomMemberPublic | null>(null)

function seatText(seat: number | null): string {
  return seat === null ? '旁观' : `座位 ${String(seat + 1)}`
}

function requestMembers(): void {
  sendCommand({ type: 'room.members', requestId: nextRequestId() })
}

// 打开弹窗时拉一次名单；开着的时候跟着房间版本号走。
// 版本号在 room.player_left 等广播里都会推进，所以不需要乐观更新本地名单。
watch(
  () => (kickOpen.value ? (game.state?.version ?? 0) : 0),
  () => {
    if (kickOpen.value) requestMembers()
  },
)

function closeKick(): void {
  kickTarget.value = null
  kickOpen.value = false
}

/** 真正发送移除命令（由行内的二次确认触发）。 */
function confirmKick(): void {
  const target = kickTarget.value
  kickTarget.value = null
  if (!target) return
  if (!sendCommand({ type: 'room.kick', requestId: nextRequestId(), playerId: target.playerId })) {
    announcement.value = '尚未连接到服务器，移除请求未发送。'
    return
  }
  announcement.value = `已请求移除 ${target.nickname}。`
  // 名单只认服务端：room.player_left 广播后客户端会重新拉一次，
  // 这里不做乐观更新，免得被拒绝时名单已经少了一行。
  requestMembers()
}

/**
 * 致命错误（被移除 / 房间关闭 / 房间不存在）统一收敛到 session.ts：
 * 它已经停掉了重连与本地会话，这里只负责清凭证并离开牌桌页，
 * 否则牌桌会停在「正在载入牌局」并不断重连。
 */
onFatalRoomError((error) => {
  kickOpen.value = false
  room.clear()
  // 连本地保存的凭证一起清掉：留着他下次打开这个链接还会拿旧身份去连，再被拒一次。
  forgetCredentials(props.roomId)
  void router.push({
    name: 'error',
    query: { kind: 'room', code: error.code, detail: error.message },
  })
})
onBeforeUnmount(() => {
  onFatalRoomError(null)
  window.removeEventListener('pointerdown', handleHudPointerDown)
})

</script>

<template>
  <div class="table-view">
    <!-- 邀请链接落地页：还没加入这个房间，先填昵称进桌（进去后是旁观者，自己选座买入）。
         开发模式的模拟场景用 game.state 判定，不会被这块面板挡住。 -->
    <!-- 手机横屏遮罩：只在 (orientation: landscape) 且高度 ≤560px 时显示。 -->
    <section class="portrait-only" aria-label="请竖屏使用">
      <div>
        <p class="portrait-only-mark" aria-hidden="true">📱</p>
        <h1 class="portrait-only-title">请竖屏使用</h1>
        <p class="portrait-only-text">
          手机版只支持竖屏：把手机转回竖直方向即可继续这桌牌局，进度不会丢。
        </p>
      </div>
    </section>

    <main v-if="!room.hasCredentials && !game.state" id="main" class="join-gate">
      <!-- 扑克花色浮雕背景与环境聚光氛围 -->
      <div class="join-backdrop" aria-hidden="true">
        <div class="join-ambient-glow" />
        <div class="join-card-suits">
          <span>♠</span>
          <span>♥</span>
          <span>♦</span>
          <span>♣</span>
        </div>
      </div>

      <div class="join-container">
        <section class="join-card" aria-labelledby="join-gate-title">
          <header class="join-header">
            <div class="badge-tag">
              <span class="badge-icon">♠</span>
              <span>私人牌局 · 邀请制</span>
              <span class="badge-icon">♣</span>
            </div>
            <h1 id="join-gate-title" class="join-title">
              {{ joinInfo ? `加入「${joinInfo.roomName}」` : '加入这桌牌局' }}
            </h1>
            <p class="join-subtitle">
              朋友邀请你入局切磋，填入昵称与密码即可进桌
            </p>
          </header>

          <!-- 房间对局核心参数卡片 -->
          <div v-if="joinInfo" class="room-meta-card">
            <div class="meta-grid">
              <div class="meta-item">
                <span class="meta-item-label">房间号</span>
                <span class="meta-item-val num">#{{ joinInfo.roomId }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-item-label">盲注级别</span>
                <span class="meta-item-val num text-gold">{{ joinInfo.smallBlind }}/{{ joinInfo.bigBlind }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-item-label">当前入座</span>
                <span class="meta-item-val num">{{ joinInfo.seated }}/{{ joinInfo.maxSeats }} 人</span>
              </div>
              <div class="meta-item">
                <span class="meta-item-label">牌桌状态</span>
                <span class="meta-item-val meta-status">
                  <span class="status-dot" :class="{ 'is-waiting': joinInfo.status !== 'playing' }" />
                  <span>{{ joinInfo.status === 'playing' ? '对局中' : '等待开局' }}</span>
                </span>
              </div>
            </div>
            <div class="meta-tip">
              <i class="pi pi-info-circle meta-tip-icon" aria-hidden="true" />
              <span>进桌后先以旁观身份观战，点击桌上任意空位即可买入落座参赛</span>
            </div>
          </div>

          <!-- 房间信息加载中骨架 -->
          <div v-else-if="!joinInfoError" class="room-meta-loading">
            <i class="pi pi-spin pi-spinner loading-icon" aria-hidden="true" />
            <span>正在连接房间，读取对局信息…</span>
          </div>

          <!-- 房间信息获取错误提示 -->
          <div v-else class="join-info-error-box" role="alert">
            <i class="pi pi-exclamation-triangle join-info-error-icon" aria-hidden="true" />
            <div class="join-info-error-content">
              <p class="join-info-error-title">房间状态提示</p>
              <p class="join-info-error-desc">{{ joinInfoError }}</p>
            </div>
          </div>

          <!-- 表单报错横条 -->
          <transition name="alert-slide">
            <Message v-if="joinError" severity="error" :closable="false" class="join-alert" role="alert">
              {{ joinError }}
            </Message>
          </transition>

          <!-- 昵称与密码输入 -->
          <div class="join-form">
            <label class="field" for="join-nickname">
              <span class="label">
                <span>你的昵称</span>
                <span class="label-sub">在桌内展示给其他牌友</span>
              </span>
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

            <label class="field" for="invite-password">
              <span class="label">
                <span>房间密码</span>
                <span class="label-sub">{{ ROOM_PASSWORD_DIGITS }} 位数字</span>
              </span>
              <Password
                input-id="invite-password"
                v-model="joinPassword"
                placeholder="请输入 6 位数字"
                autocomplete="current-password"
                :feedback="false"
                toggle-mask
                :input-props="{ inputmode: 'numeric', maxlength: ROOM_PASSWORD_DIGITS, pattern: '[0-9]{6}' }"
                fluid
                @keyup.enter="submitJoin"
              />
            </label>
          </div>

          <!-- 操作按钮区 -->
          <div class="join-actions">
            <Button
              class="submit-button join-submit-btn"
              :disabled="joining || Boolean(joinInfoError)"
              :loading="joining"
              title="加入这个房间"
              @click="submitJoin"
            >
              <i class="pi pi-sign-in" aria-hidden="true" />
              <span>进入牌桌</span>
            </Button>
            <Button
              text
              class="join-back-btn"
              title="回到大厅"
              @click="router.push({ name: 'lobby' })"
            >
              <i class="pi pi-home" aria-hidden="true" />
              <span>回大厅</span>
            </Button>
          </div>

          <!-- 入桌须知 -->
          <div class="join-rules-box">
            <div class="rules-header">
              <i class="pi pi-shield rules-icon" aria-hidden="true" />
              <span>入桌须知</span>
            </div>
            <ul class="rules-list">
              <li>进桌后先以旁观身份观战，点击桌上任意空位即可买入落座。</li>
              <li>仅支持虚拟记分筹码，无任何充值提现或兑换，绿色对局。</li>
              <li>断线或刷新网页将保留座位与筹码，重新进入可自动恢复。</li>
            </ul>
          </div>
        </section>
      </div>
    </main>

    <template v-else>
    <ConnectionBanner />

    <!-- 顶部：房间名、盲注、连接状态、设置与退出（规格书 §3.3）。 -->
    <header class="bar hud-header">
      <div class="hud-left">
        <div class="room-badge">
          <i class="pi pi-shield room-badge-icon" aria-hidden="true" />
          <h1 class="bar-title">{{ game.state?.roomName || '牌桌' }}</h1>
          <span v-if="room.isHost" class="host-label">你是房主</span>
        </div>
        <div class="meta-capsules">
          <span class="stat meta-pill meta-pill--blind">
            <span class="meta-label">盲注</span>
            <b class="num">{{ game.state?.smallBlind ?? TABLE_RULES.smallBlind }}/{{ game.state?.bigBlind ?? TABLE_RULES.bigBlind }}</b>
          </span>
          <span class="stat stat--hand meta-pill meta-pill--hand">
            <span class="meta-label">第</span>
            <b class="num">{{ game.state?.handNo ?? 0 }}</b>
            <span>手</span>
          </span>
          <span class="stat stat--stage meta-pill meta-pill--stage" :class="`stage--${game.state?.street ?? 'wait'}`">
            <span class="meta-label">阶段</span>
            <b class="stage-name">{{ streetText }}</b>
          </span>
        </div>
        <span
          class="link-state"
          :class="connection.isOnline ? 'is-online' : 'is-offline'"
          role="status"
        >
          <i :class="connection.isOnline ? 'pi pi-wifi' : 'pi pi-exclamation-triangle'" aria-hidden="true" />
          <span>{{ connection.isOnline ? '已连接' : '连接异常' }}</span>
        </span>
      </div>

      <span class="bar-spacer" />


      <!-- 顶栏右侧操作区：只保留分享按钮 -->
      <div class="bar-right" role="toolbar" aria-label="牌桌快捷工具栏">
        <Button v-if="room.isHost" size="small" text class="bar-btn" aria-label="牌局配置" title="修改牌局配置" @click="configDialogOpen = true">
          <i class="pi pi-cog" aria-hidden="true" />
          <span class="bar-btn-text">配置</span>
        </Button>
        <!-- 分享按钮：快捷桌牌与复制入口 -->
        <Button
          size="small"
          text
          class="bar-btn bar-btn--invite"
          aria-label="分享房间"
          :title="'分享房间：房间号与邀请链接'"
          @click="openInviteDialog"
        >
          <i class="pi pi-share-alt" aria-hidden="true" />
          <span class="bar-btn-text">分享</span>
        </Button>
      </div>
    </header>

    <!-- 屏幕阅读器公告区：超时、断线、轮到自己。 -->
    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement }}</p>

    <!--
      notice-slot：给通知条预留固定高度（单行 32px）。
      通知条本身按内容增高（0～2 行），若不预留，它一出现就把牌桌往下推、
      竖屏立刻开始整页滚动（实测 360×740 溢出 43px）。预留成本只有 32px，
      换来「有没有通知，牌桌位置都不变」。
    -->
    <div class="notice-slot">
      <div v-if="nextHandCountdownVisible" class="next-hand-notice">
        <i class="pi pi-clock" aria-hidden="true" />
        <span>下一手 {{ nextHandRemainingSeconds > 0 ? `${String(nextHandRemainingSeconds)} 秒后自动开始` : '即将开始' }}</span>
      </div>
      <NoticeStrip v-else
        :notice="noticeText"
        :version="game.state?.version ?? 0"
        :my-nickname="game.mySeat?.nickname ?? ''"
      />
    </div>

    <main id="main" class="stage">
      <!-- 桌面左上角 HUD 快捷聊天 -->
      <aside class="hud-anchor hud-chat-anchor" aria-label="牌桌快捷聊天">
        <button
          type="button"
          class="hud-capsule-btn hud-chat-pill"
          :class="{ 'is-active': !hudChatCollapsed }"
          :title="hudChatCollapsed ? '展开聊天' : '收起聊天'"
          :aria-label="chatAria"
          :aria-expanded="!hudChatCollapsed"
          @click="toggleChat"
        >
          <i class="pi pi-comments hud-capsule-icon" aria-hidden="true" />
          <span class="hud-capsule-label">聊天</span>
          <span v-if="chat.unread > 0" class="hud-capsule-badge num">{{ unreadText }}</span>
          <i :class="hudChatCollapsed ? 'pi pi-chevron-down' : 'pi pi-chevron-up'" class="hud-capsule-arrow" aria-hidden="true" />
        </button>

        <Transition name="hud-popover">
          <div v-show="!hudChatCollapsed" class="hud-popover hud-chat-popover">
            <header class="hud-popover-header">
              <div class="hud-popover-title">
                <i class="pi pi-comments" aria-hidden="true" />
                <span>牌桌聊天</span>
                <span v-if="chat.unread > 0" class="hud-popover-badge num">{{ unreadText }}</span>
              </div>
              <button
                type="button"
                class="hud-popover-close-btn"
                title="收起聊天"
                aria-label="收起聊天"
                @click="hudChatCollapsed = true"
              >
                <i class="pi pi-times" aria-hidden="true" />
              </button>
            </header>

            <div class="hud-chat-body">
              <div
                ref="chatListRef"
                class="hud-chat-list thin-scroll"
                role="log"
                aria-live="polite"
                aria-label="聊天消息"
                @scroll.passive="onChatScroll"
              >
                <div v-if="chat.messages.length === 0" class="hud-chat-empty">
                  <span>暂无消息，打个招呼吧~</span>
                </div>
                <div
                  v-for="msg in chat.messages"
                  :key="msg.id"
                  class="hud-chat-item"
                  :class="{
                    'is-own': msg.playerId === myPlayerId,
                    'is-system': msg.kind === 'system',
                    'is-mention': mentionsMe(msg),
                  }"
                  :title="chatTime(msg.at)"
                >
                  <template v-if="msg.kind === 'system'">
                    <span class="hud-msg-system">📢 {{ msg.text }}</span>
                  </template>
                  <template v-else>
                    <span
                      class="hud-msg-sender"
                      :title="`点击 @${msg.nickname}`"
                      @click="onSenderClick(msg.nickname)"
                    >
                      {{ msg.playerId === myPlayerId ? '你' : msg.nickname }}:
                    </span>
                    <span class="hud-msg-text">{{ msg.text }}</span>
                  </template>
                </div>
              </div>

              <form class="hud-chat-form" @submit.prevent="submitChat">
                <input
                  ref="hudChatInputRef"
                  v-model="chatText"
                  type="text"
                  class="hud-chat-input"
                  :maxlength="CHAT_MAX_LENGTH"
                  placeholder="说点什么… (Enter)"
                  autocomplete="off"
                  @keydown="onChatKeydown"
                  @compositionstart="composing = true"
                  @compositionend="composing = false"
                  @input="chatError = ''"
                />
                <button
                  type="submit"
                  class="hud-chat-send"
                  :disabled="!canSendChat"
                  :title="canSendChat ? '发送消息' : '请输入消息'"
                >
                  <i class="pi pi-send" aria-hidden="true" />
                </button>
              </form>
              <p v-if="chatError" class="hud-chat-error" role="alert">{{ chatError }}</p>
            </div>
          </div>
        </Transition>
      </aside>

      <!-- 本桌累计计分板：曾入座者离桌后仍显示。 -->
      <aside class="hud-anchor hud-score-anchor" aria-label="牌桌计分板">
        <button
          type="button"
          class="hud-capsule-btn hud-score-pill"
          :class="{ 'is-active': !hudScoreCollapsed }"
          :title="hudScoreCollapsed ? '展开计分板' : '收起计分板'"
          :aria-expanded="!hudScoreCollapsed"
          @click="hudScoreCollapsed = !hudScoreCollapsed"
        >
          <i class="pi pi-chart-bar hud-capsule-icon" aria-hidden="true" />
          <span class="hud-capsule-label">计分板</span>
          <i :class="hudScoreCollapsed ? 'pi pi-chevron-down' : 'pi pi-chevron-up'" class="hud-capsule-arrow" aria-hidden="true" />
        </button>
        <Transition name="hud-score-popover">
          <div v-show="!hudScoreCollapsed" class="hud-popover hud-score-popover">
            <header class="hud-popover-header">
              <div class="hud-popover-title"><i class="pi pi-chart-bar" aria-hidden="true" /><span>本桌计分板</span></div>
              <button type="button" class="hud-popover-close-btn" title="收起计分板" aria-label="收起计分板" @click="hudScoreCollapsed = true">
                <i class="pi pi-times" aria-hidden="true" />
              </button>
            </header>
            <div class="hud-score-summary">{{ scoreRows.length }} 位玩家 · 累计买入 <b class="num">{{ scoreTotalBuyIn }}</b></div>
            <div class="hud-score-scroll thin-scroll">
              <p v-if="scoreRows.length === 0" class="hud-score-empty">暂无入座记录</p>
              <table v-else class="hud-score-table">
                <thead><tr><th scope="col">玩家</th><th scope="col">净筹码</th><th scope="col">总买入</th><th scope="col">现有</th><th scope="col">带离</th><th scope="col">手数</th></tr></thead>
                <tbody>
                  <tr v-for="row in scoreRows" :key="row.playerId">
                    <th scope="row"><span>{{ row.nickname }}</span><small>{{ row.seated ? '在桌' : '已离桌' }} · 买入 {{ row.buyInCount }} 次</small></th>
                    <td class="num" :class="row.net > 0 ? 'score-up' : row.net < 0 ? 'score-down' : ''">{{ row.net > 0 ? '+' : '' }}{{ row.net }}</td>
                    <td class="num">{{ row.totalBuyIn }}</td>
                    <td class="num">{{ row.stack }}</td>
                    <td class="num">{{ row.banked }}</td>
                    <td class="num">{{ row.handsPlayed }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="hud-score-note">虚拟筹码 · 净筹码 = 现有 + 带离 − 总买入；进行中随下注变化</p>
          </div>
        </Transition>
      </aside>

      <!-- 桌面右上角 HUD 快捷手牌历史 -->
      <aside class="hud-anchor hud-history-anchor" aria-label="牌局手牌历史">
        <button
          type="button"
          class="hud-capsule-btn hud-history-pill"
          :class="{ 'is-active': !hudHistoryCollapsed }"
          :title="hudHistoryCollapsed ? '展开历史' : '收起历史'"
          :aria-expanded="!hudHistoryCollapsed"
          @click="toggleHistory"
        >
          <i class="pi pi-history hud-capsule-icon" aria-hidden="true" />
          <span class="hud-capsule-label">手牌历史</span>
          <span v-if="game.history.length > 0" class="hud-capsule-badge num">{{ game.history.length }}</span>
          <i :class="hudHistoryCollapsed ? 'pi pi-chevron-down' : 'pi pi-chevron-up'" class="hud-capsule-arrow" aria-hidden="true" />
        </button>

        <Transition name="hud-popover-right">
          <div v-show="!hudHistoryCollapsed" class="hud-popover hud-history-popover">
            <header class="hud-popover-header">
              <div class="hud-popover-title">
                <i class="pi pi-history" aria-hidden="true" />
                <span>手牌历史</span>
                <span v-if="game.history.length > 0" class="hud-popover-badge num">{{ game.history.length }}</span>
              </div>
              <button
                type="button"
                class="hud-popover-close-btn"
                title="收起历史"
                aria-label="收起历史"
                @click="hudHistoryCollapsed = true"
              >
                <i class="pi pi-times" aria-hidden="true" />
              </button>
            </header>

            <div class="hud-history-body">
              <div class="hud-history-list thin-scroll">
                <div v-if="historyRows.length === 0" class="history-empty">
                  <i class="pi pi-folder-open history-empty-icon" aria-hidden="true" />
                  <p>暂无已结算的手牌记录</p>
                </div>

                <article
                  v-for="entry in historyRows"
                  :key="entry.handId || entry.handNo"
                  class="history-card"
                  :class="{ 'is-hero-won': entry.heroWon, 'is-hero-showdown': entry.heroShowdown && !entry.heroWon }"
                >
                  <!-- 卡片顶栏：局号、状态勋章、总底池 -->
                  <header class="history-card-header">
                    <div class="history-header-left">
                      <span class="history-hand-tag num">#{{ entry.handNo }}</span>
                      <span v-if="entry.heroWon" class="history-result-badge badge-win">
                        <i class="pi pi-trophy" aria-hidden="true" />
                        <span>你赢得 +{{ entry.heroWonAmount }}</span>
                      </span>
                      <span v-else-if="entry.heroShowdown" class="history-result-badge badge-showdown">
                        跟注到底
                      </span>
                      <span v-else-if="entry.showdown" class="history-result-badge badge-neutral">
                        摊牌对决
                      </span>
                      <span v-else class="history-result-badge badge-fold">
                        弃牌结算
                      </span>
                    </div>
                    <div class="history-header-right">
                      <span class="history-pot-label">总底池</span>
                      <b class="history-pot-value num">{{ entry.potTotal }}</b>
                    </div>
                  </header>

                  <!-- 公共牌区域（真实卡牌组件渲染） -->
                  <div class="history-board-row">
                    <span class="history-section-title">公共牌</span>
                    <div v-if="entry.board.length > 0" class="history-cards-line">
                      <PlayingCard
                        v-for="card in entry.board"
                        :key="card"
                        size="sm"
                        upright
                        :card="card"
                        class="history-card-item"
                      />
                    </div>
                    <span v-else class="history-empty-board">翻牌前弃牌（无公共牌）</span>
                  </div>

                  <!-- 摊牌明细（若有人跟到底开牌） -->
                  <div v-if="entry.showdown && entry.revealedPlayers.length > 0" class="history-showdown-section">
                    <div class="history-section-header">
                      <span class="history-section-title">摊牌开牌（{{ entry.revealedPlayers.length }} 人亮牌比牌）</span>
                    </div>
                    <div class="history-revealed-list">
                      <div
                        v-for="p in entry.revealedPlayers"
                        :key="p.playerId"
                        class="history-revealed-row"
                        :class="{ 'is-hero': p.isHero, 'is-winner': p.isWinner }"
                      >
                        <!-- 玩家身份与牌型 -->
                        <div class="revealed-player-info">
                          <div class="revealed-player-name-row">
                            <span v-if="p.isWinner" class="revealed-crown" title="获胜者">🏆</span>
                            <span class="revealed-nickname" :class="{ 'hero-name': p.isHero }">
                              {{ p.isHero ? '你' : p.nickname }}
                            </span>
                            <span v-if="p.isWinner" class="revealed-win-num num">
                              +{{ p.winAmount }}
                            </span>
                          </div>
                          <div class="revealed-hand-badge" :class="{ 'badge-winner': p.isWinner }">
                            {{ p.handName }}
                          </div>
                        </div>

                        <!-- 玩家亮出的 2 张底牌（物理卡牌） -->
                        <div class="revealed-cards-box">
                          <PlayingCard
                            v-for="c in p.cards"
                            :key="c"
                            size="sm"
                            upright
                            :card="c"
                            :class="['revealed-card', { 'winner-card': p.isWinner }]"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- 未摊牌获胜展示（对手全弃牌） -->
                  <div v-else class="history-uncontested-section">
                    <div v-for="w in entry.winners" :key="w.playerId" class="history-uncontested-winner">
                      <span class="uncontested-crown">🏆</span>
                      <span class="uncontested-name" :class="{ 'hero-name': w.isHero }">
                        {{ w.isHero ? '你' : w.nickname }}
                      </span>
                      <span class="uncontested-text">拿下底池</span>
                      <b class="uncontested-amount num">+{{ w.amount }}</b>
                      <span class="uncontested-note">（其他玩家弃牌，底牌未公开）</span>
                    </div>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </Transition>
      </aside>

      <PokerTable
        v-if="game.state && !unavailable"
        :seats="displaySeats"
        :max-seats="game.state.maxSeats"
        :board="displayBoard"
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
        :street="displayStreet"
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

    <!-- 底部：一体化沉浸式玩家座舱（Hero Cockpit） -->
    <footer v-if="!unavailable" class="hero">
      <!-- 1. 玩家在座状态（Hero Cockpit） -->
      <div v-if="game.isSeated && !mySeatAway" class="hero-cards hero-cockpit">
        <!-- 左翼：玩家底牌展示与状态资产面板 -->
        <div class="cockpit-wing cockpit-wing--hero">
          <div class="cockpit-cards-group">
            <span class="hero-label sr-only">你的底牌</span>
            <div
              class="cards fan-cards"
              :title="currentHandName ? `你的手牌（${currentHandName}）` : isHandActive ? '你的底牌' : '等待发牌…'"
            >
              <div
                v-for="cardIdx in [0, 1]"
                :key="`hero-flipper-${cardIdx}`"
                class="hero-card-flipper"
                :class="[
                  `fan-card--${cardIdx}`,
                  {
                    'is-flipped': isHandActive && Boolean(displayHeroCards[cardIdx]),
                    'is-dim': Boolean(game.mySeat?.folded),
                  },
                ]"
              >
                <div class="hero-card-inner">
                  <!-- 背面（等待下一手发牌时朝向玩家） -->
                  <div class="hero-card-face hero-card-face--back">
                    <PlayingCard size="lg" upright hidden />
                  </div>
                  <!-- 正面（新一手发牌后 3D 翻转朝向玩家） -->
                  <div class="hero-card-face hero-card-face--front">
                    <PlayingCard
                      size="lg"
                      upright
                      :card="displayHeroCards[cardIdx] ?? myCards[cardIdx] ?? null"
                      :dimmed="Boolean(game.mySeat?.folded)"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="cockpit-meta-group">
            <div class="cockpit-badge-row">
              <!-- 当前牌型勋章 -->
              <div v-if="currentHandName" class="hero-hand" :title="currentHandName">
                <span class="hand-icon" aria-hidden="true">♦</span>
                <b class="hand-name">{{ currentHandName }}</b>
              </div>

              <!-- 筹码资产胶囊 -->
              <div class="hero-stack" :title="`可用筹码：${myStack}`">
                <span class="stack-label">筹码</span>
                <b class="num stack-num">{{ myStack }}</b>
                <Button
                  v-if="game.mySeat && myStack === 0 && !mySeatAway"
                  size="small"
                  outlined
                  class="rebuy-btn"
                  :disabled="!canRebuy"
                  :title="canRebuy ? '按本桌买入范围重新买入' : '本手结束并连接后可以重新买入'"
                  @click="openRebuy"
                >
                  <i class="pi pi-plus" aria-hidden="true" />
                  <span>重新买入</span>
                </Button>
              </div>
            </div>

            <!-- 房主开局控制与席位操作 -->
            <div class="hero-seat-actions">
              <Button
                v-if="canStartNextHand"
                severity="success"
                class="hero-start-btn"
                :title="hasPlayedHand ? '开始下一手牌' : '开始第一手牌'"
                :aria-label="hasPlayedHand ? '开始下一手' : '开始牌局'"
                @click="startNextHand"
              >
                <i class="pi pi-play" aria-hidden="true" />
                <span>{{ hasPlayedHand ? '开始下一手' : '开始牌局' }}</span>
              </Button>
              <Button size="small" class="sub-action-btn sub-action-btn--leave" :title="'离座（座位与筹码为你保留）'" @click="requestLeaveSeat">
                <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="13" cy="4" r="1.8" />
                  <line x1="7" y1="21" x2="10" y2="17" />
                  <path d="M16 21l-2-4-3-3 1-6" />
                  <path d="M6 12l2-3 4-1 3 3 3 1" />
                </svg>
                <span class="sub-btn-text">离座</span>
              </Button>
              <Button size="small" class="sub-action-btn sub-action-btn--exit" :title="'退出房间（释放座位）'" @click="exitRoomOpen = true">
                <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                <span class="sub-btn-text">退出房间</span>
              </Button>
            </div>
          </div>
        </div>

        <!-- 纵向微晶金线分隔器（宽屏展示） -->
        <div class="cockpit-divider" aria-hidden="true" />

        <!-- 右翼：战术行动与下注控制台（ActionBar 深度熔铸） -->
        <div class="cockpit-wing cockpit-wing--action">
          <ActionBar
            :legal-actions="game.myLegalActions"
            :pot-total="potTotal"
            :current-bet="game.state?.currentBet ?? 0"
            :my-stack="myStack"
            :is-my-turn="game.isMyTurn"
            :remaining-seconds="remainingSeconds"
            :turn-seconds="turnSeconds"
            :remaining-ratio="remainingRatio"
            :turn-deadline-at="game.state?.turnDeadlineAt ?? null"
            :clock-offset-ms="connection.clockOffsetMs"
            :blocked-reason="blockedReason"
            :enabled="connection.isOnline"
            :can-start-hand="canStartNextHand"
            :has-played-hand="hasPlayedHand"
            :seated="game.isSeated"
            @action="submitAction"
            @start="startNextHand"
            @leave="requestLeaveSeat"
            @exit="exitRoomOpen = true"
          />
        </div>
      </div>

      <!-- 2. 离座中状态 -->
      <div v-else-if="game.isSeated && mySeatAway" class="hero-spectator hero-spectator--away">
        <div class="spectator-card">
          <div class="spectator-info">
            <i class="pi pi-pause-circle spectator-icon" aria-hidden="true" />
            <div class="spectator-texts">
              <h3 class="spectator-title">你当前处于离座托管状态</h3>
              <p class="spectator-desc">
                你的位置与 <span class="num">{{ myStack }}</span> 筹码已为你妥善锁定
              </p>
            </div>
          </div>
          <div class="spectator-actions">
            <Button severity="success" class="return-seat-btn" :title="'坐回牌桌继续行动'" @click="resit">
              <svg class="btn-action-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3" />
                <path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z" />
                <path d="M5 18v2" />
                <path d="M19 18v2" />
              </svg>
              <span>坐回牌桌</span>
            </Button>
            <Button severity="secondary" outlined :title="'退出房间'" @click="exitRoomOpen = true">
              <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span>退出房间</span>
            </Button>
          </div>
        </div>
      </div>

      <!-- 3. 贵宾观战状态（未入座） -->
      <div v-else class="hero-spectator">
        <div class="spectator-card">
          <div class="spectator-info">
            <i class="pi pi-eye spectator-icon" aria-hidden="true" />
            <div class="spectator-texts">
              <div class="spectator-heading">
                <h3 class="spectator-title">贵宾观战席</h3>
                <span class="spectator-badge">观战中</span>
              </div>
              <p class="spectator-desc">
                <template v-if="canSitDown">
                  <span class="spectator-copy-desktop">牌桌尚有 <b class="num empty-num">{{ emptyCount }}</b> 个空席（共 {{ maxSeats }} 席），轻触桌上空位或点击右侧快速入座</span>
                  <span v-if="occupiedCount === 0" class="spectator-copy-mobile">还没有人入座。先选座，再邀请朋友开局。</span>
                  <span v-else class="spectator-copy-mobile">还有 {{ emptyCount }} 个空位，点桌面空位或下方按钮入座。</span>
                </template>
                <template v-else-if="isTableFull">
                  牌桌已满（{{ occupiedCount }}/{{ maxSeats }} 席），空位出现后即可入座。
                </template>
                <template v-else>
                  正在读取牌桌状态，请稍候…
                </template>
              </p>
            </div>
          </div>
          <div class="spectator-actions">
            <Button
              v-if="canSitDown && firstAvailableSeat !== null"
              severity="help"
              class="quick-sit-btn"
              :title="'快速入座'"
              @click="openBuyIn(firstAvailableSeat)"
            >
              <i class="pi pi-user-plus" aria-hidden="true" />
              <span>入座 {{ firstAvailableSeat + 1 }} 号席</span>
            </Button>
            <Button severity="secondary" outlined :title="'退出房间'" @click="exitRoomOpen = true">
              <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span>返回大厅</span>
            </Button>
          </div>
        </div>
      </div>
    </footer>
    <!-- 专属邀请朋友弹窗 -->
    <RoomConfigDialog v-if="room.isHost && game.state" v-model:visible="configDialogOpen" :state="game.state" />
    <Dialog
      v-model:visible="inviteDialogOpen"
      modal
      :dismissable-mask="true"
      class="vip-dialog vip-hub-dialog"
      :style="{ width: 'min(92vw, 560px)' }"
      header="邀请朋友"
    >
      <div class="drawer-pane invite-pane">
        <div class="invite-banner">
          <i class="pi pi-sparkles invite-icon" aria-hidden="true" />
          <div class="invite-banner-texts">
            <h4 class="invite-title">邀请好友同桌竞技</h4>
            <p class="invite-desc">支持局域网或内网直连，分享房间号或链接即可快速加入</p>
          </div>
        </div>

        <div class="invite-card">
          <span class="invite-label">房间号</span>
          <div class="invite-code-box">
            <b ref="codeText" class="invite-code num">{{ roomCode }}</b>
            <Button size="small" outlined class="copy-btn" :title="'复制房间号'" @click="copyInvite('code')">
              <i class="pi pi-copy" aria-hidden="true" />
              <span>复制</span>
            </Button>
          </div>
        </div>

        <div class="invite-card">
          <span class="invite-label">专属邀请直链</span>
          <div class="invite-input-row">
            <InputText
              ref="linkField"
              :value="inviteLink"
              readonly
              class="invite-link-input"
              aria-label="房间直链"
              @focus="selectLinkValue"
            />
            <Button severity="help" class="copy-btn" :title="'复制完整链接'" @click="copyInvite('link')">
              <i class="pi pi-copy" aria-hidden="true" />
              <span>复制链接</span>
            </Button>
          </div>
        </div>

        <p v-if="copyStatus" class="copy-status" role="status">
          <i class="pi pi-check" aria-hidden="true" />
          <span>{{ copyStatus }}</span>
        </p>
      </div>
    </Dialog>

    <!-- 结算叠层：赢家、牌型与各边池分配。 -->
    <HandResultOverlay
      v-if="result"
      :result="result"
      :seats="game.seats"
      :hero-player-id="game.self?.playerId ?? null"
      :my-cards="activeHeroCards"
      :visible="overlayVisible"
      :next-hand-seconds="nextHandCountdownVisible ? nextHandRemainingSeconds : null"
      @close="closeResult"
      @history="openHistory"
    />

    <!-- 买入确认：房主定的上限 + 服务端校验的下限/步进 -->
    <Dialog
      v-model:visible="buyInOpen"
      modal
      :header="isRebuyDialog ? '重新买入' : buyInSeat === null ? '确认买入' : `买入并入座 ${String(buyInSeat + 1)} 号位`"
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
          <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="13" cy="4" r="1.8" />
            <line x1="7" y1="21" x2="10" y2="17" />
            <path d="M16 21l-2-4-3-3 1-6" />
            <path d="M6 12l2-3 4-1 3 3 3 1" />
          </svg>
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
          <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          <span>退出房间</span>
        </Button>
      </template>
    </Dialog>

    <!-- 主持人移除玩家：列出房间里所有人（含旁观者），自己不可移除。
         点「移除」先在这一行就地二次确认：这是不可撤销的操作，点错就得重发邀请。 -->
    <Dialog
      v-model:visible="kickOpen"
      modal
      header="移除玩家"
      :style="{ width: 'min(92vw, 420px)' }"
      @hide="kickTarget = null"
    >
      <p class="hint">
        被移除的人会立刻离开房间、座位释放；如果还在手牌中，会先弃牌等本手结算。
        想让他回来，需要重新把邀请链接发给他。
      </p>
      <ul v-if="room.members.length > 0" class="kick-list">
        <li v-for="entry in room.members" :key="entry.playerId" class="kick-row">
          <template v-if="kickTarget?.playerId === entry.playerId">
            <span class="kick-confirm">确定把「{{ entry.nickname }}」移出房间吗？</span>
            <span class="kick-actions">
              <Button size="small" text :title="'取消'" @click="kickTarget = null"><span>取消</span></Button>
              <Button size="small" severity="danger" :title="`确认移除 ${entry.nickname}`" @click="confirmKick">
                <i class="pi pi-check" aria-hidden="true" />
                <span>确认移除</span>
              </Button>
            </span>
          </template>
          <template v-else>
            <span class="kick-who">
              <b>{{ entry.nickname }}</b>
              <span class="muted">
                {{ seatText(entry.seat) }}<template v-if="entry.isHost"> · 主持人</template>
                <template v-if="!entry.connected"> · 已断线</template>
              </span>
            </span>
            <span v-if="entry.playerId === game.self?.playerId" class="muted kick-self">这是你</span>
            <Button
              v-else
              size="small"
              severity="danger"
              outlined
              :title="`把 ${entry.nickname} 移出房间`"
              @click="kickTarget = entry"
            >
              <i class="pi pi-user-minus" aria-hidden="true" />
              <span>移除</span>
            </Button>
          </template>
        </li>
      </ul>
      <p v-else class="hint">正在读取房间成员…</p>
      <template #footer>
        <Button text :title="'关闭'" @click="closeKick"><span>关闭</span></Button>
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
  height: 100dvh;
  max-height: 100dvh;
  min-height: 0;
  /* 德州扑克赛级舞台：深黑曜石渐变 + 顶灯向心聚光漫射 */
  background: radial-gradient(circle at 50% 25%, #151d27 0%, #0d1218 65%, #080b0f 100%);
  position: relative;
  overflow: hidden;
}

/* ═══════════════ 顶栏 HUD 贵宾指挥区 ═══════════════ */
.hud-header {
  background: rgba(12, 17, 24, 0.88);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(212, 177, 106, 0.2);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.55);
  padding: 8px var(--space-2);
  display: flex;
  align-items: center;
  z-index: 10;
}

.hud-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* 房间名贵宾勋章 */
.room-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: linear-gradient(135deg, rgba(212, 177, 106, 0.16) 0%, rgba(212, 177, 106, 0.05) 100%);
  border: 1px solid rgba(212, 177, 106, 0.4);
  border-radius: var(--radius-sm);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.room-badge-icon {
  font-size: 0.88rem;
  color: #ffd875;
  filter: drop-shadow(0 0 6px rgba(212, 177, 106, 0.5));
}

.host-label {
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(212, 177, 106, 0.2);
  color: #ffe19a;
  font-size: 0.68rem;
  font-weight: 700;
  white-space: nowrap;
}

.bar-title {
  font-size: 0.98rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #ffffff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
}

/* 盲注 / 手数 / 阶段钛金微晶胶囊 */
.meta-capsules {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.meta-pill {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 3px 10px;
  background: rgba(22, 29, 38, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  font-size: 0.82rem;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.meta-label {
  color: var(--muted);
  font-size: 0.72rem;
  font-weight: 500;
}

.meta-pill--blind .num {
  color: #ffd875;
  font-weight: 700;
}

.meta-pill--hand .num {
  color: #ffffff;
  font-weight: 700;
}

.stage-name {
  color: var(--gold);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.stage--flop .stage-name {
  color: #38bdf8;
  text-shadow: 0 0 8px rgba(56, 189, 248, 0.4);
}

.stage--turn .stage-name {
  color: #c084fc;
  text-shadow: 0 0 8px rgba(192, 132, 252, 0.4);
}

.stage--river .stage-name {
  color: #fb7185;
  text-shadow: 0 0 8px rgba(251, 113, 133, 0.4);
}

.stage--showdown .stage-name {
  color: #facc15;
  text-shadow: 0 0 8px rgba(250, 204, 21, 0.4);
}

/* 网络连接状态 */
.link-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.76rem;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.link-state.is-online {
  color: #34d399;
}

.link-state.is-online i {
  filter: drop-shadow(0 0 4px #34d399);
}

.link-state.is-offline {
  color: var(--danger);
}

.bar-spacer {
  flex: 1;
}


/* 顶栏快捷金标按钮栏 */
.bar-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.bar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  background: rgba(22, 29, 38, 0.75);
  border: 1px solid rgba(212, 177, 106, 0.22);
  color: var(--text);
  font-size: 0.82rem;
  font-weight: 500;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
}

.bar-btn:hover {
  background: rgba(212, 177, 106, 0.16);
  border-color: var(--gold);
  color: #ffffff;
  box-shadow: 0 0 12px rgba(212, 177, 106, 0.25);
  transform: translateY(-1px);
}

.bar-btn--chat.has-unread {
  border-color: #38bdf8;
  box-shadow: 0 0 10px rgba(56, 189, 248, 0.35);
}

.bar-btn--chat.has-mention {
  border-color: #ffd875;
  box-shadow: 0 0 14px rgba(212, 177, 106, 0.5);
}

.bar-btn-text {
  font-size: 0.82rem;
  font-weight: 600;
}

.count-chip {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: rgba(212, 177, 106, 0.2);
  color: #ffd875;
  font-size: 0.68rem;
  line-height: 1;
  font-weight: 700;
}

.count-chip--unread {
  background: #2563eb;
  color: #ffffff;
  box-shadow: 0 0 6px rgba(37, 99, 235, 0.6);
}

/* ═══════════════ 中央牌桌舞台 ═══════════════ */
.notice-slot {
  height: 32px;
  overflow: visible;
  z-index: 5;
}

.next-hand-notice {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 32px;
  color: #ffd875;
  background: rgba(12, 18, 28, 0.9);
  border-top: 1px solid rgba(212, 177, 106, 0.3);
  border-bottom: 1px solid rgba(212, 177, 106, 0.3);
  font-size: 0.82rem;
  font-weight: 600;
}

.stage {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px var(--space-2) 0;
  min-height: 0;
  position: relative;
}

.loading {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--gold);
  font-size: 0.95rem;
  text-shadow: 0 0 10px rgba(212, 177, 106, 0.3);
}

/* ═══════════════ 一体化玩家座舱（Hero Cockpit） ═══════════════ */
.hero {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 6px var(--space-2) 10px;
  background: linear-gradient(180deg, rgba(14, 19, 26, 0.88) 0%, rgba(8, 11, 15, 0.98) 100%);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-top: 1px solid rgba(212, 177, 106, 0.25);
  box-shadow: 0 -10px 32px rgba(0, 0, 0, 0.6);
  z-index: 8;
}

/* 核心座舱外壳（继承原 .hero-cards 保证 E2E 选择器完全兼容） */
.hero-cockpit {
  display: flex;
  align-items: stretch;
  gap: 20px;
  width: 100%;
  max-width: 1080px;
  margin-inline: auto;
  padding: 10px 18px;
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, rgba(22, 30, 40, 0.92) 0%, rgba(13, 18, 24, 0.98) 100%);
  border: 1px solid rgba(212, 177, 106, 0.28);
  box-shadow:
    0 12px 36px rgba(0, 0, 0, 0.6),
    inset 0 1px 0 rgba(255, 255, 255, 0.1),
    inset 0 0 20px rgba(0, 0, 0, 0.4);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

/* 座舱左翼：底牌展示与牌力资产 */
.cockpit-wing--hero {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 0 0 auto;
}

.cockpit-cards-group {
  display: flex;
  align-items: center;
}

/* 扇形交叠底牌容器 */
.fan-cards {
  display: flex;
  align-items: center;
  padding: 4px 6px;
}

/* 3D 翻转底牌卡槽 */
.hero-card-flipper {
  position: relative;
  width: var(--cw, 58px);
  height: calc(var(--cw, 58px) * 1.4);
  perspective: 1000px;
  flex: none;
}

.hero-card-inner {
  position: relative;
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;
  transition: transform 0.65s cubic-bezier(0.34, 1.45, 0.64, 1);
}

.hero-card-flipper.is-flipped .hero-card-inner {
  transform: rotateY(180deg);
}

/* 左右两张底牌依次翻开的真实发牌时差（左牌先翻，右牌随后） */
.hero-card-flipper.fan-card--0 .hero-card-inner {
  transition-delay: 0ms;
}

.hero-card-flipper.fan-card--1 .hero-card-inner {
  transition-delay: 140ms;
}

.hero-card-face {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  border-radius: calc(var(--cw, 58px) * 0.11);
}

.hero-card-face :deep(.card) {
  width: 100% !important;
  height: 100% !important;
}

.hero-card-face--back {
  transform: rotateY(0deg);
  z-index: 1;
}

.hero-card-flipper.is-flipped .hero-card-face--back {
  z-index: 0;
}

.hero-card-face--front {
  transform: rotateY(180deg);
  z-index: 2;
  overflow: hidden;
}

.hero-card-flipper:not(.is-flipped) .hero-card-face--front {
  z-index: 0;
}

/* 翻牌瞬间金色微光掠过动效 */
.hero-card-face--front::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(105deg, transparent 20%, rgba(255, 255, 255, 0.35) 45%, rgba(212, 177, 106, 0.45) 55%, transparent 75%);
  background-size: 200% 200%;
  opacity: 0;
  pointer-events: none;
}

.hero-card-flipper.is-flipped .hero-card-face--front::after {
  animation: card-gleam 0.75s 0.2s cubic-bezier(0.2, 0.8, 0.25, 1) forwards;
}

@keyframes card-gleam {
  0% {
    opacity: 0;
    background-position: 200% 0;
  }
  35% {
    opacity: 0.85;
  }
  100% {
    opacity: 0;
    background-position: -200% 0;
  }
}

.hero-card-flipper.is-dim {
  opacity: 0.45;
  filter: grayscale(0.5) drop-shadow(0 2px 6px rgba(0, 0, 0, 0.5));
}

.fan-card--0 {
  transform: rotate(-4.5deg) translateY(-2px);
  transform-origin: bottom center;
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  filter: drop-shadow(-2px 6px 12px rgba(0, 0, 0, 0.7));
}

.fan-card--1 {
  transform: rotate(4.5deg) translateX(-18px) translateY(-2px);
  transform-origin: bottom center;
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  filter: drop-shadow(4px 6px 14px rgba(0, 0, 0, 0.75));
}

.hero-cockpit:hover .fan-card--0 {
  transform: rotate(-7deg) translateX(-4px) translateY(-5px);
}

.hero-cockpit:hover .fan-card--1 {
  transform: rotate(7deg) translateX(-10px) translateY(-5px);
}

/* 左翼状态与徽章 */
.cockpit-meta-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 170px;
}

.cockpit-badge-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 牌型勋章高亮 */
.hero-hand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  background: linear-gradient(135deg, rgba(27, 78, 67, 0.75) 0%, rgba(13, 46, 39, 0.85) 100%);
  border: 1px solid rgba(212, 177, 106, 0.45);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
}

.hand-icon {
  color: #ffd875;
  font-size: 0.82rem;
  filter: drop-shadow(0 0 4px rgba(212, 177, 106, 0.6));
}

.hand-name {
  color: #ffe394;
  font-size: 0.94rem;
  font-weight: 700;
  white-space: nowrap;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.8);
  letter-spacing: 0.02em;
}

/* 筹码资产槽位 */
.hero-stack {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  background: rgba(12, 17, 23, 0.85);
  border: 1px solid rgba(212, 177, 106, 0.3);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.5);
}

.stack-label {
  color: var(--muted);
  font-size: 0.74rem;
}

.stack-num {
  color: #ffd875;
  font-size: 1.12rem;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.rebuy-btn {
  min-height: 32px;
  margin-left: 4px;
  padding: 4px 8px !important;
  white-space: nowrap;
}

/* 席位动作（开局、离座、退出） */
.hero-seat-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.hero-start-btn {
  flex-shrink: 0;
  padding: 5px 16px !important;
  font-size: 0.86rem !important;
  font-weight: 700 !important;
  white-space: nowrap;
  color: #ffffff !important;
  background: linear-gradient(135deg, #1f8d72 0%, #115745 100%) !important;
  border: 1px solid #2bc9a3 !important;
  border-radius: var(--radius-sm) !important;
  box-shadow: 0 2px 12px rgba(27, 141, 114, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.25) !important;
  transition: all 0.2s ease !important;
}

.hero-start-btn:hover {
  background: linear-gradient(135deg, #26a989 0%, #156d57 100%) !important;
  box-shadow: 0 4px 18px rgba(27, 141, 114, 0.7) !important;
  transform: translateY(-1px);
}

.sub-action-btn {
  display: inline-flex !important;
  align-items: center !important;
  gap: 5px !important;
  padding: 4px 10px !important;
  font-size: 0.8rem !important;
  font-weight: 600 !important;
  color: #cbd5e1 !important;
  background: rgba(15, 23, 42, 0.7) !important;
  border: 1px solid rgba(255, 255, 255, 0.14) !important;
  border-radius: var(--radius-sm) !important;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.06) !important;
  transition: all 0.18s ease !important;
  white-space: nowrap !important;
}

.sub-action-btn:hover {
  color: #ffffff !important;
  background: rgba(30, 41, 59, 0.9) !important;
  border-color: rgba(212, 177, 106, 0.45) !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.12) !important;
  transform: translateY(-1px);
}

.sub-action-btn:active {
  transform: translateY(0);
}

.sub-action-btn .btn-action-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  stroke: currentColor;
}

.sub-btn-text {
  font-size: 0.78rem;
  letter-spacing: 0.02em;
  line-height: 1;
}

/* 纵向微金拉线 */
.cockpit-divider {
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(212, 177, 106, 0.35) 20%, rgba(212, 177, 106, 0.35) 80%, transparent);
  margin-block: 4px;
}

/* 座舱右翼：战术操作融入台 */
.cockpit-wing--action {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
}

.hero-actions {
  width: 100%;
}

/* ═══════════════ 贵宾观战与离座座舱 ═══════════════ */
.hero-spectator {
  display: flex;
  justify-content: center;
  width: 100%;
  max-width: 820px;
  margin-inline: auto;
}

.spectator-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  width: 100%;
  padding: 14px 24px;
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, rgba(22, 30, 40, 0.94) 0%, rgba(13, 18, 24, 0.98) 100%);
  border: 1px solid rgba(212, 177, 106, 0.32);
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.6),
    inset 0 1px 0 rgba(255, 255, 255, 0.1),
    inset 0 0 16px rgba(0, 0, 0, 0.4);
}

.hero-spectator--away .spectator-card {
  border-color: rgba(255, 215, 0, 0.45);
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.6),
    0 0 20px rgba(212, 177, 106, 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.spectator-info {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.spectator-icon {
  font-size: 1.8rem;
  color: var(--gold);
  filter: drop-shadow(0 0 8px rgba(212, 177, 106, 0.5));
}

.spectator-texts {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.spectator-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.spectator-badge {
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid rgba(52, 211, 153, 0.4);
  background: rgba(16, 185, 129, 0.12);
  color: #6ee7b7;
  font-size: 0.68rem;
  line-height: 1.2;
  white-space: nowrap;
}

.spectator-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.02em;
}

.spectator-desc {
  margin: 0;
  font-size: 0.85rem;
  color: var(--muted);
}

.spectator-copy-mobile {
  display: none;
}

.spectator-desc .num {
  color: var(--gold);
  font-weight: 700;
}

.spectator-desc .empty-num {
  color: #34d399;
  font-size: 0.95rem;
}

.spectator-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.return-seat-btn {
  background: linear-gradient(135deg, #10b981, #059669) !important;
  border-color: #10b981 !important;
  color: #fff !important;
  font-weight: 600 !important;
  box-shadow: 0 4px 14px rgba(16, 185, 129, 0.35) !important;
}

.return-seat-btn .btn-action-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  stroke: currentColor;
  margin-right: 2px;
}

.quick-sit-btn {
  background: linear-gradient(135deg, #8b5cf6, #6d28d9) !important;
  border-color: #8b5cf6 !important;
  color: #fff !important;
  font-weight: 600 !important;
  box-shadow: 0 4px 14px rgba(139, 92, 246, 0.35) !important;
}

.spectator-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.resit-btn {
  background: rgba(212, 177, 106, 0.2) !important;
  color: #ffd875 !important;
  border: 1px solid var(--gold) !important;
}

.resit-btn:hover {
  background: rgba(212, 177, 106, 0.35) !important;
}

.exit-btn {
  border-color: rgba(255, 255, 255, 0.2) !important;
  color: var(--muted) !important;
}

.exit-btn:hover {
  color: var(--text) !important;
  border-color: var(--danger) !important;
}

/* ═══════════════ 全功能信息弹窗与不透明黑金面板 ═══════════════ */
:deep(.vip-dialog) {
  background: #141a23 !important;
  background-color: #141a23 !important;
  border: 1px solid rgba(212, 177, 106, 0.35) !important;
  border-radius: var(--radius-lg) !important;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.95), 0 0 30px rgba(0, 0, 0, 0.8) !important;
  opacity: 1 !important;
}

/* ═══════════════ 桌面右上角 HUD 快捷手牌历史 ═══════════════ */
.hud-history-body {
  display: flex;
  flex-direction: column;
}

.hud-history-list {
  max-height: clamp(240px, 45vh, 480px);
  overflow-y: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

:deep(.vip-hub-dialog) {
  max-width: 640px;
  width: min(92vw, 640px);
}

:deep(.vip-hub-dialog .p-dialog-content) {
  padding: 16px 20px 20px !important;
  max-height: min(80vh, 680px) !important;
  display: flex !important;
  flex-direction: column !important;
  background: #141a23 !important;
  background-color: #141a23 !important;
}

.drawer-nav {
  display: flex;
  gap: 6px;
  padding: 5px;
  background: #0f141b;
  border: 1px solid #232c38;
  border-radius: var(--radius-md);
  margin-bottom: 16px;
  flex-shrink: 0;
}

.drawer-nav-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.drawer-nav-btn:hover {
  color: var(--text);
  background: #19222d;
}

.drawer-nav-btn.active {
  color: #ffd875;
  background: #1d2735;
  border-color: rgba(212, 177, 106, 0.45);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.drawer-badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(212, 177, 106, 0.2);
  color: #ffd875;
  font-size: 0.72rem;
  font-weight: 700;
}

.drawer-badge--alert {
  background: #dc2626;
  color: #ffffff;
}

.drawer-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.drawer-pane {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.drawer-body h3 {
  margin: 0 0 var(--space-2);
  font-size: 1rem;
  font-weight: 700;
  color: #ffd875;
  letter-spacing: 0.02em;
}

/* 邀请卡立牌 */
.invite-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: #19222e;
  border: 1px solid #283648;
  border-radius: var(--radius-md);
}

.invite-icon {
  font-size: 1.4rem;
  color: var(--gold);
}

.invite-banner-texts {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.invite-title {
  margin: 0;
  font-size: 0.96rem;
  font-weight: 700;
  color: #ffffff;
}

.invite-desc {
  margin: 0;
  font-size: 0.8rem;
  color: var(--muted);
}

.invite-card {
  display: grid;
  gap: 6px;
  padding: 16px;
  border: 1px solid #283648;
  border-radius: var(--radius-md);
  background: #18212c;
}

.invite-plate {
  display: grid;
  gap: 4px;
  margin: 0 0 var(--space-2);
  padding: 16px 14px;
  border: 1px solid rgba(212, 177, 106, 0.45);
  border-radius: var(--radius-md);
  background: linear-gradient(180deg, #164038 0%, #0d2822 100%);
  text-align: center;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.15);
}

.invite-label {
  font-size: 0.76rem;
  letter-spacing: 0.12em;
  color: #9fe2d4;
  text-transform: uppercase;
  font-weight: 600;
}

.invite-code {
  font-size: 2.2rem;
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: 0.16em;
  text-indent: 0.16em;
  color: #ffe394;
  text-shadow: 0 0 16px rgba(212, 177, 106, 0.6);
}

.invite-code-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #0f141b;
  border: 1px solid #283648;
  border-radius: var(--radius-sm);
}

.invite-field {
  display: grid;
  gap: 4px;
  margin-bottom: var(--space-1);
}

.invite-field-label {
  font-size: 0.84rem;
  color: var(--muted);
}

.invite-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.invite-status {
  min-height: 1.2em;
  margin: 8px 0 0;
  font-size: 0.82rem;
  color: #34d399;
  font-weight: 600;
}

.invite-hints {
  margin: var(--space-2) 0 0;
  padding-left: 1.1em;
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 0.8rem;
}

/* ═══════════════ 手牌历史战报卡片系统 ═══════════════ */
.history-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 65vh;
  overflow-y: auto;
  padding-right: 6px;
}

.history-empty {
  padding: 40px 16px;
  text-align: center;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.history-empty-icon {
  font-size: 2.2rem;
  opacity: 0.4;
}

.history-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  background: #141c28;
  border: 1px solid #253346;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  transition: border-color 0.2s ease, transform 0.2s ease;
}

.history-card.is-hero-won {
  border-color: rgba(212, 177, 106, 0.45);
  background: linear-gradient(180deg, #182333 0%, #131b26 100%);
  box-shadow: 0 4px 20px rgba(212, 177, 106, 0.12), 0 4px 16px rgba(0, 0, 0, 0.4);
}

.history-card.is-hero-showdown {
  border-color: rgba(96, 165, 250, 0.35);
}

.history-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.history-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.history-hand-tag {
  font-size: 0.9rem;
  font-weight: 800;
  color: #ffd875;
  background: rgba(255, 216, 117, 0.12);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(255, 216, 117, 0.25);
}

.history-result-badge {
  font-size: 0.76rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.badge-win {
  background: linear-gradient(135deg, rgba(212, 177, 106, 0.3), rgba(180, 138, 56, 0.4));
  color: #ffd875;
  border: 1px solid rgba(212, 177, 106, 0.5);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}

.badge-showdown {
  background: rgba(59, 130, 246, 0.15);
  color: #93c5fd;
  border: 1px solid rgba(59, 130, 246, 0.3);
}

.badge-neutral {
  background: rgba(255, 255, 255, 0.08);
  color: #cbd5e1;
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.badge-fold {
  background: rgba(148, 163, 184, 0.1);
  color: #94a3b8;
  border: 1px solid rgba(148, 163, 184, 0.2);
}

.history-header-right {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.history-pot-label {
  font-size: 0.75rem;
  color: var(--muted);
}

.history-pot-value {
  font-size: 0.95rem;
  color: #ffd875;
  font-weight: 700;
}

.history-board-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.22);
  border-radius: var(--radius-sm);
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.history-section-title {
  font-size: 0.76rem;
  font-weight: 600;
  color: #94a3b8;
  white-space: nowrap;
}

.history-cards-line {
  display: flex;
  align-items: center;
  gap: 5px;
}

.history-empty-board {
  font-size: 0.78rem;
  color: var(--muted);
  font-style: italic;
}

.history-showdown-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

.history-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.history-revealed-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-revealed-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-sm);
  transition: background 0.15s ease;
}

.history-revealed-row.is-winner {
  background: rgba(212, 177, 106, 0.08);
  border-color: rgba(212, 177, 106, 0.35);
}

.history-revealed-row.is-hero {
  border-left: 3px solid #60a5fa;
}

.history-revealed-row.is-hero.is-winner {
  border-left: 3px solid #ffd875;
}

.revealed-player-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.revealed-player-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.revealed-crown {
  font-size: 0.85rem;
}

.revealed-nickname {
  font-size: 0.86rem;
  font-weight: 600;
  color: #e2e8f0;
}

.revealed-nickname.hero-name {
  color: #60a5fa;
}

.history-revealed-row.is-winner .revealed-nickname {
  color: #ffd875;
}

.revealed-win-num {
  font-size: 0.85rem;
  font-weight: 700;
  color: #34d399;
}

.revealed-hand-badge {
  font-size: 0.74rem;
  color: #94a3b8;
  display: inline-flex;
}

.revealed-hand-badge.badge-winner {
  color: #ffd875;
  font-weight: 600;
}

.revealed-cards-box {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.revealed-card {
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
}

.revealed-card.winner-card {
  box-shadow: 0 0 8px rgba(212, 177, 106, 0.4);
}

.history-uncontested-section {
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--radius-sm);
  border: 1px dashed rgba(255, 255, 255, 0.08);
}

.history-uncontested-winner {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  flex-wrap: wrap;
}

.uncontested-crown {
  font-size: 0.9rem;
}

.uncontested-name {
  font-weight: 600;
  color: #ffd875;
}

.uncontested-name.hero-name {
  color: #60a5fa;
}

.uncontested-text {
  color: var(--muted);
}

.uncontested-amount {
  color: #34d399;
  font-weight: 700;
}

.uncontested-note {
  color: var(--muted);
  font-size: 0.74rem;
}

/* ═══════════════ HUD 快捷胶囊与微弹出面板体系（硬件加速 120FPS 丝滑版） ═══════════════ */
.hud-anchor {
  position: absolute;
  top: 14px;
  z-index: 25;
  pointer-events: auto;
}

.hud-chat-anchor {
  left: 18px;
}

.hud-history-anchor {
  right: 18px;
}

.hud-score-anchor {
  left: 50%;
  transform: translateX(-50%);
}

/* 胶囊按钮（固定尺寸、无布局重排、质感十足） */
.hud-capsule-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(12, 18, 28, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  color: #e2e8f0;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  transition: 
    background 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.15s cubic-bezier(0.16, 1, 0.3, 1),
    color 0.2s ease;
  will-change: transform;
}

.hud-capsule-btn:hover {
  background: rgba(18, 28, 44, 0.88);
  border-color: rgba(212, 177, 106, 0.4);
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4), 0 0 10px rgba(212, 177, 106, 0.15);
  color: #fff;
}

.hud-capsule-btn:active {
  transform: translateY(0) scale(0.96);
}

.hud-capsule-btn.is-active {
  background: rgba(18, 28, 44, 0.95);
  border-color: rgba(212, 177, 106, 0.65);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45), 0 0 12px rgba(212, 177, 106, 0.25);
  color: #ffd875;
}

.hud-chat-pill .hud-capsule-icon {
  color: #60a5fa;
  font-size: 0.88rem;
}

.hud-history-pill .hud-capsule-icon {
  color: #ffd875;
  font-size: 0.85rem;
}

.hud-score-pill .hud-capsule-icon { color: #34d399; font-size: 0.85rem; }

.hud-capsule-label {
  white-space: nowrap;
}

.hud-capsule-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: #ef4444;
  color: #fff;
  font-size: 0.65rem;
  font-weight: 700;
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.6);
}

.hud-history-pill .hud-capsule-badge {
  background: rgba(212, 177, 106, 0.25);
  color: #ffd875;
  border: 1px solid rgba(212, 177, 106, 0.4);
  box-shadow: none;
}

.hud-capsule-arrow {
  font-size: 0.62rem;
  color: rgba(255, 255, 255, 0.4);
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), color 0.2s ease;
}

.hud-capsule-btn:hover .hud-capsule-arrow {
  color: rgba(255, 255, 255, 0.85);
}

.hud-capsule-btn.is-active .hud-capsule-arrow {
  color: #ffd875;
}

/* 浮动面板本体（脱离文档流、GPU加速、0 Layout Reflow） */
.hud-popover {
  position: absolute;
  top: calc(100% + 8px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  background: rgba(10, 16, 26, 0.92);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(212, 177, 106, 0.28);
  border-radius: var(--radius-md);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.7), 0 0 16px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  user-select: auto;
}

.hud-chat-popover {
  left: 0;
  width: clamp(260px, 22vw, 320px);
}

.hud-history-popover {
  right: 0;
  width: clamp(310px, 26vw, 390px);
}

.hud-score-popover { left: 50%; transform: translateX(-50%); width: min(470px, calc(100vw - 20px)); }
.hud-score-popover-enter-active, .hud-score-popover-leave-active { transition: opacity .18s ease, transform .18s ease; }
.hud-score-popover-enter-from, .hud-score-popover-leave-to { opacity: 0; transform: translate(-50%, -8px) scale(.96); }
.hud-score-popover-enter-to, .hud-score-popover-leave-from { opacity: 1; transform: translateX(-50%); }
.hud-score-summary { padding: 10px 14px; color: #cbd5e1; font-size: 0.78rem; border-bottom: 1px solid rgba(255,255,255,.1); }
.hud-score-summary b { color: #ffd875; }
.hud-score-scroll { max-height: min(48vh, 390px); overflow: auto; }
.hud-score-empty { margin: 0; padding: 20px; text-align: center; color: #cbd5e1; }
.hud-score-table { width: 100%; border-collapse: collapse; font-size: 0.76rem; white-space: nowrap; }
.hud-score-table th, .hud-score-table td { padding: 9px 7px; text-align: right; border-bottom: 1px solid rgba(255,255,255,.09); }
.hud-score-table th:first-child { text-align: left; padding-left: 14px; }
.hud-score-table td:last-child, .hud-score-table th:last-child { padding-right: 14px; }
.hud-score-table thead th { color: #cbd5e1; font-weight: 500; }
.hud-score-table tbody th { color: #f8fafc; font-weight: 600; }
.hud-score-table tbody th small { display: block; margin-top: 2px; color: #cbd5e1; font-size: 0.66rem; font-weight: 400; }
.hud-score-table .score-up { color: #6ee7b7; font-weight: 700; }
.hud-score-table .score-down { color: #fca5a5; font-weight: 700; }
.hud-score-note { margin: 0; padding: 9px 14px; color: #cbd5e1; font-size: 0.68rem; border-top: 1px solid rgba(255,255,255,.1); }

.hud-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.hud-popover-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  font-weight: 600;
  color: #f1f5f9;
}

.hud-chat-popover .hud-popover-title i {
  color: #60a5fa;
  font-size: 0.88rem;
}

.hud-history-popover .hud-popover-title i {
  color: #ffd875;
  font-size: 0.85rem;
}

.hud-popover-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: rgba(212, 177, 106, 0.22);
  color: #ffd875;
  border: 1px solid rgba(212, 177, 106, 0.4);
  font-size: 0.65rem;
  font-weight: 700;
}

.hud-popover-close-btn {
  background: transparent;
  border: none;
  color: var(--muted);
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 0.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.hud-popover-close-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  transform: scale(1.08);
}

/* 动效：纯 GPU 合成层变换，0 Layout Reflow，120FPS 丝滑体验 */
.hud-popover-enter-active {
  transition: 
    opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: top left;
  will-change: opacity, transform;
}

.hud-popover-leave-active {
  transition: 
    opacity 0.16s ease-in,
    transform 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: top left;
  will-change: opacity, transform;
}

.hud-popover-enter-from,
.hud-popover-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.96);
}

.hud-popover-enter-to,
.hud-popover-leave-from {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.hud-popover-right-enter-active {
  transition: 
    opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: top right;
  will-change: opacity, transform;
}

.hud-popover-right-leave-active {
  transition: 
    opacity 0.16s ease-in,
    transform 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: top right;
  will-change: opacity, transform;
}

.hud-popover-right-enter-from,
.hud-popover-right-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.96);
}

.hud-popover-right-enter-to,
.hud-popover-right-leave-from {
  opacity: 1;
  transform: translateY(0) scale(1);
}

/* 聊天面板内容布局 */
.hud-chat-body {
  display: flex;
  flex-direction: column;
}

.hud-chat-list {
  height: 140px;
  overflow-y: auto;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 0.82rem;
  line-height: 1.35;
}

.hud-chat-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.35);
  font-size: 0.76rem;
}

.hud-chat-item {
  word-break: break-word;
  color: #f1f5f9;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
}

.hud-msg-sender {
  color: #93c5fd;
  font-weight: 600;
  margin-right: 4px;
  cursor: pointer;
  transition: color 0.15s ease;
}

.hud-msg-sender:hover {
  color: #bfdbfe;
  text-decoration: underline;
}

.hud-chat-item.is-own .hud-msg-sender {
  color: #fbbf24;
}

.hud-msg-text {
  color: #f8fafc;
}

.hud-chat-item.is-mention {
  background: rgba(251, 191, 36, 0.14);
  border-radius: 4px;
  padding: 1px 4px;
}

.hud-msg-system {
  color: #94a3b8;
  font-size: 0.76rem;
  font-style: italic;
  opacity: 0.9;
}

.hud-chat-form {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(0, 0, 0, 0.2);
}

.hud-chat-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.05);
  color: #f8fafc;
  font-size: 0.8rem;
  outline: none;
  transition: border-color 0.2s ease, background 0.2s ease;
}

.hud-chat-input::placeholder {
  color: rgba(255, 255, 255, 0.35);
}

.hud-chat-input:focus {
  background: rgba(10, 16, 26, 0.65);
  border-color: rgba(212, 177, 106, 0.6);
  box-shadow: 0 0 6px rgba(212, 177, 106, 0.2);
}

.hud-chat-send {
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(212, 177, 106, 0.3);
  background: linear-gradient(135deg, rgba(212, 177, 106, 0.25), rgba(184, 142, 60, 0.35));
  color: #ffd875;
  cursor: pointer;
  font-size: 0.78rem;
  transition: transform 0.15s ease, opacity 0.15s ease, background 0.15s ease;
}

.hud-chat-send:hover:not(:disabled) {
  transform: scale(1.05);
  background: linear-gradient(135deg, rgba(212, 177, 106, 0.4), rgba(184, 142, 60, 0.5));
  color: #fff;
}

.hud-chat-send:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.hud-chat-error {
  margin: 0;
  padding: 2px 8px 4px;
  color: #f87171;
  font-size: 0.72rem;
}

@media (max-width: 768px) {
  .hud-anchor {
    top: 8px;
  }
  .hud-chat-anchor {
    left: 8px;
  }
  .hud-history-anchor {
    right: 8px;
  }
  .hud-score-popover { width: min(470px, calc(100vw - 16px)); }
  .hud-capsule-btn {
    height: 30px;
    padding: 0 9px;
    font-size: 0.75rem;
    gap: 5px;
  }
  .hud-chat-popover {
    width: min(290px, calc(100vw - 20px));
  }
  .hud-history-popover {
    width: min(340px, calc(100vw - 20px));
  }
  .hud-chat-list {
    height: 120px;
  }
  .hud-history-list {
    max-height: clamp(200px, 46vh, 340px);
    padding: 6px 8px;
    gap: 8px;
  }
  .hud-history-popover .history-card {
    padding: 8px 10px;
    gap: 8px;
  }
  .hud-history-popover .history-card-header {
    padding-bottom: 6px;
  }
  .hud-history-popover .history-board-row {
    padding: 4px 8px;
    gap: 8px;
  }
  .hud-history-popover .history-revealed-row {
    padding: 6px 8px;
  }
}

/* ═══════════════ 弹窗与确认框 ═══════════════ */
.buyin {
  display: grid;
  gap: 12px;
}

.buyin-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 0;
  font-size: 0.95rem;
}

.buyin-line .num {
  font-size: 1.4rem;
  font-weight: 700;
  color: #ffd875;
}

.buyin-quick {
  display: flex;
  gap: 8px;
}

.buyin-quick :deep(.p-button) {
  flex: 1;
}

.kick-list {
  list-style: none;
  margin: var(--space-1) 0 0;
  padding: 0;
  display: grid;
  gap: 6px;
  max-height: min(50vh, 320px);
  overflow-y: auto;
}

.kick-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  padding: 8px 10px;
  border-radius: 8px;
  background: #1a232f;
  border: 1px solid #283749;
}

.kick-who {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.kick-who b {
  overflow-wrap: anywhere;
}

.kick-who .muted,
.kick-self {
  font-size: 0.78rem;
}

.kick-confirm {
  min-width: 0;
  font-size: 0.86rem;
  color: var(--danger);
}

.kick-actions {
  display: flex;
  flex: none;
  gap: 4px;
}

/* ═══════════════ 响应式屏幕适配 ═══════════════ */
/* 手机横屏屏蔽 */
.portrait-only {
  display: none;
}

@media (orientation: landscape) and (max-height: 560px) {
  .table-view > .bar,
  .table-view > .notice-strip,
  .table-view > .stage,
  .table-view > .hero,
  .table-view > :deep(.p-drawer) {
    display: none;
  }

  .portrait-only {
    display: grid;
    place-items: center;
    min-height: 100dvh;
    padding: var(--space-3);
    text-align: center;
  }
}

.portrait-only-mark {
  margin: 0 0 var(--space-1);
  color: var(--gold);
  font-size: 2rem;
}

.portrait-only-title {
  margin: 0 0 6px;
  font-size: 1.05rem;
}

.portrait-only-text {
  margin: 0;
  max-width: 34ch;
  color: var(--muted);
  font-size: 0.86rem;
  line-height: 1.6;
}

/* 竖屏窄屏（≤768px 或 ≤560px）：座舱由左右变为自然纵向流 */
@media (max-width: 768px) {
  .hero-cockpit {
    flex-direction: column;
    gap: 10px;
    padding: 8px 12px;
  }

  .cockpit-divider {
    display: none;
  }

  .cockpit-wing--hero {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    width: 100%;
    column-gap: 12px;
    row-gap: 8px;
  }

  .cockpit-meta-group {
    display: contents;
  }

  .cockpit-badge-row {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 8px;
  }

  .hero-seat-actions {
    grid-column: 1 / -1;
    flex-wrap: nowrap;
    width: 100%;
  }
}

@media (orientation: portrait) and (max-width: 560px) {
  .hero-spectator .spectator-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
    padding: 10px 12px;
  }

  .hero-spectator .spectator-info {
    align-items: flex-start;
    gap: 10px;
  }

  .hero-spectator .spectator-icon {
    margin-top: 2px;
    font-size: 1.25rem;
  }

  .hero-spectator .spectator-title {
    font-size: 0.92rem;
  }

  .hero-spectator .spectator-desc {
    font-size: 0.76rem;
    line-height: 1.4;
  }

  .spectator-copy-desktop {
    display: none;
  }

  .spectator-copy-mobile {
    display: inline;
  }

  .hero-spectator .spectator-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
    gap: 8px;
  }

  .hero-spectator .spectator-actions :deep(.p-button) {
    justify-content: center;
    min-width: 0;
    min-height: 44px;
    padding: 6px 8px;
    font-size: 0.78rem;
    white-space: nowrap;
  }

  .hero-spectator .spectator-actions > :only-child {
    grid-column: 1 / -1;
  }

  .notice-slot {
    height: 26px;
  }

  .next-hand-notice {
    min-height: 26px;
    font-size: 0.75rem;
  }

  .hero {
    padding: 4px 6px 8px;
  }

  .hero-cockpit {
    padding: 6px 10px;
    gap: 6px;
  }

  .hero-cockpit :deep(.card--lg) {
    --cw: 44px;
  }

  .fan-card--1 {
    transform: rotate(4.5deg) translateX(-12px) translateY(-1px);
  }

  .hero-seat-actions :deep(.sub-action-btn) {
    padding: 3px 5px !important;
    font-size: 0.74rem !important;
  }

  .hero-seat-actions :deep(.hero-start-btn) {
    padding: 5px 8px !important;
    font-size: 0.76rem !important;
  }

  .bar {
    gap: 6px;
    padding: 4px 8px;
  }

  .bar-title {
    font-size: 0.92rem;
  }

  .stat--stage,
  .stat--hand {
    display: none;
  }

  .bar-btn-text {
    display: none;
  }

  .bar-btn {
    padding: 4px 8px;
    min-width: 34px;
  }

  .count-chip--history {
    display: none;
  }

  .chat-list {
    max-height: none;
  }
}

@media (max-width: 820px) {
  .bar .stat--stage,
  .bar .link-state {
    display: none;
  }

  .bar-title {
    max-width: 28vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

/* ═══════════════ 邀请链接进桌落地页（未加桌前） ═══════════════ */
.join-gate {
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  width: 100%;
  padding: clamp(16px, 4vh, 40px) var(--space-2);
  overflow-y: auto;
  z-index: 2;
  box-sizing: border-box;
}

/* 扑克花色浮雕与氛围光晕（与大厅风格统一） */
.join-backdrop {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
}

.join-ambient-glow {
  position: absolute;
  top: -120px;
  left: 50%;
  transform: translateX(-50%);
  width: min(900px, 100vw);
  height: 520px;
  background: radial-gradient(ellipse 65% 50% at 50% 30%, rgba(22, 75, 64, 0.42) 0%, rgba(16, 21, 27, 0) 70%);
  filter: blur(48px);
}

.join-card-suits {
  position: absolute;
  top: 30px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: clamp(50px, 16vw, 200px);
  opacity: 0.04;
  font-size: clamp(4rem, 10vw, 7.5rem);
  user-select: none;
  color: var(--gold);
}

.join-container {
  position: relative;
  z-index: 1;
  width: min(100%, 480px);
  margin: auto;
  animation: rise-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.join-card {
  position: relative;
  background: rgba(18, 25, 34, 0.88);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(212, 177, 106, 0.25);
  border-radius: var(--radius-lg);
  padding: clamp(20px, 4.5vw, 32px);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.65), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 顶部引导头 */
.join-header {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.badge-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 14px;
  font-size: 0.8rem;
  letter-spacing: 0.16em;
  color: var(--gold);
  background: rgba(212, 177, 106, 0.08);
  border: 1px solid var(--gold-soft);
  border-radius: 999px;
  backdrop-filter: blur(8px);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
}

.badge-icon {
  font-size: 0.75rem;
  opacity: 0.85;
}

.join-title {
  margin: 2px 0 0;
  font-size: clamp(1.35rem, 4vw, 1.7rem);
  font-weight: 700;
  color: #ffffff;
  letter-spacing: -0.01em;
  line-height: 1.3;
  text-wrap: balance;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
}

.join-subtitle {
  margin: 0;
  font-size: 0.84rem;
  color: var(--muted);
  line-height: 1.5;
}

/* 房间对局核心参数卡片 */
.room-meta-card {
  background: rgba(12, 17, 24, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-md);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

@media (max-width: 440px) {
  .meta-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px 8px;
  }
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.meta-item-label {
  font-size: 0.72rem;
  color: #7b8b98;
}

.meta-item-val {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}

.meta-item-val.text-gold {
  color: #ffd875;
}

.meta-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #39b54a;
  box-shadow: 0 0 6px rgba(57, 181, 74, 0.6);
  flex-shrink: 0;
}

.status-dot.is-waiting {
  background: #eab308;
  box-shadow: 0 0 6px rgba(234, 179, 8, 0.6);
}

.meta-tip {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 0.76rem;
  color: #8c9ba5;
  line-height: 1.4;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
  padding-top: 8px;
}

.meta-tip-icon {
  font-size: 0.82rem;
  color: var(--gold);
  margin-top: 1px;
  flex-shrink: 0;
}

.room-meta-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 14px;
  background: rgba(12, 17, 24, 0.5);
  border: 1px dashed rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-md);
  font-size: 0.82rem;
  color: var(--muted);
}

.loading-icon {
  font-size: 0.9rem;
  color: var(--gold);
}

/* 错误提示 */
.join-info-error-box {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: rgba(197, 74, 80, 0.12);
  border: 1px solid rgba(197, 74, 80, 0.35);
  border-radius: var(--radius-md);
  padding: 12px 14px;
}

.join-info-error-icon {
  color: #ff6b72;
  font-size: 1.1rem;
  margin-top: 2px;
  flex-shrink: 0;
}

.join-info-error-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.join-info-error-title {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 600;
  color: #ff8b90;
}

.join-info-error-desc {
  margin: 0;
  font-size: 0.78rem;
  color: var(--muted);
  line-height: 1.45;
}

.join-alert {
  margin: 0;
  border-radius: var(--radius-sm);
}

.alert-slide-enter-active,
.alert-slide-leave-active {
  transition: all 0.22s ease-out;
}

.alert-slide-enter-from,
.alert-slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* 表单字段样式 */
.join-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.join-form .field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.join-form .label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 0.84rem;
  font-weight: 500;
  color: var(--muted);
}

.join-form .label-sub {
  font-size: 0.76rem;
  color: #6f7d88;
}

/* 操作提交按钮 */
.join-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

.join-submit-btn {
  width: 100%;
  min-height: 48px;
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  background: linear-gradient(135deg, #2b7ddb 0%, #1f61b0 100%);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: var(--radius-md);
  box-shadow: 0 6px 20px rgba(43, 125, 219, 0.32);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.join-submit-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 24px rgba(43, 125, 219, 0.42);
}

.join-submit-btn:active:not(:disabled) {
  transform: translateY(0);
}

.join-back-btn {
  width: 100%;
  min-height: 40px;
  color: var(--muted) !important;
  font-size: 0.88rem;
  gap: 6px;
  transition: color 0.15s ease;
}

.join-back-btn:hover {
  color: var(--text) !important;
}

/* 入桌须知规则框 */
.join-rules-box {
  background: rgba(12, 17, 24, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
}

.join-rules-box .rules-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--gold);
}

.join-rules-box .rules-icon {
  font-size: 0.85rem;
}

.join-rules-box .rules-list {
  margin: 0;
  padding-left: 1.1em;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.78rem;
  line-height: 1.6;
  color: var(--muted);
}
</style>
