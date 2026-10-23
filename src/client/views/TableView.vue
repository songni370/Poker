<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Card } from '../../shared/poker.ts'
import { STREET_NAMES, TABLE_RULES } from '../../shared/poker.ts'
import { describeHand } from '../../engine/evaluate.ts'
import type { ClientCommand } from '../../shared/protocol.ts'
import {
  forgetCredentials,
  loadCredentials,
  nextRequestId,
  onFatalRoomError,
  sendChat,
  sendCommand,
  useSessionStore,
} from '../net/session.ts'
import ConnectionBanner from '../components/ConnectionBanner.vue'
import HandResultOverlay from '../components/HandResultOverlay.vue'
import InviteDialog from '../components/InviteDialog.vue'
import BuyInDialog from '../components/BuyInDialog.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import HudScorePanel from '../components/HudScorePanel.vue'
import HudHistoryPanel from '../components/HudHistoryPanel.vue'
import HudChatPanel from '../components/HudChatPanel.vue'
import HeroCockpit from '../components/HeroCockpit.vue'
import TableTopBar from '../components/TableTopBar.vue'
import JoinGate from '../components/JoinGate.vue'
import MemberPickerDialog from '../components/MemberPickerDialog.vue'
import { provideHudPanels } from '../composables/useHudPanels.ts'
import { useTurnTimer } from '../composables/useTurnTimer.ts'
import { useTableCommands } from '../composables/useTableCommands.ts'
import { useTableSession } from '../composables/useTableSession.ts'
import { useHandResult } from '../composables/useHandResult.ts'
import { useSeatOverview } from '../composables/useSeatOverview.ts'
import NoticeStrip from '../components/NoticeStrip.vue'
import PokerTable from '../components/PokerTable.vue'
import RoomConfigDialog from '../components/RoomConfigDialog.vue'
import { useConnectionStore } from '../stores/connection.ts'
import { useGameStore } from '../stores/game.ts'
import { useRoomStore } from '../stores/room.ts'
import { resumeAudio } from '../sound/index.ts'

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

/** 点击牌桌外部空白区域时，自动顺畅收起已展开的 HUD 浮动面板。 */
function handleHudPointerDown(event: PointerEvent): void {
  // 三块 HUD 面板的外部点击收起与已读锚点由 useHudPanels 统一处理。
  handleOutsidePointer(event, {
    chat: '.hud-chat-anchor',
    score: '.hud-score-anchor',
    history: '.hud-history-anchor',
  })
}

/** 页面从后台回到前台：恢复 AudioContext 并让 BGM 接上。 */
function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible') resumeAudio()
}

/* ───────────── HUD 浮层（聊天 / 计分板 / 手牌历史） ─────────────
 * 状态与交互全部收敛在 useHudPanels，并用 provideHudPanels 提供唯一实例给三个子组件。
 * 页面自身只需要展开状态、收起逻辑与外部点击收起。 */

const {
  chatOpen: _hudChatOpen,
  scoreOpen: hudScoreOpen,
  historyOpen: hudHistoryOpen,
  toggleScore,
  toggleHistory,
  openHistory,
  handleOutsidePointer,
} = provideHudPanels({
  sendChat: (text) => sendChat(text),
  heroPlayerId: () => game.self?.playerId ?? null,
})

/** 邀请弹窗显隐。 */
const inviteDialogOpen = ref(false)
const roomCode = computed(() => room.roomId ?? props.roomId)
const inviteLink = computed(() => room.inviteUrl || `${window.location.origin}/table/${props.roomId}`)

function openInviteDialog(): void {
  inviteDialogOpen.value = true
}

/** 这一手是否在进行（决定底牌是否翻面、状态文案）。 */
const isHandActive = computed(() => {
  const state = game.state
  if (!state) return false
  return state.phase !== 'waiting' && state.phase !== 'settlement'
})

/* ───────────── 接入（凭证/WebSocket/进桌表单，实现在 useTableSession） ───────────── */

