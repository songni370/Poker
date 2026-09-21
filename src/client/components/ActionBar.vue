<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import Slider from 'primevue/slider'
import type { LegalAction } from '../../shared/protocol.ts'

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
    /** 剩余秒数与总秒数，用于倒计时进度条。 */
    remainingSeconds?: number
    turnSeconds?: number
    /** 无法行动时展示的原因，每个禁用按钮的 title 也会带上它。 */
    blockedReason?: string
    /** 链路异常时禁止提交。 */
    enabled?: boolean
  }>(),
  {
    potTotal: 0,
    currentBet: 0,
    myStack: 0,
    isMyTurn: false,
    remainingSeconds: 0,
    turnSeconds: 20,
    blockedReason: '',
    enabled: true,
  },
)

const emit = defineEmits<{
  /** 提交一个动作；amount 语义与协议一致：call=补筹码，bet/raise=目标总额。 */
  (event: 'action', payload: { action: LegalAction['action']; amount?: number }): void
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
const reason = computed(() => props.blockedReason || (props.isMyTurn ? '服务端未给出该动作' : '当前无法行动'))
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

function clamp(value: number): number {
  return Math.min(Math.max(Math.round(value), minAmount.value), maxAmount.value)
}

/** 快捷额度：1/2 底池与底池按跟注后的底池计算，最后收敛到合法区间。 */
const potAfterCall = computed(() => props.potTotal + callAmount.value)
const quickAmounts = computed(() => {
  if (!sizing.value) return []
  const list = [
    { key: 'half', label: '1/2 底池', value: clamp(callAmount.value + potAfterCall.value / 2) },
    { key: 'pot', label: '底池', value: clamp(callAmount.value + potAfterCall.value) },
  ]
  // 区间过窄时两个快捷额度可能撞到同一个值，去重后只留一个。
  const seen = new Set<number>()
  return list.filter((item) => (seen.has(item.value) ? false : seen.add(item.value) !== undefined))
})

const confirmAllIn = ref(false)

/** 极矮屏（横屏手机）隐藏步进按钮：保留数字输入本体，高度更可控。 */
const showStepper = ref(true)

function syncDensity(): void {
  showStepper.value = window.innerHeight > 430
}

onMounted(() => {
  syncDensity()
  window.addEventListener('resize', syncDensity)
})

onBeforeUnmount(() => window.removeEventListener('resize', syncDensity))

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

const percent = computed(() =>
  Math.round(Math.min(1, Math.max(0, props.remainingSeconds / Math.max(1, props.turnSeconds))) * 100),
)

/** 只在轮到自己时播报，避免观战时反复打扰屏幕阅读器。 */
const liveText = computed(() => {
  if (!props.isMyTurn) return ''
  const parts = ['轮到你行动']
  if (callAction.value) parts.push(`需跟注 ${String(callAmount.value)}`)
  if (allInAction.value) parts.push(`全下 ${String(allInAmount.value)}`)
  return parts.join('，')
})
</script>

<template>
  <section class="action-bar" aria-label="下注操作区">
    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ liveText }}</p>

    <div v-if="isMyTurn" class="turn-strip">
      <span class="turn-flag">YOUR TURN</span>
      <span class="turn-clock num">{{ remainingSeconds }}s</span>
      <span
        class="turn-bar"
        role="progressbar"
        :aria-valuenow="remainingSeconds"
        aria-valuemin="0"
        :aria-valuemax="turnSeconds"
        aria-label="你的行动倒计时"
      >
        <span class="turn-fill" :style="{ transform: `scaleX(${String(percent / 100)})` }" />
      </span>
    </div>

    <div class="buttons">
      <Button
        v-if="foldAction"
        severity="danger"
        outlined
        :disabled="!canAct"
        :title="reasonFor"
        @click="sendAction('fold')"
      >
        <i class="pi pi-times" aria-hidden="true" />
        <span>弃牌</span>
      </Button>

      <Button v-if="checkAction" :disabled="!canAct" :title="reasonFor" @click="sendAction('check')">
        <i class="pi pi-check" aria-hidden="true" />
        <span>过牌</span>
      </Button>

      <Button v-if="callAction" :disabled="!canAct" :title="reasonFor" @click="sendAction('call')">
        <i class="pi pi-arrow-down-right" aria-hidden="true" />
        <span>跟注 {{ callAmount }}</span>
      </Button>

      <Button
        v-if="sizingAction"
        severity="help"
        :disabled="!canAct"
        :title="`${reasonFor || '设置下注额'}（${String(minAmount)}–${String(maxAmount)}）`"
        @click="submitSizing"
      >
        <i class="pi pi-chart-line" aria-hidden="true" />
        <span>{{ sizingAction === 'bet' ? '下注' : '加注' }} {{ amount }}</span>
      </Button>

      <Button v-if="allInAction" severity="danger" :disabled="!canAct" :title="reasonFor" @click="askAllIn">
        <i class="pi pi-bolt" aria-hidden="true" />
        <span>全下 {{ allInAmount }}</span>
      </Button>

      <!-- 空态：解释当前为什么没有可执行动作。 -->
      <p v-if="legalActions.length === 0" class="empty">{{ blockedReason || '当前没有可执行的动作' }}</p>
    </div>

    <!-- 下注额度：数字输入 + 滑块 + 快捷额度，三者始终同步。 -->
    <fieldset v-if="canAct && sizing" class="sizing">
      <legend class="sr-only">下注金额</legend>

      <label class="field" for="bet-amount">
        <span class="field-label">金额</span>
        <InputNumber
          v-model="amount"
          input-id="bet-amount"
          :min="minAmount"
          :max="maxAmount"
          :step="10"
          :use-grouping="false"
          :show-buttons="showStepper"
          button-layout="horizontal"
          :max-fraction-digits="0"
          :pt="{
            pcInputText: { root: { 'aria-label': '下注金额' } },
            incrementButton: { 'aria-hidden': 'true', tabindex: '-1' },
            decrementButton: { 'aria-hidden': 'true', tabindex: '-1' },
          }"
          fluid
        />
      </label>

      <div class="slider">
        <Slider
          v-model="amount"
          :min="minAmount"
          :max="maxAmount"
          :step="10"
          aria-label="下注金额滑块"
          :style="{ '--p-slider-handle-width': '28px', '--p-slider-handle-height': '28px' }"
        />
      </div>

      <div class="quick">
        <Button
          v-for="quick in quickAmounts"
          :key="quick.key"
          size="small"
          outlined
          :title="`${quick.label}：${String(quick.value)}`"
          @click="amount = quick.value"
        >
          <span>{{ quick.label }}</span>
        </Button>
        <span class="range num">{{ minAmount }}–{{ maxAmount }}</span>
      </div>
    </fieldset>

    <!-- All-in 二次确认：误触防护，必须显式确认。 -->
    <Dialog
      v-model:visible="confirmAllIn"
      modal
      :header="'确认全下'"
      :style="{ width: 'min(92vw, 360px)' }"
      :draggable="false"
    >
      <p class="confirm-text">
        全下会投入你全部剩余筹码 <b class="num">{{ allInAmount }}</b
        >。确认执行？
      </p>
      <template #footer>
        <Button text :title="'取消全下'" @click="confirmAllIn = false">
          <span>取消</span>
        </Button>
        <Button severity="danger" :title="'确认全下'" @click="confirmAllInAction">
          <span>确认全下 {{ allInAmount }}</span>
        </Button>
      </template>
    </Dialog>
  </section>
