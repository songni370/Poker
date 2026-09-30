<script setup lang="ts">
import { ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import { TABLE_RULES } from '../../shared/poker.ts'
import type { GameStatePublic } from '../../shared/protocol.ts'
import { nextRequestId, sendCommand, useSessionStore } from '../net/session.ts'

const props = defineProps<{ visible: boolean; state: GameStatePublic }>()
const emit = defineEmits<{ 'update:visible': [value: boolean] }>()
const session = useSessionStore()
const turnSeconds = ref<number | null>(null)
const nextHandSeconds = ref<number | null>(null)
const error = ref('')
const saving = ref(false)

watch(() => props.visible, (open) => {
  if (!open) return
  turnSeconds.value = props.state.turnSeconds
  nextHandSeconds.value = props.state.nextHandSeconds
  error.value = ''
  saving.value = false
})

watch(() => props.state.version, () => {
  if (saving.value && session.lastEventType === 'room.configured') {
    saving.value = false
    emit('update:visible', false)
  }
})

watch(() => session.lastError, (failure) => {
  if (!saving.value || !failure) return
  saving.value = false
  error.value = failure.message
})

function save(): void {
  const turn = turnSeconds.value
  const next = nextHandSeconds.value
  if (!Number.isInteger(turn) || !Number.isInteger(next) ||
    turn! < TABLE_RULES.minTurnSeconds || turn! > TABLE_RULES.maxTurnSeconds ||
    next! < 0 || next! > TABLE_RULES.maxNextHandSeconds) {
    error.value = '请填写允许范围内的整数秒数。'
    return
  }
  error.value = ''
  session.clearError()
  saving.value = sendCommand({
    type: 'room.configure', requestId: nextRequestId(),
    turnSeconds: turn!, nextHandSeconds: next!,
  })
  if (!saving.value) error.value = '尚未连接到服务器，请稍后重试。'
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="牌局配置"
    :style="{ width: 'min(92vw, 440px)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="config-form">
      <label class="config-field" for="config-turn-seconds">
        <span>玩家思考时间（秒）</span>
        <InputNumber input-id="config-turn-seconds" v-model="turnSeconds" :min="TABLE_RULES.minTurnSeconds" :max="TABLE_RULES.maxTurnSeconds" :use-grouping="false" fluid />
        <small>从下一位玩家行动开始生效，范围 {{ TABLE_RULES.minTurnSeconds }}–{{ TABLE_RULES.maxTurnSeconds }} 秒。</small>
      </label>
      <label class="config-field" for="config-next-seconds">
        <span>下一手等待时间（秒）</span>
        <InputNumber input-id="config-next-seconds" v-model="nextHandSeconds" :min="0" :max="TABLE_RULES.maxNextHandSeconds" :use-grouping="false" fluid />
        <small>设为 0 时由房主手动开局；结算后修改会重新计时。</small>
      </label>
      <p v-if="error" class="config-error" role="alert">{{ error }}</p>
    </div>
    <template #footer>
      <Button text label="取消" @click="emit('update:visible', false)" />
      <Button label="保存配置" icon="pi pi-check" :loading="saving" @click="save" />
    </template>
  </Dialog>
</template>

<style scoped>
.config-form { display: grid; gap: 18px; }
.config-field { display: grid; gap: 7px; color: var(--text); font-size: 0.85rem; }
.config-field small { color: var(--muted); font-size: 0.74rem; line-height: 1.5; }
.config-error { margin: 0; color: #fca5a5; font-size: 0.8rem; }
</style>
