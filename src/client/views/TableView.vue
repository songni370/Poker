<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Drawer from 'primevue/drawer'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import type { ActionType, Card } from '../../shared/poker.ts'
import { STREET_NAMES, TABLE_RULES, formatCard } from '../../shared/poker.ts'
import type { ChatMessage } from '../../shared/protocol.ts'
import { CHAT_MAX_LENGTH } from '../../shared/protocol.ts'
import {
  connectRoom,
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
 * 接入优先级：本地有房间凭证 → 真实 WebSocket；否则仅在开发模式下用模拟场景；
 * 生产环境两者都没有时回到错误页，绝不展示假牌局。
 */
onMounted(() => {
  const credentials = room.credentials?.roomId === props.roomId ? room.credentials : loadCredentials(props.roomId)
  if (credentials) {
    room.setCredentials(credentials)
    connectRoom(credentials)
    return
  }
  if (isDev) void applyScenario(scenario.value)
  else void router.push({ name: 'error', query: { kind: 'room', code: 'unauthorized' } })
})

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

watch(
  () => [game.state?.handNo, game.state?.phase] as const,
  () => {
    resultDismissed.value = false
  },
)

watch(
  () => [game.state?.phase, Boolean(game.state?.lastResult)] as const,
  ([phase, hasResult]) => {
    overlayVisible.value = Boolean(hasResult) && (phase === 'showdown' || phase === 'settlement') && !resultDismissed.value
  },
  { immediate: true },
)

function closeResult(): void {
  resultDismissed.value = true
  overlayVisible.value = false
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

const chatText = ref('')
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
const chatAria = computed(() =>
  chat.unread > 0 ? `聊天，${String(chat.unread)} 条未读消息` : '聊天，没有未读消息',
)
const chatTitle = computed(() => (chat.unread > 0 ? `聊天（${String(chat.unread)} 条未读）` : '聊天'))

// 打开聊天面板即清零未读；面板开着时新消息也直接算已读。
watch(
  chatPanelVisible,
  (visible) => {
    if (!visible) return
    chat.markRead()
    void scrollChatToBottom()
  },
  { immediate: true },
)

watch(
  () => chat.count,
  () => {
    if (chatPanelVisible.value) chat.markRead()
    if (chatAtBottom.value) void scrollChatToBottom()
    else chatHasNews.value = true
  },
)

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

function takeFreeSeat(): void {
  const seat = firstFreeSeat.value
  if (seat === null) return
  if (!sendCommand({ type: 'seat.take', requestId: nextRequestId(), seat })) {
    announcement.value = '尚未连接到服务器，入座请求未发送。'
  }
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

/** 主持人开始下一手（结算后无需回到等待区）。 */
const canStartNextHand = computed(
  () => room.isHost && !!game.state && (game.state.phase === 'waiting' || game.state.phase === 'settlement'),
)

function startNextHand(): void {
  if (!sendCommand({ type: 'game.start', requestId: nextRequestId() })) {
    announcement.value = '尚未连接到服务器，无法开始下一手。'
  }
}

async function leaveTable(): Promise<void> {
  await router.push({ name: 'room', params: { roomId: props.roomId } })
}


</script>

<template>
  <div class="table-view">
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

      <Button size="small" text aria-label="规则" :title="'查看规则摘要'" @click="openDrawer('rules')">
        <i class="pi pi-book" aria-hidden="true" />
        <span>规则</span>
      </Button>
      <Button size="small" text :aria-label="historyAria" :title="'查看手牌历史'" @click="openDrawer('history')">
        <i class="pi pi-list" aria-hidden="true" />
        <span>历史</span>
        <!-- 手数只在宽屏显示，窄屏交给 aria-label 说明。 -->
        <span v-if="game.history.length > 0" class="count-chip count-chip--history num" aria-hidden="true">{{ game.history.length }}</span>
      </Button>
      <Button size="small" text :aria-label="chatAria" :title="chatTitle" @click="openDrawer('chat')">
        <i class="pi pi-comments" aria-hidden="true" />
        <span>聊天</span>
        <!-- 未读数：数字 + aria-label 双重说明，不靠颜色或红点单独表意。 -->
        <span v-if="chat.unread > 0" class="count-chip count-chip--unread num" aria-hidden="true">{{ unreadText }}</span>
      </Button>
      <Button
        size="small"
        text
        :aria-label="soundAria"
        :aria-pressed="soundEnabled"
        :title="`${soundAria}，点击切换`"
        @click="toggleSound"
      >
        <i :class="soundEnabled ? 'pi pi-volume-up' : 'pi pi-volume-off'" aria-hidden="true" />
        <span>提示音：{{ soundEnabled ? '开' : '关' }}</span>
      </Button>
      <Button
        v-if="canStartNextHand"
        size="small"
        :title="'开始下一手牌'"
        @click="startNextHand"
      >
        <i class="pi pi-play" aria-hidden="true" />
        <span>开始下一手</span>
      </Button>
      <Button size="small" outlined aria-label="退出" :title="'回到等待区'" @click="leaveTable">
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
        :button-seat="game.state.buttonSeat"
        :board="game.board"
        :pot-total="potTotal"
        :pots="game.state.pots"
        :current-bet="game.state.currentBet"
        :hero-seat="game.self?.seat ?? null"
        :hero-cards="myCards"
        :hero-player-id="game.self?.playerId ?? null"
        :acting-player-id="game.state.actingPlayerId"
        :remaining-ratio="remainingRatio"
        :remaining-seconds="remainingSeconds"
        :turn-seconds="turnSeconds"
        :winner-player-ids="winnerPlayerIds"
        :highlight-cards="highlightCards"
        :street="game.state.street"
        :notice="noticeText"
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
      <div v-if="game.isSeated" class="hero-cards">
        <span class="hero-label">你的底牌</span>
        <div class="cards">
          <PlayingCard v-for="card in myCards" :key="card" size="lg" upright :card="card" />
          <span v-if="myCards.length === 0" class="muted hint">本手没有底牌</span>
        </div>
        <span class="hero-stack">
          <span class="muted">筹码</span>
          <b class="num">{{ myStack }}</b>
        </span>
      </div>

      <!-- 观战者：只显示公开信息与入座入口，绝不渲染任何玩家的底牌。 -->
      <section v-else-if="game.self" class="spectator" aria-labelledby="spectator-state">
        <p id="spectator-state" class="spectator-state">
          <i class="pi pi-eye" aria-hidden="true" />
          <b>观战中</b>
          <span class="muted">你正在旁观这桌牌局，只能看到已经公开的牌。</span>
        </p>

        <p class="spectator-seats">
          <span class="muted">已入座</span>
          <b class="num">{{ occupiedCount }}/{{ maxSeats }}</b>
          <span v-if="firstFreeSeat !== null" class="muted">· 空位：{{ firstFreeSeat + 1 }} 号座位</span>
        </p>

        <div class="spectator-actions">
          <Button
            :disabled="firstFreeSeat === null"
            :title="firstFreeSeat === null ? '座位已满，等有人离座' : `坐到 ${String(firstFreeSeat + 1)} 号座位`"
            @click="takeFreeSeat"
          >
            <i class="pi pi-user-plus" aria-hidden="true" />
            <span>入座</span>
          </Button>
          <Button outlined :title="'回到等待区'" @click="leaveTable">
            <i class="pi pi-arrow-left" aria-hidden="true" />
            <span>回等待区</span>
          </Button>
        </div>

        <p v-if="firstFreeSeat === null" class="hint" role="status">座位已满，等有人离座。</p>
        <p v-else class="hint spectator-tip">入座后即可参与下一手牌；观战期间不下注、不行动。</p>
      </section>

      <p v-else class="hint">正在载入你的座位信息…</p>

      <ActionBar
        v-if="game.isSeated"
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
            <div><dt>起始筹码</dt><dd class="num">{{ TABLE_RULES.startingStack }}</dd></div>
            <div><dt>行动时间</dt><dd>{{ turnSeconds }} 秒，超时自动过牌或弃牌</dd></div>
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

          <div
            ref="chatListRef"
            class="chat-list thin-scroll"
            role="log"
            aria-live="polite"
            aria-label="聊天消息"
            @scroll.passive="onChatScroll"
          >
            <ol v-if="chat.count > 0" class="chat-msgs">
              <li
                v-for="message in chat.messages"
                :key="message.id"
                class="chat-msg"
                :class="{ 'is-own': isOwnMessage(message) }"
              >
                <p class="chat-meta">
                  <span class="chat-who">{{ isOwnMessage(message) ? '你' : message.nickname }}</span>
                  <time class="chat-time num" :datetime="chatIso(message.at)" :title="chatFullTime(message.at)">
                    {{ chatTime(message.at) }}
                  </time>
                </p>
                <p class="chat-text">{{ message.text }}</p>
              </li>
            </ol>
            <p v-else class="hint chat-empty">还没有人说话</p>
          </div>

          <!-- 用户往上翻时出现：跳到底部由用户自己决定，不抢滚动位置。 -->
          <Button v-if="chatHasNews" size="small" text class="chat-jump" :title="'跳到最新消息'" @click="scrollChatToBottom">
            <i class="pi pi-arrow-down" aria-hidden="true" />
            <span>有新消息，跳到最新</span>
          </Button>

          <form class="chat-form" @submit.prevent="submitChat">
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
  gap: 6px;
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
</style>