const {
  joining,
  joinNickname,
  joinPassword,
  joinError,
  joinInfo,
  joinInfoError,
  submitJoin,
  onMountedCleanup,
} = useTableSession({
  roomId: () => props.roomId,
  scenario: () => scenario,
  loadCredentials,
  storedCredentials: () => room.credentials,
  setCredentials: (credentials) => {
    room.setCredentials(credentials as Parameters<typeof room.setCredentials>[0])
  },
  defaultNickname: () => room.nickname,
  isDev,
  applyScenario: async (name) => {
    await applyScenario(name)
    return unavailable.value ? { kind: 'redirect' } : { kind: 'ok' }
  },
  onScenarioRedirect: () => {
    void router.push({
      name: 'error',
      query: { kind: 'mock', code: 'scenario', detail: '模拟场景不可用' },
    })
  },
})

// 页面级副作用：点击空白收起 HUD 面板、切回前台恢复音频。
onMounted(() => {
  window.addEventListener('pointerdown', handleHudPointerDown)
  document.addEventListener('visibilitychange', handleVisibilityChange)
})
onMountedCleanup(() => {
  window.removeEventListener('pointerdown', handleHudPointerDown)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})

/* ───────────── 倒计时（以服务端时间为准，实现在 useTurnTimer） ───────────── */

const {
  remainingSeconds,
  remainingRatio,
  nextHandRemainingSeconds,
  nextHandCountdownVisible,
  turnSeconds,
} = useTurnTimer({
  turnDeadlineAt: () => game.state?.turnDeadlineAt ?? null,
  nextHandDeadlineAt: () => game.state?.nextHandDeadlineAt ?? null,
  turnSeconds: () => game.state?.turnSeconds,
  clockOffsetMs: () => connection.clockOffsetMs,
  isSettlement: () => game.state?.phase === 'settlement',
})

/** 当前玩家 id。 */
const myPlayerId = computed(() => game.self?.playerId ?? null)

/** 桌面要画的座位：本人座位固定在下沿中央（由 PokerTable 处理），这里只提供数据。 */
const displaySeats = computed(() => game.seats)

/** 本人底牌（服务端只发给本人）。 */
const myCards = computed<readonly Card[]>(() => game.myHoleCards)
const myStack = computed(() => game.mySeat?.stack ?? 0)

/** 本人底牌翻面用：非本手时为空（露出背面）。 */
const displayHeroCards = computed<readonly Card[]>(() => (isHandActive.value ? myCards.value : []))

/** 桌面公共牌：一手结束后清空，呈现空牌槽。 */
const displayBoard = computed<readonly Card[]>(() => (isHandActive.value ? game.board : []))

/** 桌面阶段（PokerTable 用；等待态传 null）。 */
const displayStreet = computed(() => (isHandActive.value ? (game.state?.street ?? null) : null))

/** 当前底池。 */
const potTotal = computed(() => game.state?.potTotal ?? 0)

/** 当前牌型名（如「一对 A」），无牌型时为空。 */
const currentHandName = computed(() =>
  isHandActive.value && displayHeroCards.value.length === 2
    ? describeHand([...displayHeroCards.value, ...displayBoard.value])
    : '',
)

/** 操作区为什么不可用（空串表示可以操作）。 */
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

/* ───────────── 座位概况（实现在 useSeatOverview） ───────────── */

const { occupiedCount, maxSeats, emptyCount, isTableFull, firstAvailableSeat, canSitDown } = useSeatOverview({
  seats: () => game.seats,
  maxSeats: () => game.state?.maxSeats,
  isSeated: () => game.isSeated,
  hasSelf: () => Boolean(game.self),
})

/** 赢家 id（座位高亮用）。 */
const winnerPlayerIds = computed(() => game.state?.lastResult?.winners.map((winner) => winner.playerId) ?? [])

/** 本手每个赢家赢得的筹码（同一人可能同时赢主池与边池，需要累加）。 */
const winAmounts = computed<Record<string, number>>(() => {
  const result = game.state?.lastResult
  if (!result) return {}
  const map: Record<string, number> = {}
  for (const winner of result.winners) {
    map[winner.playerId] = (map[winner.playerId] ?? 0) + winner.amount
  }
  return map
})

