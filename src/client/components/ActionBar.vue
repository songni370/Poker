<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import type { LegalAction } from '../../shared/protocol.ts'
import { clampAmount, quickSizes, type QuickSize } from './action-bar-sizing.ts'

const props = withDefaults(
  defineProps<{
    /** 服务端给出的合法动作，ActionBar 渲染按钮的唯一依据。 */
    legalActions: readonly LegalAction[]
    /** 底池总额，用于计算 1/2 底池、底池等快捷额度。 */
    potTotal?: number
    /** 当前轮次最高下注。 */
    currentBet?: number
    /** 本人剩余筹码。 */
    myStack?: number
    /** 是否轮到本人；false 时按钮全部禁用。 */
    isMyTurn?: boolean
    /** 剩余秒数与总秒数，用于倒计时进度条与文本。 */
    remainingSeconds?: number
    turnSeconds?: number
    /** 剩余比例 0..1，用于平滑进度条。 */
    remainingRatio?: number
    /** 服务端截止时间戳（毫秒） */
    turnDeadlineAt?: number | null
    /** 本地与服务端时钟偏差（毫秒） */
    clockOffsetMs?: number
    /** 无法行动时展示的原因，每个禁用按钮的 title 也会带上它。 */
    blockedReason?: string
    /** 链路异常时禁止提交。 */
    enabled?: boolean
    /** 主持人现在能不能开下一手（等待中或已结算）。 */
    canStartHand?: boolean
    /** 是否已经开过手：决定按钮写「开始牌局」还是「开始下一手」。 */
    hasPlayedHand?: boolean
    /** 本人是否在座（在座才显示「离座」）。 */
    seated?: boolean
  }>(),
  {
    potTotal: 0,
    currentBet: 0,
    myStack: 0,
    isMyTurn: false,
    remainingSeconds: 0,
    turnSeconds: 20,
    remainingRatio: 1,
    turnDeadlineAt: null,
    clockOffsetMs: 0,
    blockedReason: '',
    enabled: true,
    canStartHand: false,
    hasPlayedHand: false,
    seated: false,
  },
)

const emit = defineEmits<{
  /** 提交一个动作；amount 语义与协议一致：call=补筹码，bet/raise=目标总额。 */
  (event: 'action', payload: { action: LegalAction['action']; amount?: number }): void
  /** 主持人开始（下一）手。 */
  (event: 'start'): void
  /** 离座（座位与筹码保留，随时可坐回）。 */
  (event: 'leave'): void
  /** 退出房间（释放座位）。 */
  (event: 'exit'): void
}>()

const byAction = computed(() => {
  const map = new Map<LegalAction['action'], LegalAction>()
  for (const item of props.legalActions) map.set(item.action, item)
  return map
})

const foldAction = computed(() => byAction.value.get('fold'))
const checkAction = computed(() => byAction.value.get('check'))
const callAction = computed(() => byAction.value.get('call'))
const betAction = computed(() => byAction.value.get('bet'))
const raiseAction = computed(() => byAction.value.get('raise'))
const allInAction = computed(() => byAction.value.get('all_in'))

/** 下注/加注共用一个尺寸控件，先满足哪个就用哪个。 */
const sizing = computed(() => betAction.value ?? raiseAction.value ?? null)
const sizingAction = computed<'bet' | 'raise' | null>(() => (betAction.value ? 'bet' : raiseAction.value ? 'raise' : null))

const canAct = computed(() => props.isMyTurn && props.enabled)
/** 无法行动时的统一说明，直接出现在按钮 title 上。 */
const reason = computed(() => props.blockedReason || (props.isMyTurn ? 'Action unavailable' : 'Waiting for turn'))
const reasonFor = computed(() => (canAct.value ? '' : reason.value))

const minAmount = computed(() => sizing.value?.min ?? 0)
const maxAmount = computed(() => sizing.value?.max ?? props.myStack)
const callAmount = computed(() => callAction.value?.amount ?? Math.max(0, props.currentBet))
const allInAmount = computed(() => allInAction.value?.amount ?? props.myStack)

const amount = ref(0)

/** 尺寸控件出现或范围变化时收敛到合法区间。 */
watch(
  () => [minAmount.value, maxAmount.value] as const,
  ([min, max]) => {
    amount.value = Math.min(Math.max(amount.value || min, min), max)
  },
  { immediate: true },
)

/**
 * 唯一的取整 + 边界函数：数字输入、快捷额度与提交动作都走它。
 */
