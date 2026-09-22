<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import Slider from 'primevue/slider'
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

/**
 * 唯一的取整 + 边界函数：数字输入、滑块、快捷额度与提交动作都走它。
 * 快捷额度不允许另起一套步进/夹取逻辑，否则同一个值会有两种算法。
 */
function clamp(value: number): number {
  return clampAmount(value, minAmount.value, maxAmount.value)
}

/**
 * 快捷额度：1/2、2/3、满池、超池。换算与「越界即禁用」的判定在纯函数
 * `quickSizes()` 里（可单测），这里只把 props 喂进去。
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
      <!--
        动作按钮：英文是主文本（大号加粗），中文是小字辅助。
        aria-label 必须同时带英文与中文——屏幕阅读器与 e2e 都按它取可访问名称，
        只留英文会让中文用户（以及现有中文 e2e 选择器）找不到按钮。
      -->
      <Button
        v-if="foldAction"
        severity="danger"
        outlined
        :aria-label="'FOLD 弃牌'"
        :title="reasonFor || 'FOLD 弃牌'"
        :disabled="!canAct"
        @click="sendAction('fold')"
      >
        <i class="pi pi-times" aria-hidden="true" />
        <span class="act-text">
          <span class="act-en">FOLD</span>
          <span class="act-zh">弃牌</span>
        </span>
      </Button>

      <Button
        v-if="checkAction"
        :aria-label="'CHECK 过牌'"
        :title="reasonFor || 'CHECK 过牌'"
        :disabled="!canAct"
        @click="sendAction('check')"
      >
        <i class="pi pi-check" aria-hidden="true" />
        <span class="act-text">
          <span class="act-en">CHECK</span>
          <span class="act-zh">过牌</span>
        </span>
      </Button>

      <Button
        v-if="callAction"
        :aria-label="`CALL 跟注 ${String(callAmount)}`"
        :title="reasonFor || `CALL 跟注 ${String(callAmount)}`"
        :disabled="!canAct"
        @click="sendAction('call')"
      >
        <i class="pi pi-arrow-down-right" aria-hidden="true" />
        <span class="act-text">
          <span class="act-en num">CALL {{ callAmount }}</span>
          <span class="act-zh num">跟注 {{ callAmount }}</span>
        </span>
      </Button>

      <Button
        v-if="sizingAction"
        severity="help"
        :aria-label="`${sizingAction === 'bet' ? 'BET' : 'RAISE'} ${sizingAction === 'bet' ? '下注' : '加注'} ${String(amount)}`"
        :title="`${reasonFor || '设置下注额'}（${String(minAmount)}–${String(maxAmount)}）`"
        :disabled="!canAct"
        @click="submitSizing"
      >
        <i class="pi pi-chart-line" aria-hidden="true" />
        <span class="act-text">
          <span class="act-en num">{{ sizingAction === 'bet' ? 'BET' : 'RAISE' }} {{ amount }}</span>
          <span class="act-zh num">{{ sizingAction === 'bet' ? '下注' : '加注' }} {{ amount }}</span>
        </span>
      </Button>

      <Button
        v-if="allInAction"
        severity="danger"
        :aria-label="`ALL IN 全下 ${String(allInAmount)}`"
        :title="reasonFor || `ALL IN 全下 ${String(allInAmount)}`"
        :disabled="!canAct"
        @click="askAllIn"
      >
        <i class="pi pi-bolt" aria-hidden="true" />
        <span class="act-text">
          <span class="act-en num">ALL IN {{ allInAmount }}</span>
          <span class="act-zh num">全下 {{ allInAmount }}</span>
        </span>
      </Button>

      <!-- 空态：解释当前为什么没有可执行动作。 -->
      <p v-if="legalActions.length === 0" class="empty">{{ blockedReason || '当前没有可执行的动作' }}</p>
    </div>

    <!-- 下注额度台：左侧「金额输入 + 滑块」，右侧一排快捷额度（半池 / 2/3 池 / 满池 / 超池）。
         三块共用同一个 amount，改动任何一处其余两块同步（数字输入、滑块、快捷额度）。 -->
    <fieldset v-if="canAct && sizing" class="sizing">
      <legend class="sr-only">下注金额</legend>

      <div class="controls">
        <!-- 数字输入：带可见标签；输入框本身另有 aria-label「下注金额」。 -->
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

        <!-- 服务端给的本档合法区间（滑块被隐藏的窄屏上，这是唯一的区间来源）。 -->
        <span class="range num">{{ minAmount }}–{{ maxAmount }}</span>
      </div>

      <!-- 快捷额度：值来自真实底池并按 clampAmount() 夹进服务端区间；理想值越界的档位禁用，
           title 说明是低于最小下注/加注还是超过上限，不会点出一个服务端必拒的数。
           title 挂在外层 span 上：原生禁用按钮收不到 hover，浏览器不会弹它自己的 title。
           英文在上、中文在下，与动作按钮同一套排版。 -->
      <div class="quick" role="group" aria-label="快捷下注额度">
        <span class="quick-caption" aria-hidden="true">快捷额度</span>
        <span v-for="quick in quickAmounts" :key="quick.key" class="quick-slot" :title="quick.title">
          <Button
            size="small"
            outlined
            class="quick-btn"
            :disabled="!canAct || quick.disabled"
            :aria-label="`${quick.desc}，${quick.disabled ? `不可用：${quick.reason}` : `下注额 ${String(quick.value)}`}`"
            @click="applyQuick(quick)"
          >
            <span class="quick-ratio">{{ quick.en }}</span>
            <span class="quick-value num">{{ quick.value }}</span>
            <span class="quick-zh">{{ quick.zh }}</span>
          </Button>
        </span>
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

/*
 * 动作按钮的双行文本：英文主、中文辅。
 * 中文不用 var(--muted)：动作按钮有蓝（过牌/跟注）、绿（下注/加注）、红（弃牌/全下）
 * 三种填充底色，灰字在填充按钮上的对比度不够；改成继承按钮自身的前景色 + 降透明度，
 * 字号再收一档——层次感来自「更小 + 更淡」，可读性不受底色影响。
 * line-height 收到 1.05：矮屏（740×360）底部操作区每高 10px，牌桌就被挤掉 10px。
 */