/** 赢家的最佳五张（桌面高亮用）。 */
const highlightCards = computed<readonly Card[]>(() => {
  if (!isHandActive.value) return []
  const result = game.state?.lastResult
  if (!result || !result.showdown) return []
  return result.winners.flatMap((winner) => winner.bestFive)
})

/* ───────────── 结算叠层（实现在 useHandResult） ───────────── */

const { result, overlayVisible, activeHeroCards, closeResult } = useHandResult({
  roomId: () => props.roomId,
  lastResult: () => game.state?.lastResult ?? null,
  handNo: () => game.state?.handNo,
  phase: () => game.state?.phase,
  heroCards: () => game.myHoleCards,
})

/* ───────────── 界面派生状态与播报 ───────────── */

/** 阶段文案：等待开局 / 翻牌 / 转牌 / 河牌 / 结算。 */
const streetText = computed(() => {
  if (!isHandActive.value) return game.state?.status === 'waiting' ? '等待开局' : '等待下一手发牌'
  const street = game.state?.street
  if (!street) return '等待发牌'
  return STREET_NAMES[street]
})

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
    if (handNo !== null && handNo !== undefined) {
      announcement.value = `轮到你行动，请在 ${String(turnSeconds.value)} 秒内选择动作。`
    }
  },
)

/** 房间配置弹窗（房主）。 */
const configDialogOpen = ref(false)

/* ───────────── 发命令（入座/换座/离座/退出/动作/开局/移除玩家） ─────────────
 * 全部收敛到 useTableCommands；页面只负责把用户点击转成这里的调用。 */