function clamp(value: number): number {
  return clampAmount(value, minAmount.value, maxAmount.value)
}

/** 快捷步进变化量：优先按小盲/大盲步进 */
const stepDelta = computed(() => {
  const span = maxAmount.value - minAmount.value
  if (span <= 50) return 5
  if (span <= 500) return 10
  return 20
})

function stepDown(): void {
  if (!canAct.value) return
  amount.value = clamp(amount.value - stepDelta.value)
}

function stepUp(): void {
  if (!canAct.value) return
  amount.value = clamp(amount.value + stepDelta.value)
}

function onAmountInput(event: Event): void {
  const target = event.target as HTMLInputElement
  const parsed = parseInt(target.value, 10)
  if (!Number.isNaN(parsed)) {
    amount.value = clamp(parsed)
  }
}

/**
 * 快捷额度：1/2、2/3、满池、超池。
 */
const quickAmounts = computed<QuickSize[]>(() => {
  const kind = sizingAction.value
  if (!kind) return []
  return quickSizes({
    min: minAmount.value,
    max: maxAmount.value,
    potTotal: props.potTotal,
    callAmount: callAmount.value,
    action: kind,
  })
})

function applyQuick(quick: QuickSize): void {
  if (!canAct.value || quick.disabled) return
  amount.value = quick.value
}

function applyMin(): void {
  if (!canAct.value) return
  amount.value = minAmount.value
}

const isAtMaxAmount = computed(() => amount.value >= maxAmount.value && maxAmount.value > 0)
const isAtMinAmount = computed(() => amount.value <= minAmount.value)

const confirmAllIn = ref(false)

function sendAction(action: LegalAction['action'], value?: number): void {
  if (!canAct.value) return
  emit('action', value === undefined ? { action } : { action, amount: value })
}

function submitSizing(): void {
  if (!sizingAction.value) return
  sendAction(sizingAction.value, clamp(amount.value))
}

function askAllIn(): void {
  if (!canAct.value) return
  confirmAllIn.value = true
}

function confirmAllInAction(): void {
  confirmAllIn.value = false
  sendAction('all_in')
}

const timerFillRef = shallowRef<HTMLElement | null>(null)
let timerRafId = 0

function updateTimer(): void {
  if (!props.isMyTurn) {
    if (timerFillRef.value) {
      timerFillRef.value.style.transform = 'scaleX(0)'
    }
    return
  }

  let ratio = props.remainingRatio ?? 1
  if (props.turnDeadlineAt) {
    const now = Date.now() + props.clockOffsetMs
    const rem = Math.max(0, props.turnDeadlineAt - now)
    const total = Math.max(1, props.turnSeconds * 1000)
    ratio = Math.max(0, Math.min(1, rem / total))
  }

  if (timerFillRef.value) {
    timerFillRef.value.style.transform = `scaleX(${ratio})`
  }

  if (props.isMyTurn && (ratio > 0 || (props.remainingSeconds ?? 0) > 0)) {
    timerRafId = requestAnimationFrame(updateTimer)
  }
}