.act-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.05;
}

.act-en {
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.act-zh {
  font-size: 0.62rem;
  font-weight: 400;
  opacity: 0.72;
}

.empty {
  margin: 0;
  padding: 11px 0;
  color: var(--muted);
  font-size: 0.86rem;
}

/*
 * 额度台：一块带底色的控制台，左列「金额 + 滑块 + 区间」，右列快捷额度。
 * 用容器把两者框在一起，是因为它们操作的是同一个 amount——
 * 分散成两排会让滑块看起来像独立控件（旧版滑块就是单独一行、纵向与输入框对不齐）。
 */
.sizing {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-elevated) 80%, transparent);
}

/* 左列：金额 + 滑块 + 区间。min-width: 0 让滑块在窄屏先被压缩，而不是把整行顶溢出。 */
.controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 300px;
  min-width: 0;
}

.field {
  display: grid;
  gap: 2px;
  flex: none;
}

.field-label {
  font-size: 0.72rem;
  color: var(--muted);
}

.field :deep(.p-inputnumber) {
  width: 132px;
}

/* 滑块纵向与输入框居中对齐；min-width 保底，避免被右列的快捷额度挤成一条线。 */
.slider {
  flex: 1 1 140px;
  min-width: 120px;
  padding: 6px 2px;
}

/*
 * 快捷额度：英文主文本 + 数值 + 中文小字，纵向三行。
 * 不用横向滚动容器：滚动容器会裁掉 :focus-visible 的焦点环（outline-offset: 2px），
 * 这里靠 flex-wrap 换行 + 2px 内边距，键盘焦点环始终完整可见。
 * 按钮间距 8px：相邻触控目标之间至少留 8px（否则手指容易点错到隔壁档位）。
 */