const {
  buyInOpen,
  buyInSeat,
  isRebuyDialog,
  buyInMin,
  buyInMax,
  buyInStep,
  canRebuy,
  openBuyIn,
  openRebuy,
  confirmBuyIn: onBuyInConfirm,
  cancelBuyIn: onBuyInCancel,
  mySeatAway,
  myReservedSeat,
  canPickSeat,
  myCommittedStreet,
  pickSeat: onPickSeat,
  resit,
  leaveSeatOpen,
  exitRoomOpen,
  requestLeaveSeat,
  leaveSeat,
  exitRoom,
  submitAction,
  hasPlayedHand,
  canStartNextHand,
  startNextHand,
  kickOpen,
  requestMembers,
  confirmKick,
} = useTableCommands({
  sendCommand: (command) => sendCommand(command as ClientCommand),
  nextRequestId,
  announce: (text: string) => {
    announcement.value = text
  },
  state: () => game.state,
  mySeat: () => game.mySeat,
  selfSeat: () => game.self?.seat ?? null,
  isHost: () => room.isHost,
  isOnline: () => connection.isOnline,
  members: () => room.members,
  onExitRoom: () => {
    room.clear()
    void router.push({ name: 'lobby' })
  },
})

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

    <!-- 邀请链接落地页（组件内只有展示，状态由本页持有） -->
    <JoinGate
      :room-id="props.roomId"
      :has-credentials="room.hasCredentials"
      :state="game.state"
      :info="joinInfo"
      :info-error="joinInfoError"
      :error="joinError"
      :submitting="joining"
      :nickname="joinNickname"
      :password="joinPassword"
      @update:nickname="joinNickname = $event"
      @update:password="joinPassword = $event"
      @submit="submitJoin"
      @back="router.push({ name: 'lobby' })"
    />

    <template v-if="room.hasCredentials || Boolean(game.state)">
    <ConnectionBanner />

    <!-- 顶部：房间名、盲注、连接状态、设置与退出（规格书 §3.3）。 -->
    <!-- 顶栏：房间信息 + 配置/声音/分享（HUD 胶囊已迁到桌面） -->
    <TableTopBar
      :room-name="game.state?.roomName || '牌桌'"
      :is-host="room.isHost"
      :small-blind="game.state?.smallBlind ?? TABLE_RULES.smallBlind"
      :big-blind="game.state?.bigBlind ?? TABLE_RULES.bigBlind"
      :hand-no="game.state?.handNo ?? 0"
      :street-text="streetText"
      :street="game.state?.street ?? 'wait'"
      :online="connection.isOnline"
      @configure="configDialogOpen = true"
      @share="openInviteDialog"
      @members="kickOpen = true"
      @leave="requestLeaveSeat"
      @exit="exitRoomOpen = true"
    />

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
      <!-- 桌面左上角 HUD 快捷聊天（状态在 useHudPanels，界面在 HudChatPanel）。 -->
      <HudChatPanel :hero-player-id="myPlayerId" />

      <!-- 本桌累计计分板：曾入座者离桌后仍显示（组件内部排序与合计）。 -->
      <HudScorePanel
        :scores="game.state?.scores ?? []"
        :open="hudScoreOpen"
        @toggle="toggleScore"
        @close="hudScoreOpen = false"
      />

      <!-- 桌面右上角 HUD 快捷手牌历史（模型与卡片在 HudHistoryPanel 内）。 -->
      <HudHistoryPanel
        :history="game.history"
        :seats="game.seats"
        :hero-player-id="game.self?.playerId ?? null"
        :open="hudHistoryOpen"
        @toggle="toggleHistory"
        @close="hudHistoryOpen = false"
      />

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
        :win-amounts="winAmounts"
        :highlight-cards="highlightCards"
        :street="displayStreet"
        :can-pick-seat="canPickSeat"
        :reserved-seat="myReservedSeat"
        @pick-seat="onPickSeat"
      >
        <!-- 牌桌右下角的席位操作：离座 / 退出房间 -->
        <template #corner-actions>
          <button
            v-if="!mySeatAway"
            type="button"
            class="seat-corner-btn"
            aria-label="离座"
            title="离座（座位与筹码为你保留）"
            @click="requestLeaveSeat"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="13" cy="4" r="1.8" />
              <line x1="7" y1="21" x2="10" y2="17" />
              <path d="M16 21l-2-4-3-3 1-6" />
              <path d="M6 12l2-3 4-1 3 3 3 1" />
            </svg>
          </button>
          <button
            type="button"
            class="seat-corner-btn"
            aria-label="退出房间"
            title="退出房间（释放座位）"
            @click="exitRoomOpen = true"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </template>
      </PokerTable>
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
    <!-- 底部：一体化沉浸式玩家座舱（三分支与操作区都在 HeroCockpit 内）。 -->
    <HeroCockpit
      v-if="!unavailable"
      :seated="game.isSeated"
      :away="mySeatAway"
      :stack="myStack"
      :committed-street="myCommittedStreet"
      :display-hero-cards="displayHeroCards"
      :my-cards="myCards"
      :hand-active="isHandActive"
      :folded="Boolean(game.mySeat?.folded)"
      :hand-name="currentHandName"
      :pending-buy-in="game.mySeat?.pendingBuyIn ?? 0"
      :legal-actions="game.myLegalActions"
      :pot-total="potTotal"
      :current-bet="game.state?.currentBet ?? 0"
      :is-my-turn="game.isMyTurn"
      :remaining-seconds="remainingSeconds"
      :turn-seconds="turnSeconds"
      :remaining-ratio="remainingRatio"
      :turn-deadline-at="game.state?.turnDeadlineAt ?? null"
      :clock-offset-ms="connection.clockOffsetMs"
      :blocked-reason="blockedReason"
      :online="connection.isOnline"
      :can-start-hand="canStartNextHand"
      :has-played-hand="hasPlayedHand"
      :is-host="room.isHost"
      :can-rebuy="canRebuy"
      :occupied-count="occupiedCount"
      :max-seats="maxSeats"
      :empty-count="emptyCount"
      :is-table-full="isTableFull"
      :first-available-seat="firstAvailableSeat"
      :can-sit-down="canSitDown"
      @action="submitAction"
      @start="startNextHand"
      @leave="requestLeaveSeat"
      @exit="exitRoomOpen = true"
      @rebuy="openRebuy"
      @resit="resit"
      @sit="openBuyIn"
    />
    <!-- 专属邀请朋友弹窗 -->
    <RoomConfigDialog v-if="room.isHost && game.state" v-model:visible="configDialogOpen" :state="game.state" />
    <InviteDialog v-model:visible="inviteDialogOpen" :room-code="roomCode" :invite-link="inviteLink" />

    <!-- 结算叠层：赢家、牌型与各边池分配。 -->
    <HandResultOverlay
      v-if="result && overlayVisible"
      :result="result"
      :seats="game.seats"
      :hero-player-id="game.self?.playerId ?? null"
      :my-cards="activeHeroCards"
      :visible="overlayVisible"
      :next-hand-seconds="nextHandCountdownVisible ? nextHandRemainingSeconds : null"
      @close="closeResult"
      @history="openHistory"
    />

    <!-- 买入确认：房主定的上限 + 服务端校验的下限/步进（逻辑在 BuyInDialog 内） -->
    <BuyInDialog
      v-model:visible="buyInOpen"
      :seat="buyInSeat"
      :min="buyInMin"
      :max="buyInMax"
      :step="buyInStep"
      :rebuy="isRebuyDialog"
      @confirm="onBuyInConfirm"
      @cancel="onBuyInCancel"
    />

    <!-- 离座确认（本手仍在牌局中会同时弃牌）：骨架见 ConfirmDialog.vue -->
    <ConfirmDialog
      v-model:visible="leaveSeatOpen"
      title="离座并弃牌？"
      description="你还在这一手里。离座会同时弃牌，已投入的筹码留在底池。座位与筹码会为你保留，随时可以坐回。"
      confirm-label="离座并弃牌"
      cancel-label="继续打这一手"
      @confirm="leaveSeat"
    >
      <template #danger-icon>
        <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="13" cy="4" r="1.8" />
          <line x1="7" y1="21" x2="10" y2="17" />
          <path d="M16 21l-2-4-3-3 1-6" />
          <path d="M6 12l2-3 4-1 3 3 3 1" />
        </svg>
      </template>
    </ConfirmDialog>

    <!-- 退出房间确认：真正释放座位（与「离座」不同，会销毁座位里的筹码） -->
    <ConfirmDialog
      v-model:visible="exitRoomOpen"
      title="退出房间？"
      description="退出会释放你的座位并离开这个房间（座位里的筹码不再保留）。只想暂时离开的话请用「离座」——座位与筹码都会留着。"
      confirm-label="退出房间"
      @confirm="exitRoom"
    >
      <template #danger-icon>
        <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      </template>
    </ConfirmDialog>

    <!-- 主持人移除玩家：名单与就地二次确认在 MemberPickerDialog 内。 -->
    <MemberPickerDialog
      v-model:visible="kickOpen"
      :members="room.members"
      :self-id="game.self?.playerId ?? null"
      @remove="confirmKick"
      @request="requestMembers"
    />
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
  /* 留白来自 table-geometry.ts 的档位表（竖屏/超短屏各不相同），这里只消费。 */
  padding: var(--stage-pad-top, 4px) var(--stage-pad-right, 16px) var(--stage-pad-bottom, 0px)
    var(--stage-pad-left, 16px);
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