watch(
  () => [props.isMyTurn, props.turnDeadlineAt, props.turnSeconds],
  async () => {
    cancelAnimationFrame(timerRafId)
    timerRafId = 0
    if (props.isMyTurn) {
      await nextTick()
      updateTimer()
    } else if (timerFillRef.value) {
      timerFillRef.value.style.transform = 'scaleX(0)'
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  cancelAnimationFrame(timerRafId)
})

const isUrgentTimer = computed(() => props.isMyTurn && props.remainingSeconds <= 5)

/** 针对无障碍读屏的提示文本 */
const liveText = computed(() => {
  if (!props.isMyTurn) return ''
  const parts = ['Your turn to act']
  if (callAction.value) parts.push(`Call ${String(callAmount.value)}`)
  if (allInAction.value) parts.push(`All in ${String(allInAmount.value)}`)
  return parts.join(', ')
})
</script>

<template>
  <section class="action-console" aria-label="Action Console">
    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ liveText }}</p>

    <!-- 1. 一体化竞技倒计时舱（进度条与时间深度融铸在同一胶囊跑道内） -->
    <div
      v-if="isMyTurn"
      class="turn-timer-integrated"
      :class="{ 'is-urgent': isUrgentTimer }"
      role="progressbar"
      :aria-valuenow="remainingSeconds"
      aria-valuemin="0"
      :aria-valuemax="turnSeconds"
      :aria-label="`行动倒计时，剩余 ${remainingSeconds} 秒`"
    >
      <!-- 进度条底槽与平滑硬件加速填充层 -->
      <div class="timer-track-bar">
        <div
          ref="timerFillRef"
          class="timer-progress-fill"
          :style="{ transform: `scaleX(${remainingRatio ?? 1})` }"
        />
        <div class="timer-ambient-glow" />
      </div>

      <!-- 居中内嵌倒计时信息：行动提示与醒目时间数字 -->
      <div class="timer-overlay-content">
        <div class="timer-lead">
          <i class="pi pi-clock timer-lead-icon" aria-hidden="true" />
          <span class="timer-lead-title">轮到你行动</span>
        </div>
        <div class="timer-time-box num">
          <span class="timer-digits">{{ remainingSeconds }}</span>
          <span class="timer-unit">S</span>
        </div>
      </div>
    </div>

    <!-- 2. 全新双舱协同布局 -->
    <div class="actions-dock">
      <!-- 轮到本人且存在可用动作 -->
      <div v-if="canAct && legalActions.length > 0" class="dock-layout">
        <!-- 【左舱：防守与跟随组 (CHECK / CALL 与 FOLD)】 -->
        <div class="dock-panel panel--defend">
          <!-- 动作 1A：CHECK 过牌（纯英文，翡翠透亮青绿） -->
          <Button
            v-if="checkAction"
            class="action-btn action-btn--check"
            aria-label="Check Hand"
            :title="reasonFor || 'CHECK'"
            :disabled="!canAct"
            @click="sendAction('check')"
          >
            <div class="btn-content">
              <i class="pi pi-check btn-icon" aria-hidden="true" />
              <span class="btn-main-title">CHECK</span>
            </div>
          </Button>

          <!-- 动作 1B：CALL 跟注（纯英文，极光深海蔚蓝，大号标注跟注额） -->
          <Button
            v-else-if="callAction"
            class="action-btn action-btn--call"
            :aria-label="`Call ${String(callAmount)}`"
            :title="reasonFor || `CALL ${String(callAmount)}`"
            :disabled="!canAct"
            @click="sendAction('call')"
          >
            <div class="btn-content">
              <i class="pi pi-arrow-down-right btn-icon" aria-hidden="true" />
              <div class="btn-title-group">
                <span class="btn-main-title">CALL</span>
                <span class="btn-chip-val num">{{ callAmount }}</span>
              </div>
            </div>
          </Button>

          <!-- 动作 2：FOLD 弃牌（纯英文，冷冽哑光宝石红） -->
          <Button
            v-if="foldAction"
            class="action-btn action-btn--fold"
            aria-label="Fold Hand"
            :title="reasonFor || 'FOLD'"
            :disabled="!canAct"
            @click="sendAction('fold')"
          >
            <div class="btn-content">
              <i class="pi pi-times btn-icon" aria-hidden="true" />
              <span class="btn-main-title">FOLD</span>
            </div>
          </Button>
        </div>

        <!-- 【右舱：金额控制与进攻加注组 (金额调节、BET / RAISE 与 ALL IN 严格在一起)】 -->
        <div v-if="sizing" class="dock-panel panel--attack">
          <!-- 上排：快捷底池比例芯片 (MIN / 1/2 / 2/3 / POT / 1.5x) -->
          <div class="quick-chips-strip" role="group" aria-label="Bet Sizing Presets">
            <button
              type="button"
              class="chip-tag"
              :class="{ 'is-selected': isAtMinAmount }"
              :disabled="!canAct"
              title="Minimum Bet"
              @click="applyMin"
            >
              <span class="chip-label">MIN</span>
              <span class="chip-val num">{{ minAmount }}</span>
            </button>

            <button
              v-for="q in quickAmounts"
              :key="q.key"
              type="button"
              class="chip-tag"
              :class="{ 'is-selected': amount === q.value && !q.disabled }"
              :disabled="!canAct || q.disabled"
              :title="q.title"
              :aria-label="q.desc"
              @click="applyQuick(q)"
            >
              <span class="chip-label">{{ q.label === 'OVERBET' ? '1.5x' : q.label }}</span>
              <span class="chip-val num">{{ q.value }}</span>
            </button>
          </div>

          <!-- 下排：金额微调步进器 + BET/RAISE 主加注按钮 + ALL IN 爆发按钮 -->
          <div class="attack-controls-row">
            <!-- 1. 金额步进数显舱 -->
            <div class="amount-stepper">
              <button
                type="button"
                class="stepper-action-btn"
                :disabled="!canAct || isAtMinAmount"
                aria-label="Decrease Amount"
                title="Decrease"
                @click="stepDown"
              >
                <i class="pi pi-minus" aria-hidden="true" />
              </button>

              <div class="stepper-center-screen" title="Click to input amount">
                <input
                  type="number"
                  class="stepper-digit-input num"
                  :value="amount"
                  :min="minAmount"
                  :max="maxAmount"
                  aria-label="Bet Amount"
                  @change="onAmountInput"
                />
              </div>

              <button
                type="button"
                class="stepper-action-btn"
                :disabled="!canAct || isAtMaxAmount"
                aria-label="Increase Amount"
                title="Increase"
                @click="stepUp"
              >
                <i class="pi pi-plus" aria-hidden="true" />
              </button>
            </div>

            <!-- 2. BET / RAISE 主加注按键（拉丝黑金流光，纯英文大字与目标金额） -->
            <Button
              class="action-btn action-btn--primary"
              :class="{ 'action-btn--glow-max': isAtMaxAmount }"
              :aria-label="`${sizingAction === 'bet' ? 'BET' : 'RAISE'} ${String(amount)}`"
              :title="`${reasonFor || 'Confirm and place bet'} (${String(minAmount)}–${String(maxAmount)})`"
              :disabled="!canAct"
              @click="submitSizing"
            >
              <div class="btn-content">
                <i :class="isAtMaxAmount ? 'pi pi-bolt' : 'pi pi-arrow-up-right'" class="btn-icon" aria-hidden="true" />
                <div class="btn-title-group">
                  <span class="btn-main-title">{{ sizingAction === 'bet' ? 'BET' : 'RAISE' }}</span>
                  <span class="btn-chip-val num">{{ amount }}</span>
                </div>
              </div>
            </Button>

            <!-- 3. ALL IN 战术爆发按钮（与金额和加注同舱共列，激光朱红，纯英文字样） -->
            <Button
              class="action-btn action-btn--allin"
              :class="{ 'is-selected': isAtMaxAmount }"
              :disabled="!canAct"
              :title="canAct ? `ALL IN ${allInAmount}` : (reasonFor || 'ALL IN')"
              :aria-label="`All In ${String(allInAmount)}`"
              @click="askAllIn"
            >
              <div class="btn-content">
                <i class="pi pi-bolt btn-icon" aria-hidden="true" />
                <div class="btn-title-group">
                  <span class="btn-main-title">ALL IN</span>
                  <span class="btn-chip-val num">{{ allInAmount }}</span>
                </div>
              </div>
            </Button>
          </div>
        </div>

        <!-- 特殊备选：无常规加注阶梯，仅允许直接 ALL IN -->
        <div v-else-if="allInAction" class="dock-panel panel--allin-only">
          <Button
            class="action-btn action-btn--allin action-btn--allin-standalone"
            :disabled="!canAct"
            :title="canAct ? `ALL IN ${allInAmount}` : (reasonFor || 'ALL IN')"
            :aria-label="`All In ${String(allInAmount)}`"
            @click="askAllIn"
          >
            <div class="btn-content">
              <i class="pi pi-bolt btn-icon" aria-hidden="true" />
              <div class="btn-title-group">
                <span class="btn-main-title">ALL IN</span>
                <span class="btn-chip-val num">{{ allInAmount }}</span>
              </div>
            </div>
          </Button>
        </div>
      </div>

      <!-- 未轮到本人或等待态 -->
      <div v-else class="standby-zone">
        <div class="standby-inner">
          <i class="pi pi-spin pi-spinner standby-spinner" aria-hidden="true" />
          <span class="standby-message">{{ blockedReason || (isMyTurn ? 'Processing action...' : 'Waiting for opponents to act...') }}</span>
        </div>
      </div>
    </div>

    <!-- All-in 确认弹窗 -->
    <Dialog
      v-model:visible="confirmAllIn"
      modal
      header="ALL IN CONFIRMATION"
      :style="{ width: 'min(92vw, 360px)' }"
      :draggable="false"
      class="allin-dialog"
    >
      <div class="dialog-body">
        <div class="dialog-crest">
          <i class="pi pi-bolt dialog-crest-icon" aria-hidden="true" />
        </div>
        <div class="dialog-copy">
          <h4 class="dialog-title">CONFIRM ALL IN</h4>
          <p class="dialog-detail">
            Commit your full remaining stack <b class="num text-gold">{{ allInAmount }}</b> into the pot.
          </p>
        </div>
      </div>
      <template #footer>
        <div class="dialog-footer-actions">
          <Button text class="dialog-btn-dismiss" title="Cancel" @click="confirmAllIn = false">
            <span>CANCEL</span>
          </Button>
          <Button severity="danger" class="dialog-btn-submit" title="Confirm All In" @click="confirmAllInAction">
            <i class="pi pi-bolt" aria-hidden="true" />
            <span>ALL IN {{ allInAmount }}</span>
          </Button>
        </div>
      </template>
    </Dialog>
  </section>