.quick {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
  padding: 2px;
  /* 空间富余时整组靠右（用户要求「最右侧的按钮多几个」），
     空间不足时它自己换到下一行，不会把金额挤窄。 */
  margin-left: auto;
}

/* 分组标题：贴左侧竖排，不占按钮的宽度预算。 */
.quick-caption {
  font-size: 0.68rem;
  color: var(--muted);
}

.quick-btn {
  display: grid;
  justify-items: center;
  gap: 1px;
  /* 触控目标不小于 40px：宁可整行换行，也不把按钮压小。 */
  min-width: 54px;
  min-height: 44px;
  padding: 4px 8px;
  line-height: 1.05;
}

/* title 的载体：禁用按钮本身收不到 hover，提示要挂在没被禁用的外层元素上。 */
.quick-slot {
  display: inline-flex;
}

.quick-ratio {
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--muted);
}

.quick-value {
  font-size: 0.86rem;
  color: var(--gold);
}

.quick-zh {
  font-size: 0.56rem;
  color: var(--muted);
}

/* 禁用档位：靠 title 说明原因，视觉上用降透明度 + 常规禁用光标（不只靠颜色）。 */
.quick-btn:disabled {
  opacity: 0.55;
}

.range {
  flex: none;
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

  .action-bar {
    padding: 0;
    gap: 2px;
  }

  .buttons {
    gap: 6px;
  }

  /* 双行文案在矮屏收一档：按钮高度 ≈ 8×2 内边距 + 两行文字 + 边框，
     刚好守在 40px 触控目标之上，同时不比改版前（单行 44px）更高。 */
  .act-en {
    font-size: 0.86rem;
  }

  .act-zh {
    font-size: 0.56rem;
  }

  .buttons :deep(.p-button) {
    padding-block: 8px;
  }

  /* 极矮屏：倒计时收成紧凑一行（进度条交给座位上的进度条显示）。 */
  .turn-bar {
    display: none;
  }

  /* 额度台在 360–390px 高的横屏里压到最扁：整行 44px（内边距 2px + 按钮 40px），
     底部操作区每收 10px，上方牌桌就多 10px（740×360 时牌桌只剩 118px 高）。
     分组标题与滑块都在这一档省略：四个英文档位本身已经说明用途。 */
  .sizing {
    gap: var(--space-1);
    padding: 2px 6px;
    flex-wrap: nowrap;
  }

  .controls {
    gap: var(--space-1);
    flex: 0 1 auto;
  }

  .range {
    display: none;
  }

  .quick {
    flex-wrap: nowrap;
    padding: 0;
  }

  .quick-btn {
    min-height: 40px;
    min-width: 48px;
    padding: 2px 6px;
  }

  .quick-caption {
    display: none;
  }
}

@media (max-width: 560px) {
  /* 竖屏窄屏：滑块隐藏（数字输入与快捷额度仍可用），额度台分两行，
     上行金额 + 区间、下行四个快捷档位，避免四个按钮把金额挤出屏幕。 */
  .slider {
    display: none;
  }

  .sizing {
    gap: var(--space-1);
    padding: 6px 8px;
  }

  .controls {
    flex: 1 1 100%;
    justify-content: space-between;
  }

  /* 区间文案不许换行：金额 201px + 区间约 66px 刚好放进 340px 的行宽，
     一旦换行就会多占一行高度。 */
  .range {
    white-space: nowrap;
  }

  .quick {
    flex: 1 1 100%;
    justify-content: space-between;
    flex-wrap: nowrap;
  }

  .quick-caption {
    display: none;
  }

  .quick-btn {
    flex: 1 1 0;
    min-width: 0;
  }

  .act-en {
    font-size: 0.86rem;
  }

  .buttons :deep(.p-button) {
    font-size: 0.86rem;
  }
}
</style>