</template>

<style scoped>
.action-bar {
  display: grid;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-1) 0;
}

.turn-strip {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.turn-flag {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--gold);
}

.turn-clock {
  font-size: 0.78rem;
  color: var(--text);
}

.turn-bar {
  position: relative;
  flex: 1;
  height: 5px;
  overflow: hidden;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.4);
}

.turn-fill {
  display: block;
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background: var(--gold);
}

.buttons {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.empty {
  margin: 0;
  padding: 11px 0;
  color: var(--muted);
  font-size: 0.86rem;
}

.sizing {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin: 0;
  padding: var(--space-1) 0 0;
  border: 0;
}

.field {
  display: grid;
  gap: 2px;
}

.field-label {
  font-size: 0.72rem;
  color: var(--muted);
}

.field :deep(.p-inputnumber) {
  width: 132px;
}

.slider {
  flex: 1 1 160px;
  min-width: 140px;
  /* 上下留白 + 加大手柄，让滑块更容易点中。 */
  padding: 10px 2px;
}

.quick {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.range {
  font-size: 0.72rem;
  color: var(--muted);
}

.confirm-text {
  margin: 0;
  line-height: 1.6;
}

.confirm-text b {
  color: var(--gold);
}

/* 横屏手机：隐藏滑块（数字输入与快捷额度仍可用），保证操作区不被挤出屏幕。 */
@media (max-height: 430px) {
  .slider {
    display: none;
  }

  .field :deep(.p-inputnumber) {
    width: 104px;
  }

  /* 区间文案在矮屏省略（数字输入自身带 min/max 约束）。 */
  .range {
    display: none;
  }

  .action-bar {
    padding: 0;
    gap: 2px;
  }

  .buttons {
    gap: 6px;
  }

  .buttons :deep(.p-button) {
    padding-block: 8px;
  }

  /* 极矮屏：倒计时收成紧凑一行（进度条交给座位上的进度条显示）。 */
  .turn-bar {
    display: none;
  }

  .sizing {
    gap: 6px;
    padding-top: 0;
  }

  .slider {
    padding: 10px 2px;
  }
}

@media (max-width: 560px) {
  /* 竖屏窄屏：滑块隐藏（数字输入与快捷额度仍可用），金额与快捷额度同排。 */
  .slider {
    display: none;
  }

  .sizing {
    gap: var(--space-1);
    align-items: center;
  }

  .buttons :deep(.p-button) {
    font-size: 0.86rem;
  }
}
</style>