</template>

<style scoped>
/* ───────────── 顶层容器 ───────────── */
.action-console {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  position: relative;
  user-select: none;
  box-sizing: border-box;
}

/* ───────────── 1. 一体化竞技倒计时舱 (进度条与时间深度融铸) ───────────── */
.turn-timer-integrated {
  position: relative;
  width: 100%;
  height: 26px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(10, 15, 22, 0.92);
  border: 1px solid rgba(212, 177, 106, 0.35);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.8), 0 2px 8px rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  user-select: none;
  box-sizing: border-box;
}

.turn-timer-integrated.is-urgent {
  border-color: rgba(239, 68, 68, 0.85);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.8), 0 0 14px rgba(239, 68, 68, 0.65);
  animation: timer-pulse-urgent 0.8s infinite alternate ease-in-out;
}

@keyframes timer-pulse-urgent {
  0% {
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.8), 0 0 6px rgba(239, 68, 68, 0.3);
  }
  100% {
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.8), 0 0 16px rgba(239, 68, 68, 0.85);
  }
}

.timer-track-bar {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}

.timer-progress-fill {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background: linear-gradient(90deg, #059669 0%, #10b981 50%, #f59e0b 80%, #d97706 100%);
  border-radius: inherit;
  will-change: transform;
}

.turn-timer-integrated.is-urgent .timer-progress-fill {
  background: linear-gradient(90deg, #b91c1c 0%, #dc2626 40%, #ef4444 80%, #f97316 100%);
}

.timer-ambient-glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.08) 0%, transparent 80%);
  pointer-events: none;
}

