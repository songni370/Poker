<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Drawer from 'primevue/drawer'
import Select from 'primevue/select'
import type { ActionType, Card } from '../../shared/poker.ts'
import { STREET_NAMES, TABLE_RULES } from '../../shared/poker.ts'
import { connectRoom, loadCredentials, nextRequestId, sendCommand, useSessionStore } from '../net/session.ts'
import ActionBar from '../components/ActionBar.vue'
import ConnectionBanner from '../components/ConnectionBanner.vue'
import HandResultOverlay from '../components/HandResultOverlay.vue'
import PlayingCard from '../components/PlayingCard.vue'
import PokerTable from '../components/PokerTable.vue'
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

const historyEntries = computed(() => {
  const result = game.state?.lastResult
  if (!result) return []
  return [
    {
      handNo: result.handNo,
      street: STREET_NAMES.river,
      pot: result.potTotal,
      winners: result.winners.length,
    },
  ]
})

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
      <Button size="small" text aria-label="手牌历史" :title="'查看手牌历史'" @click="openDrawer('history')">
        <i class="pi pi-list" aria-hidden="true" />
        <span>历史</span>
      </Button>
      <Button size="small" text aria-label="聊天" :title="'聊天（第 3 阶段开放）'" @click="openDrawer('chat')">
        <i class="pi pi-comments" aria-hidden="true" />
        <span>聊天</span>
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
      <div class="hero-cards">
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

      <ActionBar
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
        <ol v-if="historyEntries.length > 0">
          <li v-for="entry in historyEntries" :key="entry.handNo">
            第 {{ entry.handNo }} 手 · 底池 <span class="num">{{ entry.pot }}</span> · 赢家 {{ entry.winners }} 位
          </li>
        </ol>
        <p v-else class="hint">还没有已结算的手牌。每手结束后这里会记录底池与赢家。</p>
      </section>

      <section v-else class="drawer-body" aria-label="聊天">
        <h3>聊天</h3>
        <p class="hint">聊天将在第 3 阶段随联机一起开放；当前版本不发送任何内容。</p>
      </section>
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

.drawer-body ol {
  margin: 0;
  padding-left: 1.2em;
  display: grid;
  gap: 4px;
  font-size: 0.84rem;
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
