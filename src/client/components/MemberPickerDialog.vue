<script setup lang="ts">
import { ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import type { RoomMemberPublic } from '../../shared/protocol.ts'

/**
 * 主持人「移除玩家」弹窗：列出房间内所有人（含旁观者），自己不可移除。
 *
 * 交互设计：点「移除」先在这一行就地二次确认，而不是再弹一层对话框——
 * 移除是不可撤销操作（对方得重新拿到邀请链接），但也不该重到需要两级弹窗。
 */
const props = defineProps<{
  visible: boolean
  /** 房间成员（服务端下发）。 */
  members: readonly RoomMemberPublic[]
  /** 当前玩家 id（决定哪一行显示「这是你」）。 */
  selfId: string | null
}>()

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void
  /** 确认移除某人。 */
  (event: 'remove', playerId: string): void
  /** 打开时请求一次成员名单。 */
  (event: 'request'): void
  /** 关闭。 */
  (event: 'close'): void
}>()

/** 正在就地二次确认的那一行（null = 普通列表态）。 */
const pending = ref<RoomMemberPublic | null>(null)

// 每次打开/关闭都清掉二次确认态，避免下次打开还停在上次的「确认移除？」上。
watch(
  () => props.visible,
  () => {
    pending.value = null
  },
)

function seatText(seat: number | null): string {
  return seat === null ? '旁观' : `座位 ${String(seat + 1)}`
}

function confirmRemove(): void {
  const target = pending.value
  pending.value = null
  if (target) emit('remove', target.playerId)
}

function close(): void {
  pending.value = null
  emit('update:visible', false)
  emit('close')
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="移除玩家"
    class="vip-dialog confirm-dialog kick-dialog"
    :style="{ width: 'min(92vw, 420px)' }"
    @update:visible="(value: boolean) => emit('update:visible', value)"
    @show="emit('request')"
    @hide="pending = null"
  >
    <p class="hint">
      被移除的人会立刻离开房间、座位释放；如果还在手牌中，会先弃牌等本手结算。
      想让他回来，需要重新把邀请链接发给他。
    </p>
    <ul v-if="members.length > 0" class="kick-list">
      <li v-for="entry in members" :key="entry.playerId" class="kick-row">
        <template v-if="pending?.playerId === entry.playerId">
          <span class="kick-confirm">确定把「{{ entry.nickname }}」移出房间吗？</span>
          <span class="kick-actions">
            <Button size="small" text title="取消" @click="pending = null"><span>取消</span></Button>
            <Button size="small" severity="danger" :title="`确认移除 ${entry.nickname}`" @click="confirmRemove">
              <i class="pi pi-check" aria-hidden="true" />
              <span>确认移除</span>
            </Button>
          </span>
        </template>
        <template v-else>
          <span class="kick-who">
            <b>{{ entry.nickname }}</b>
            <span class="muted">
              {{ seatText(entry.seat) }}<template v-if="entry.isHost"> · 主持人</template>
              <template v-if="!entry.connected"> · 已断线</template>
            </span>
          </span>
          <span v-if="entry.playerId === selfId" class="muted kick-self">这是你</span>
          <Button
            v-else
            size="small"
            severity="danger"
            outlined
            :title="`把 ${entry.nickname} 移出房间`"
            @click="pending = entry"
          >
            <i class="pi pi-user-minus" aria-hidden="true" />
            <span>移除</span>
          </Button>
        </template>
      </li>
    </ul>
    <p v-else class="hint">正在读取房间成员…</p>
    <template #footer>
      <Button text title="关闭" @click="close"><span>关闭</span></Button>
    </template>
  </Dialog>
</template>
