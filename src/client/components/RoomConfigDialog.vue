<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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

/** 桌上已有的机器人数量（服务端下发的 isBot 标记，不靠昵称猜测）。 */
const botCount = computed(() => props.state.seats.filter((seat) => seat?.isBot).length)

/** 空位数：机器人只能坐空位。 */
const emptySeats = computed(() => props.state.seats.filter((seat) => seat === null).length)

/** 本手进行中不允许改牌桌成员，机器人也一样。 */
const handRunning = computed(
  () => props.state.phase !== 'waiting' && props.state.phase !== 'settlement',
)

/** 加一个机器人：和真人走同一条命令通道，失败会在 lastError 里体现。 */
function addBot(style: 'tight' | 'loose' | 'balanced'): void {
  error.value = ''
  session.clearError()
  if (!sendCommand({ type: 'room.add_bot', requestId: nextRequestId(), style })) {
    error.value = '尚未连接到服务器，机器人没有添加。'
  }
}

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
    class="vip-dialog config-dialog"
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
      <!-- 机器人陪练：一个人也能把整条流程跑通（下注/摊牌/结算）。 -->
      <section class="config-bots" aria-labelledby="config-bots-title">
        <div class="config-bots-head">
          <span id="config-bots-title" class="config-bots-title">
            <i class="pi pi-android" aria-hidden="true" />
            <span>机器人陪练</span>
          </span>
          <small class="config-bots-hint">
            已有 <b class="num">{{ botCount }}</b> 个 · 空位 <b class="num">{{ emptySeats }}</b>
          </small>
        </div>
        <p class="config-field-hint">
          单人测试用：机器人会自己出牌，走和真人一样的规则路径。可重复添加。
        </p>
        <div class="config-bots-actions">
          <Button
            size="small"
            data-testid="add-bot-tight"
            :disabled="handRunning || emptySeats === 0"
            :title="handRunning ? '本手进行中，等结束后再添加' : emptySeats === 0 ? '牌桌已满' : '加一个偏紧的机器人'"
            @click="addBot('tight')"
          >
            <span>加紧手</span>
          </Button>
          <Button
            size="small"
            data-testid="add-bot-balanced"
            :disabled="handRunning || emptySeats === 0"
            :title="handRunning ? '本手进行中，等结束后再添加' : emptySeats === 0 ? '牌桌已满' : '加一个均衡的机器人'"
            @click="addBot('balanced')"
          >
            <span>加均衡</span>
          </Button>
          <Button
            size="small"
            data-testid="add-bot-loose"
            :disabled="handRunning || emptySeats === 0"
            :title="handRunning ? '本手进行中，等结束后再添加' : emptySeats === 0 ? '牌桌已满' : '加一个偏松的机器人'"
            @click="addBot('loose')"
          >
            <span>加松手</span>
          </Button>
        </div>
        <small v-if="handRunning" class="config-bots-warn">本手进行中，结束后才能添加机器人。</small>
        <small v-else-if="emptySeats === 0" class="config-bots-warn">牌桌已满（{{ state.seats.length }} 席）。</small>
      </section>

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

/* 机器人陪练区块：内凹槽 + 黄铜细分隔，和弹窗其他分区同一套材质 */
.config-bots {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  background: linear-gradient(180deg, #1d1610 0%, #120d09 100%);
  border: 1px solid rgba(0, 0, 0, 0.8);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.75);
}

.config-bots-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.config-bots-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #f6ecd8;
  font-size: 0.85rem;
  font-weight: 700;
}

.config-bots-title i {
  color: #f0c668;
}

.config-bots-hint {
  color: #a08f74;
  font-size: 0.74rem;
}

.config-bots-hint b {
  color: #ffdf9a;
}

.config-field-hint {
  margin: 0;
  color: #8d7d63;
  font-size: 0.74rem;
  line-height: 1.5;
}

.config-bots-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.config-bots-actions :deep(.p-button) {
  min-height: 34px;
  border-radius: 9px;
  background: linear-gradient(180deg, #3b2f22 0%, #241b12 100%);
  border: 1px solid rgba(0, 0, 0, 0.75);
  color: #f1e6d0;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    inset 0 -2px 4px rgba(0, 0, 0, 0.6),
    0 2px 4px rgba(0, 0, 0, 0.5);
}

.config-bots-actions :deep(.p-button:disabled) {
  opacity: 0.5;
}

.config-bots-warn {
  color: #c9a86a;
  font-size: 0.72rem;
}
</style>