.timer-overlay-content {
  position: relative;
  z-index: 2;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  pointer-events: none;
  box-sizing: border-box;
}

.timer-lead {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #f8fafc;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95), 0 0 6px rgba(0, 0, 0, 0.9);
}

.timer-lead-icon {
  font-size: 0.8rem;
  color: #ffd875;
  filter: drop-shadow(0 0 4px rgba(255, 216, 117, 0.6));
}

.is-urgent .timer-lead-icon {
  color: #fca5a5;
  animation: timer-spin 1.5s linear infinite;
}

@keyframes timer-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.timer-time-box {
  display: flex;
  align-items: baseline;
  gap: 2px;
  font-weight: 900;
  color: #ffffff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95), 0 0 8px rgba(0, 0, 0, 0.9);
  font-variant-numeric: tabular-nums;
}

.timer-digits {
  font-size: 0.98rem;
  letter-spacing: 0.02em;
  color: #ffe394;
}

.is-urgent .timer-digits {
  color: #fee2e2;
  text-shadow: 0 0 8px rgba(239, 68, 68, 0.8);
}

.timer-unit {
  font-size: 0.68rem;
  font-weight: 700;
  opacity: 0.9;
  color: #f8fafc;
}

/* ───────────── 2. 核心双舱协同布局 ───────────── */
.actions-dock {
  width: 100%;
}

.dock-layout {
  display: flex;
  align-items: stretch;
  gap: 8px;
  width: 100%;
}

/* ───────────── 【左舱：防守与跟随组 (FOLD + CHECK / CALL)】 ───────────── */
.panel--defend {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  flex: 0 0 26%;
  min-width: 150px;
  align-self: flex-end; /* 较窄视口下底部与金额行对齐 */
}

.panel--defend .action-btn {
  height: 50px !important;
  min-height: 50px !important;
  padding: 4px 6px !important;
}

.panel--defend .btn-content {
  flex-direction: row;
  gap: 5px;
}

.panel--defend .btn-icon {
  font-size: 0.95rem;
}

