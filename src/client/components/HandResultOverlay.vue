<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import type { HandResultPublic, SeatPublic } from '../../shared/protocol.ts'
import CommunityCards from './CommunityCards.vue'
import PlayingCard from './PlayingCard.vue'

const props = withDefaults(
  defineProps<{
    /** 本手结算结果（服务端 hand.settled 携带）。 */
    result: HandResultPublic
    /** 座位数组，用于把 playerId 映射成昵称。 */
    seats?: readonly (SeatPublic | null)[]
    /** 本人 playerId，用于高亮自己的收益。 */
    heroPlayerId?: string | null
    /** 是否显示。由父组件控制，便于与牌桌状态同步。 */
    visible?: boolean
  }>(),
  { seats: () => [], heroPlayerId: null, visible: false },
)

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'history'): void
}>()

function nicknameOf(playerId: string): string {
  const seat = props.seats.find((item) => item?.playerId === playerId)
  return seat?.nickname ?? '已离座玩家'
}

const winnerRows = computed(() =>
  props.result.winners.map((winner) => ({
    ...winner,
    nickname: nicknameOf(winner.playerId),
    isHero: winner.playerId === props.heroPlayerId,
  })),
)

/** 本人本手净结果。 */
const heroNet = computed(() => {
  const total = props.result.winners
    .filter((winner) => winner.playerId === props.heroPlayerId)
    .reduce((sum, winner) => sum + winner.amount, 0)
  return total
})

const heroWon = computed(() => heroNet.value > 0)

const headline = computed(() => {
  if (heroWon.value) return `你赢得 ${String(heroNet.value)} 筹码`
  if (winnerRows.value.length > 1) return '本手多人平分'
  return '本手你未赢下底池'
})

/** 屏幕阅读器摘要。 */
const spoken = computed(() => {
  const winners = winnerRows.value
    .map((row) => `${row.nickname} 赢得 ${String(row.amount)} 筹码${row.handName ? `，牌型 ${row.handName}` : ''}`)
    .join('；')
  return `第 ${String(props.result.handNo)} 手结算。${headline.value}。${winners}`
})
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="`第 ${String(result.handNo)} 手结算`"
    :style="{ width: 'min(94vw, 520px)' }"
    :draggable="false"
    :block-scroll="true"
    class="result-dialog"
    @update:visible="(value: boolean) => !value && emit('close')"
  >
    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ spoken }}</p>

    <p class="headline" :class="{ 'is-win': heroWon }">{{ headline }}</p>

    <CommunityCards :cards="result.board" />

    <!-- 赢家与各边池分配：底池编号 + 牌型 + 最佳五张。 -->
    <ul class="winners">
      <li v-for="row in winnerRows" :key="`${row.playerId}-${String(row.potIndex)}`" class="winner">
        <div class="winner-head">
          <span class="who" :class="{ 'is-hero': row.isHero }">{{ row.nickname }}</span>
          <span class="amount num">+{{ row.amount }}</span>
        </div>
        <p class="winner-meta">
          <span>{{ row.potIndex === 0 ? '主池' : `边池 ${String(row.potIndex)}` }}</span>
          <span v-if="row.handName">· {{ row.handName }}</span>
        </p>
        <div v-if="row.bestFive.length > 0" class="best-five">
          <PlayingCard v-for="card in row.bestFive" :key="card" size="sm" upright :card="card" />
        </div>
      </li>
    </ul>

    <p v-if="result.showdown" class="hint">本手进入摊牌，以上为公开亮出的底牌与最佳五张。</p>
    <p v-else class="hint">其余玩家已弃牌，底牌未公开。</p>

    <template #footer>
      <Button text :title="'查看本手历史记录'" @click="emit('history')">
        <i class="pi pi-list" aria-hidden="true" />
        <span>手牌历史</span>
      </Button>
      <Button :title="'关闭结算并继续下一手'" @click="emit('close')">
        <i class="pi pi-check" aria-hidden="true" />
        <span>知道了</span>
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.headline {
  margin: 0 0 var(--space-2);
  font-size: 1.05rem;
  color: var(--muted);
}

.headline.is-win {
  color: var(--gold);
  font-weight: 600;
}

.winners {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}

.winner {
  display: grid;
  gap: 4px;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.winner-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}

.who {
  font-weight: 600;
}

.who.is-hero {
  color: var(--gold);
}

.amount {
  margin-left: auto;
  color: var(--positive);
  font-weight: 600;
}

.winner-meta {
  margin: 0;
  display: flex;
  gap: 6px;
  font-size: 0.78rem;
  color: var(--muted);
}

.best-five {
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
}

.hint {
  margin: var(--space-2) 0 0;
}
</style>