/* ═══════════════ 全功能信息弹窗与不透明黑金面板 ═══════════════ */
/*
 * 拟物弹窗底板：皮革 + 木纹细纹 + 黄铜内描边 + 内凹高光。
 *
 * Dialog 由 PrimeVue 通过 teleport 挂到 body 下，**不是**当前组件的子元素，
 * 所以带 scope 属性选择器（`[data-v-xxx] .vip-dialog`）永远匹配不到它；
 * 必须用 :global 让规则真正落到 .vip-dialog 上（历史样式里的 :deep 也因此失效过）。
 */
:global(.p-dialog.vip-dialog) {
  background:
    repeating-linear-gradient(115deg, rgba(255, 255, 255, 0.012) 0 3px, transparent 3px 9px),
    linear-gradient(180deg, #2a2118 0%, #1b150f 55%, #120e0a 100%) !important;
  background-color: #1b150f !important;
  border: 1px solid #000 !important;
  border-radius: 20px !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    inset 0 -3px 8px rgba(0, 0, 0, 0.75),
    0 0 0 1.5px rgba(138, 106, 50, 0.7),
    0 24px 60px rgba(0, 0, 0, 0.85) !important;
  opacity: 1 !important;
}

/* 结算叠层：更深的胡桃木皮（玩家停留最久的界面）。 */
:global(.p-dialog.vip-dialog.result-skin) {
  background:
    repeating-linear-gradient(112deg, rgba(255, 255, 255, 0.014) 0 3px, transparent 3px 9px),
    linear-gradient(180deg, #2f2419 0%, #1e1611 55%, #140f0b 100%) !important;
  background-color: #1e1611 !important;
}

:global(.p-dialog.vip-dialog .p-dialog-header),
:global(.p-dialog.vip-dialog .p-dialog-content),
:global(.p-dialog.vip-dialog .p-dialog-footer) {
  background: transparent !important;
  color: #f1e6d0;
}

/*
 * 确认弹窗（离座 / 退出 / 移除玩家）：与结算叠层共用皮革底板，
 * 弹窗内部由 Dialog teleport 到 body，必须用 :global 才能命中。
 */
:global(.p-dialog.confirm-dialog .p-dialog-header) {
  padding: 14px 18px 10px !important;
  border-bottom: 1px solid rgba(138, 106, 50, 0.4) !important;
}

:global(.p-dialog.confirm-dialog .p-dialog-title) {
  font-size: 1rem !important;
  font-weight: 800 !important;
  color: #f6ecd8 !important;
  text-shadow: 0 1px 0 #000 !important;
}

:global(.p-dialog.confirm-dialog .p-dialog-content) {
  padding: 14px 18px !important;
  font-size: 0.84rem !important;
  line-height: 1.65 !important;
  color: #cbbd9f !important;
}

:global(.p-dialog.confirm-dialog .p-dialog-footer) {
  display: flex !important;
  justify-content: flex-end !important;
  gap: 10px !important;
  padding: 6px 18px 16px !important;
}

/* 危险操作按钮（离座并弃牌 / 退出房间 / 移除）：酒红压印 */
:global(.p-dialog.confirm-dialog .p-dialog-footer .p-button.p-button-danger) {
  min-height: 40px;
  padding: 0 16px;
  border-radius: 12px;
  background: linear-gradient(180deg, #8e2f31 0%, #611d20 60%, #47161a 100%);
  border: 1px solid #35090c;
  color: #ffe3d2;
  font-weight: 800;
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.6);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.22),
    inset 0 -3px 5px rgba(0, 0, 0, 0.5),
    0 3px 0 #2e0709,
    0 8px 16px rgba(0, 0, 0, 0.55);
}

:global(.p-dialog.confirm-dialog .p-dialog-footer .p-button.p-button-text) {
  min-height: 40px;
  padding: 0 14px;
  color: #cbbd9f;
  font-weight: 600;
}

/* ═══════════════ 弹窗与确认框 ═══════════════ */
/* 买入弹窗的样式随组件迁到 BuyInDialog.vue。 */
/* ═══════════════ 响应式屏幕适配 ═══════════════ */
/* 手机横屏屏蔽 */
.portrait-only {
  display: none;
}

@media (orientation: landscape) and (max-height: 560px) {
  .table-view > .bar,
  .table-view > .notice-strip,
  .table-view > .stage,
  .table-view > :deep(.p-drawer) {
    display: none;
  }

  /* 座舱是子组件根节点，作用域属性只落在它的根元素上，用 :deep 从父级命中 */
  .table-view > :deep(.hero) {
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
  /*
   * 竖屏重构：桌面吃掉舞台的剩余高度，底部座舱压缩。
   * 顶部 50px 给 HUD 浮动胶囊（聊天/计分板/手牌历史）让位，
   * 底部 38px 给本人座位面板与英雄手牌区留呼吸空间。
   */
  .stage {
    align-items: stretch;
  }

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
    padding: 2px 6px 4px;
  }

  /* 竖屏底部座舱：木纹底板 + 顶部一道黄铜压条，与牌桌同一材质。
     木纹用「中等深度」的棕，避免比牌桌还黑；黄铜条负责把木纹和操作区分开。 */
  .hero {
    background:
      repeating-linear-gradient(96deg, rgba(255, 255, 255, 0.02) 0 2px, transparent 2px 7px),
      repeating-linear-gradient(3deg, rgba(0, 0, 0, 0.2) 0 3px, transparent 3px 11px),
      linear-gradient(180deg, #3a2b1f 0%, #241a13 55%, #150f0b 100%);
    border-top: 1px solid rgba(0, 0, 0, 0.85);
    box-shadow:
      inset 0 1px 0 rgba(232, 204, 150, 0.28),
      0 -10px 26px rgba(0, 0, 0, 0.7);
  }

  .hero-cockpit {
    padding: 4px 8px;
    gap: 4px;
  }

  /* 竖屏操作区：黄铜压花皮革面板 + 内嵌缝线（对应设计稿的 dock）。 */
  .cockpit-wing--action {
    position: relative;
    padding: 9px 10px;
    border-radius: 16px;
    background: var(--leather-panel-bg, linear-gradient(180deg, #2b2219, #120d09));
    border: 1px solid #000;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.16),
      inset 0 -2px 6px rgba(0, 0, 0, 0.75),
      0 2px 0 #0a0705,
      0 12px 26px rgba(0, 0, 0, 0.65);
  }

  .cockpit-wing--action::before {
    content: '';
    position: absolute;
    inset: 5px;
    border-radius: 12px;
    border: 1.3px dashed var(--stitch, rgba(232, 204, 150, 0.26));
    pointer-events: none;
  }

  .cockpit-wing--action > * {
    position: relative;
    z-index: 1;
  }
  .hero-cockpit :deep(.card--lg) {
    --cw: 56px;
  }

  .fan-card--0 {
    transform: rotate(-15deg) translateX(3px) translateY(-1px);
  }

  .fan-card--1 {
    transform: rotate(15deg) translateX(-10px) translateY(-1px);
  }

  .hero-seat-actions :deep(.sub-action-btn) {
    padding: 3px 5px !important;
    font-size: 0.74rem !important;
  }

  .hero-seat-actions :deep(.hero-start-btn) {
    padding: 5px 8px !important;
    font-size: 0.76rem !important;
  }

  /* ── 竖屏座舱压缩：把空间还给牌桌 ──
   * 座舱原来「手牌 / 牌型 / 筹码 / 重新买入 / 离座 / 退出」各占一行，竖屏要 358px。
   * 这里压成「手牌 + 右侧两行资产区」，按钮收成图标/短文案，目标 ≤280px。 */
  .cockpit-badge-row {
    align-items: center;
    gap: 4px;
  }

  .hero-hand {
    padding: 2px 8px;
  }

  .hand-name {
    font-size: 0.8rem;
  }

  .hero-stack {
    flex-wrap: nowrap;
    gap: 4px;
    padding: 2px 6px;
  }

  .stack-label {
    font-size: 0.66rem;
  }

  .stack-num {
    font-size: 0.92rem;
  }

  .hero-stack :deep(.rebuy-btn) {
    min-height: 26px;
    margin-left: 0;
    padding: 1px 5px !important;
    border-radius: 6px !important;
    background: linear-gradient(180deg, #3b2f22 0%, #241b12 100%) !important;
    border: 1px solid rgba(0, 0, 0, 0.75) !important;
    color: #ffdf9a !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 2px 4px rgba(0, 0, 0, 0.5) !important;
  }

  /* 重新买入只留图标，文案仍在 aria-label / title 里。 */
  .hero-stack :deep(.rebuy-btn span) {
    display: none;
  }

  .hero-seat-actions {
    margin-top: 0;
    gap: 4px;
  }

  .hero-seat-actions :deep(.sub-action-btn) {
    min-height: 34px;
    padding: 3px 7px !important;
  }

  .hero-seat-actions :deep(.sub-btn-text) {
    display: none;
  }

  .hero-seat-actions :deep(.hero-start-btn) {
    min-height: 34px;
    padding: 3px 10px !important;
    font-size: 0.74rem !important;
  }

  /* 超短屏（≤568px 高）：舞台上下留白收紧、底部座舱进一步压缩，
     把纵向空间让给牌桌（否则 9 人环会压到公共牌）。 */
  @media (max-height: 600px) {
    .hero-cockpit :deep(.card--lg) {
      --cw: 44px;
    }

    .cockpit-wing--action {
      padding: 7px 8px;
    }
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

</style>