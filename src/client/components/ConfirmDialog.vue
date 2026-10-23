<script setup lang="ts">
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'

/**
 * 通用二次确认弹窗。
 *
 * 离座、退出房间、以及其它「不可撤销操作」共用同一套骨架：
 *   - 皮革底板 + 黄铜描边（`vip-dialog confirm-dialog`）；
 *   - 危险动作用酒红压印按钮，取消用米色文字键；
 *   - 危险按钮可带图标（`#danger-icon` 插槽），与对应操作入口图标一致。
 *
 * 只做展示与事件上抛，不含任何业务判断——业务逻辑留在调用方。
 */
withDefaults(
  defineProps<{
    visible: boolean
    /** 标题，例如「离座并弃牌？」。 */
    title: string
    /** 正文说明（可以是 1–2 句），用来说明后果与可逆性。 */
    description: string
    /** 危险按钮文案，例如「离座并弃牌」。 */
    confirmLabel: string
    /** 取消按钮文案，例如「继续打」「取消」。 */
    cancelLabel?: string
    /** 危险按钮的 title（悬停提示）。 */
    confirmTitle?: string
    /** 宽度，默认适配手机。 */
    width?: string
  }>(),
  {
    cancelLabel: '取消',
    confirmTitle: undefined,
    width: 'min(92vw, 380px)',
  },
)

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void
  (event: 'confirm'): void
  (event: 'cancel'): void
}>()

function close(): void {
  emit('update:visible', false)
  emit('cancel')
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="title"
    class="vip-dialog confirm-dialog"
    :style="{ width }"
    @update:visible="(value: boolean) => emit('update:visible', value)"
    @hide="emit('cancel')"
  >
    <p class="confirm-text">{{ description }}</p>
    <template #footer>
      <Button text :title="cancelLabel" @click="close"><span>{{ cancelLabel }}</span></Button>
      <Button severity="danger" :title="confirmTitle ?? confirmLabel" @click="emit('confirm')">
        <slot name="danger-icon">
          <i class="pi pi-check" aria-hidden="true" />
        </slot>
        <span>{{ confirmLabel }}</span>
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.confirm-text {
  margin: 0;
  font-size: 0.84rem;
  line-height: 1.7;
  color: #cbbd9f;
}
</style>