.panel--defend .btn-main-title {
  font-size: 0.88rem;
}

/* 屏幕较宽时（>= 960px）：左侧这两个按钮呈两行展示，与右侧上下双层完美对齐 */
@media (min-width: 960px) {
  .panel--defend {
    grid-template-columns: 1fr;
    grid-template-rows: repeat(2, minmax(0, 1fr));
    flex: 0 0 160px;
    min-width: 140px;
    align-self: stretch;
    height: 100%;
    gap: 6px;
  }

  .panel--defend .action-btn {
    height: 100% !important;
    min-height: 38px !important;
    padding: 3px 8px !important;
  }

  .panel--defend .btn-content {
    flex-direction: row;
    gap: 6px;
    justify-content: center;
  }

  .panel--defend .btn-title-group {
    flex-direction: row;
    gap: 5px;
    align-items: baseline;
  }

  .panel--defend .btn-icon {
    font-size: 0.88rem;
  }

  .panel--defend .btn-main-title {
    font-size: 0.85rem;
  }

  .panel--defend .btn-chip-val {
    font-size: 0.75rem;
  }
}

/* ───────────── 【右舱：金额与进攻控制台】 ───────────── */
.panel--attack {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 6px;
  flex: 1 1 74%;
  min-width: 0;
  background: linear-gradient(180deg, rgba(16, 22, 32, 0.92) 0%, rgba(9, 14, 20, 0.98) 100%);
  border: 1px solid rgba(212, 177, 106, 0.28);
  border-radius: var(--radius-md);
  padding: 6px 8px;
  box-shadow:
    0 4px 16px rgba(0, 0, 0, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

/* 上排：快捷底池比例芯片 */
.quick-chips-strip {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
  width: 100%;
}

.quick-chips-strip::-webkit-scrollbar {
  display: none;
}

.chip-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 1px 6px;
  height: 22px;
  flex: 1 1 auto;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: var(--radius-sm);
  cursor: pointer;
  outline: none;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.chip-tag:hover:not(:disabled) {
  background: rgba(212, 177, 106, 0.16);
  border-color: rgba(212, 177, 106, 0.45);
}

.chip-tag.is-selected {
  background: linear-gradient(135deg, rgba(212, 177, 106, 0.3) 0%, rgba(184, 134, 46, 0.4) 100%);
  border-color: #ffd875;
  box-shadow: 0 0 8px rgba(212, 177, 106, 0.35);
}

.chip-tag:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.chip-label {
  font-size: 0.62rem;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: #94a3b8;
}

.chip-tag.is-selected .chip-label {
  color: #ffffff;
}

.chip-val {
  font-size: 0.68rem;
  font-weight: 700;
  color: #ffd875;
}

.chip-tag--max .chip-label {
  color: #fca5a5;
}

.chip-tag--max.is-selected .chip-label {
  color: #ffffff;
}

/* 下排：大幅强化的金额控制行 (数显步进器 + BET/RAISE + ALL IN) */
.attack-controls-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}

/* 数显微调步进器：全面放大突出金额视觉焦点 */
.amount-stepper {
  display: inline-flex;
  align-items: center;
  background: rgba(6, 9, 14, 0.96);
  border: 1.5px solid rgba(212, 177, 106, 0.45);
  border-radius: var(--radius-sm);
  padding: 2px;
  box-shadow:
    inset 0 2px 6px rgba(0, 0, 0, 0.7),
    0 0 8px rgba(212, 177, 106, 0.12);
  flex: 0 0 auto;
  height: 50px;
  box-sizing: border-box;
}

.stepper-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 100%;
  border: none;
  background: rgba(255, 255, 255, 0.05);
  color: #ffd875;
  border-radius: 3px;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 700;
  transition: all 0.15s ease;
}

.stepper-action-btn:hover:not(:disabled) {
  background: rgba(212, 177, 106, 0.25);
  color: #ffffff;
}

.stepper-action-btn:active:not(:disabled) {
  transform: scale(0.92);
}

.stepper-action-btn:disabled {
  opacity: 0.25;
  cursor: not-allowed;
}

.stepper-center-screen {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 5px;
}

.stepper-digit-input {
  width: clamp(54px, 6vw, 70px);
  background: transparent;
  border: none;
  color: #ffd875;
  font-size: 1.12rem;
  font-weight: 900;
  text-align: center;
  outline: none;
  letter-spacing: 0.01em;
  text-shadow: 0 0 6px rgba(255, 216, 117, 0.4);
  -moz-appearance: textfield;
}

