<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'

/**
 * 买入 / 重新买入确认弹窗。
 *
 * 范围与步进取自服务端（房主设定 → 服务端收敛），组件只负责：
 *   - 默认填满上限（最少点击）；
 *   - 提交前按步进取整；
 *   - 区分「入座」与「重新买入」两种文案。
 */
const props = defineProps<{
  /** 是否显示。 */
  visible: boolean
  /** 目标座位号（0 起）；重新买入时为本人座位。 */
  seat: number | null
  /** 服务端下发的买入下限 / 上限 / 步进。 */
  min: number
  max: number
  step: number
  /** 是否「重新买入」（否则是首次入座）。 */
  rebuy: boolean
}>()

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void
  /** 用户确认：amount 已按 step 取整。 */
  (event: 'confirm', amount: number): void
  /** 用户取消或关闭。 */
  (event: 'cancel'): void
}>()

const amount = ref(0)

/** 打开时默认给满上限（最少点击）；上限缺失时退化为下限。 */
watch(
  () => [props.visible, props.max, props.min] as const,
  ([visible, max, min]) => {
    if (visible) amount.value = max || min
  },
  { immediate: true },
)

const title = computed(() => {
  if (props.rebuy) return '重新买入'
  if (props.seat === null) return '确认买入'
  return `买入并入座 ${String(props.seat + 1)} 号位`
})

/** 一半上限，按步进取整。 */
const halfAmount = computed(() => {
  const step = Math.max(1, props.step)
  return Math.round(props.max / 2 / step) * step
})

function setAmount(value: number): void {
  amount.value = value
}

function confirm(): void {
  const step = Math.max(1, props.step)
  const value = Math.round(Number(amount.value) / step) * step
  emit('confirm', value)
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="title"
    class="vip-dialog buyin-dialog"
    :style="{ width: 'min(92vw, 380px)' }"
    @update:visible="(value: boolean) => emit('update:visible', value)"
    @hide="emit('cancel')"
  >
    <div class="buyin">
      <p v-if="rebuy" class="muted">随时可追加买入；若参与当前手牌，新增筹码在本手结束后可用。</p>
      <p class="buyin-line">
        <span class="muted">买入额</span>
        <b class="num">{{ amount }}</b>
        <span class="muted">筹码</span>
      </p>
      <InputNumber
        v-model="amount"
        :min="min"
        :max="max"
        :step="step"
        :use-grouping="false"
        show-buttons
        fluid
        aria-label="买入筹码数量"
      />
      <div class="buyin-quick">
        <Button size="small" outlined :title="`最小买入 ${String(min)}`" @click="setAmount(min)">
          <span>最小 {{ min }}</span>
        </Button>
        <Button size="small" outlined :title="`一半 ${String(halfAmount)}`" @click="setAmount(halfAmount)">
          <span>一半</span>
        </Button>
        <Button size="small" outlined :title="`上限 ${String(max)}`" @click="setAmount(max)">
          <span>上限 {{ max }}</span>
        </Button>
      </div>
      <p class="hint">
        买入范围 {{ min }}–{{ max }}，步进 {{ step }}。筹码是虚拟分数，不可充值、不可兑换。
      </p>
    </div>
    <template #footer>
      <Button text title="取消" @click="emit('update:visible', false)"><span>取消</span></Button>
      <Button title="确认买入并入座" @click="confirm">
        <i class="pi pi-check" aria-hidden="true" />
        <span>确认买入</span>
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
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
  font-family: var(--font-display);
  font-size: 1.4rem;
  font-weight: 800;
  color: #ffdf9a;
  text-shadow: 0 1px 0 #000, 0 0 12px rgba(255, 190, 90, 0.3);
}

.buyin-quick {
  display: flex;
  gap: 8px;
}

.buyin-quick :deep(.p-button) {
  flex: 1;
  min-height: 34px;
  border-radius: 9px;
  background: linear-gradient(180deg, #3b2f22 0%, #241b12 100%);
  border: 1px solid rgba(0, 0, 0, 0.75);
  color: #f1e6d0;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    inset 0 -2px 4px rgba(0, 0, 0, 0.6),
    0 2px 4px rgba(0, 0, 0, 0.5);
}

.muted {
  color: #a08f74;
  font-size: 0.82rem;
}

.hint {
  margin: 0;
  font-size: 0.78rem;
  color: #a08f74;
  line-height: 1.5;
}

/* 输入框：内凹深槽 + 黄铜细框，与大厅一致 */
.buyin :deep(.p-inputnumber-input),
.buyin :deep(.p-inputnumber) {
  width: 100%;
}

.buyin :deep(.p-inputnumber-input) {
  height: 46px;
  border-radius: 10px;
  background: linear-gradient(180deg, #120d09 0%, #1d1610 100%);
  border: 1px solid rgba(0, 0, 0, 0.9);
  color: #ffdf9a;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  box-shadow:
    inset 0 2px 5px rgba(0, 0, 0, 0.85),
    0 1px 0 rgba(255, 255, 255, 0.06);
}

.buyin :deep(.p-inputnumber-input:focus) {
  border-color: #c39a4f;
  box-shadow:
    inset 0 2px 5px rgba(0, 0, 0, 0.85),
    0 0 0 2px rgba(195, 154, 79, 0.25);
}

.buyin :deep(.p-inputnumber-button) {
  background: linear-gradient(180deg, #3b2f22 0%, #241b12 100%);
  border-color: rgba(0, 0, 0, 0.75);
  color: #e5d6b8;
}

/* 主按钮：香槟金立体键（与结算叠层一致） */
:global(.p-dialog.buyin-dialog .p-dialog-footer .p-button:not(.p-button-text)) {
  min-height: 44px;
  padding: 0 18px;
  border-radius: 12px;
  background: linear-gradient(180deg, #ffe9ac 0%, #f0c668 45%, #c9973f 100%);
  border: 1px solid #7c5c22;
  color: #35230a;
  font-weight: 800;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.55);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.9),
    inset 0 -3px 5px rgba(150, 105, 30, 0.55),
    0 3px 0 #6a4d1a,
    0 8px 16px rgba(0, 0, 0, 0.55);
}

:global(.p-dialog.buyin-dialog .p-dialog-footer .p-button-text) {
  color: #cbbd9f;
}

:global(.p-dialog.buyin-dialog .p-dialog-title) {
  color: #f6ecd8;
  font-weight: 800;
  text-shadow: 0 1px 0 #000;
}

:global(.p-dialog.buyin-dialog .p-dialog-header-close) {
  color: #cbbd9f;
}
</style>