.stepper-digit-input::-webkit-outer-spin-button,
.stepper-digit-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

/* ───────────── 3. 按钮统一高级样式规范 ───────────── */
.action-btn {
  min-height: 50px;
  height: 50px;
  border-radius: var(--radius-md) !important;
  padding: 4px 6px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  position: relative !important;
  overflow: hidden !important;
  min-width: 0 !important;
  box-sizing: border-box !important;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
  border-width: 1px !important;
  border-style: solid !important;
}

.action-btn:hover:not(:disabled) {
  transform: translateY(-2px);
}

.action-btn:active:not(:disabled) {
  transform: translateY(1px) scale(0.98);
}

.action-btn:disabled {
  opacity: 0.35 !important;
  cursor: not-allowed !important;
  filter: grayscale(0.4);
}

.btn-content {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  min-width: 0;
}

.btn-icon {
  font-size: 0.92rem;
  flex-shrink: 0;
}

.btn-title-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  line-height: 1.1;
  min-width: 0;
}

.btn-main-title {
  font-size: 0.88rem;
  font-weight: 900;
  letter-spacing: 0.03em;
  white-space: nowrap;
  text-transform: uppercase;
}

.btn-chip-val {
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
  letter-spacing: 0.01em;
}

/* ───────────── 【各动作色彩与材质定制】 ───────────── */

/* FOLD：石榴深红哑光 */
.action-btn--fold {
  background: linear-gradient(180deg, rgba(46, 16, 20, 0.92) 0%, rgba(25, 9, 12, 0.98) 100%) !important;
  border-color: rgba(239, 68, 68, 0.35) !important;
  color: #fca5a5 !important;
  box-shadow:
    0 4px 12px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.06) !important;
}

.action-btn--fold:hover:not(:disabled) {
  background: linear-gradient(180deg, rgba(68, 22, 28, 0.95) 0%, rgba(38, 12, 16, 1) 100%) !important;
  border-color: rgba(239, 68, 68, 0.65) !important;
  color: #ffffff !important;
  box-shadow: 0 6px 18px rgba(239, 68, 68, 0.25) !important;
}

.action-btn--fold .btn-icon {
  color: #ef4444;
}

/* CHECK：翡翠宝石青绿 */
.action-btn--check {
  background: linear-gradient(180deg, rgba(14, 45, 34, 0.92) 0%, rgba(8, 28, 21, 0.98) 100%) !important;
  border-color: rgba(16, 185, 129, 0.45) !important;
  color: #6ee7b7 !important;
  box-shadow:
    0 4px 12px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
}

.action-btn--check:hover:not(:disabled) {
  background: linear-gradient(180deg, rgba(20, 64, 48, 0.95) 0%, rgba(12, 40, 30, 1) 100%) !important;
  border-color: rgba(16, 185, 129, 0.8) !important;
  color: #ffffff !important;
  box-shadow: 0 6px 20px rgba(16, 185, 129, 0.3) !important;
}

.action-btn--check .btn-icon {
  color: #10b981;
}

/* CALL：极光蔚蓝 */
.action-btn--call {
  background: linear-gradient(180deg, rgba(14, 36, 56, 0.92) 0%, rgba(8, 22, 36, 0.98) 100%) !important;
  border-color: rgba(56, 189, 248, 0.45) !important;
  color: #7dd3fc !important;
  box-shadow:
    0 4px 12px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
}

.action-btn--call:hover:not(:disabled) {
  background: linear-gradient(180deg, rgba(18, 50, 78, 0.95) 0%, rgba(12, 32, 52, 1) 100%) !important;
  border-color: rgba(56, 189, 248, 0.8) !important;
  color: #ffffff !important;
  box-shadow: 0 6px 20px rgba(56, 189, 248, 0.28) !important;
}

.action-btn--call .btn-icon {
  color: #38bdf8;
}

.action-btn--call .btn-chip-val {
  color: #ffffff;
}

/* BET / RAISE：黑金尊贵流光主角按键 */
.action-btn--primary {
  flex: 1 1 auto;
  min-width: 90px;
  background: linear-gradient(135deg, #ffd875 0%, #cb9b51 50%, #9a6d25 100%) !important;
  border-color: #ffe89e !important;
  color: #111827 !important;
  box-shadow:
    0 4px 16px rgba(212, 177, 106, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.4) !important;
}

.action-btn--primary:hover:not(:disabled) {
  background: linear-gradient(135deg, #ffe28a 0%, #d8a85e 50%, #ad7c2d 100%) !important;
  box-shadow: 0 6px 22px rgba(212, 177, 106, 0.65) !important;
}

.action-btn--primary .btn-main-title,
.action-btn--primary .btn-chip-val {
  color: #0b0f14;
}

.action-btn--primary .btn-icon {
  color: #1f1402;
}

.action-btn--glow-max {
  border-color: #ffffff !important;
  box-shadow:
    0 0 18px rgba(255, 216, 117, 0.8),
    inset 0 1px 0 rgba(255, 255, 255, 0.6) !important;
}

/* ALL IN：激光朱红战术爆发按键（在进攻行右侧并排） */
.action-btn--allin {
  flex: 0 0 auto;
  min-width: 82px;
  background: linear-gradient(135deg, #dc2626 0%, #991b1b 50%, #580d0d 100%) !important;
  border-color: #f87171 !important;
  color: #ffffff !important;
  box-shadow:
    0 4px 14px rgba(220, 38, 38, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.3) !important;
}

.action-btn--allin:hover:not(:disabled) {
  background: linear-gradient(135deg, #ef4444 0%, #b91c1c 50%, #701010 100%) !important;
  box-shadow: 0 6px 20px rgba(239, 68, 68, 0.6) !important;
}

.action-btn--allin .btn-icon {
  color: #ffd875;
}

.action-btn--allin .btn-chip-val {
  color: #ffea9f;
}

.action-btn--allin.is-selected {
  border-color: #ffd875 !important;
  box-shadow: 0 0 16px rgba(239, 68, 68, 0.7) !important;
}

.action-btn--allin-standalone {
  flex: 1 1 auto;
}

.panel--allin-only {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
}

/* ───────────── 4. 等待态 / 待机舱 ───────────── */
.standby-zone {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  border-radius: var(--radius-md);
  background: rgba(13, 18, 25, 0.7);
  border: 1px dashed rgba(255, 255, 255, 0.1);
  padding: 8px 16px;
}

.standby-inner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #94a3b8;
  font-size: 0.85rem;
}

.standby-spinner {
  color: #64748b;
  font-size: 0.9rem;
}

/* ───────────── 5. 全下确认弹窗 ───────────── */
.allin-dialog :deep(.p-dialog-header) {
  background: #0f172a;
  color: #ffd875;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.allin-dialog :deep(.p-dialog-content) {
  background: #0b1120;
}

.allin-dialog :deep(.p-dialog-footer) {
  background: #0b1120;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.dialog-body {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 0;
}

.dialog-crest {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: radial-gradient(circle, #ef4444 0%, #b91c1c 70%, #450a0a 100%);
  border: 2px solid #ffd875;
  box-shadow: 0 0 14px rgba(239, 68, 68, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.dialog-crest-icon {
  font-size: 1.3rem;
  color: #ffd875;
  filter: drop-shadow(0 0 3px rgba(255, 216, 117, 0.9));
}

.dialog-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dialog-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 800;
  color: #ffd875;
  letter-spacing: 0.04em;
}

.dialog-detail {
  margin: 0;
  line-height: 1.45;
  font-size: 0.85rem;
  color: #cbd5e1;
}

.text-gold {
  color: #ffd875;
}

.dialog-footer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  width: 100%;
}

.dialog-btn-dismiss {
  color: #94a3b8 !important;
  font-weight: 700 !important;
}

.dialog-btn-submit {
  background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%) !important;
  border-color: #f87171 !important;
  font-weight: 800 !important;
  letter-spacing: 0.02em !important;
  box-shadow: 0 4px 14px rgba(239, 68, 68, 0.4) !important;
}

/* ───────────── 响应式布局自适应 ───────────── */
@media (max-width: 820px) {
  .dock-layout {
    flex-direction: column;
    gap: 8px;
  }

  .panel--defend,
  .panel--attack {
    flex: 1 1 auto;
    width: 100%;
  }
}

@media (max-width: 480px) {
  .attack-controls-row {
    gap: 4px;
  }

  .stepper-digit-input {
    width: 46px;
    font-size: 0.85rem;
  }

  .action-btn {
    min-height: 44px;
    height: 44px;
    padding: 2px 4px !important;
  }

  .action-btn--allin {
    flex: 0 0 80px;
  }
}
</style>
