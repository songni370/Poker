<script setup lang="ts">
import { computed } from 'vue'
import type { Card } from '../../shared/poker.ts'
import { STREET_NAMES } from '../../shared/poker.ts'
import type { Street } from '../../shared/protocol.ts'
import PlayingCard from './PlayingCard.vue'

const props = withDefaults(
  defineProps<{
    /** 公共牌，0 / 3 / 4 / 5 张。 */
    cards?: readonly Card[]
    /** 当前轮次；未传时按公共牌数量推断，仅用于展示文案。 */
    street?: Street | null
    /** 结算叠层打开时高亮本手牌的最佳五张。 */
    highlight?: readonly Card[]
  }>(),
  { cards: () => [], street: null, highlight: () => [] },
)

const SLOTS = [0, 1, 2, 3, 4] as const

const derivedStreet = computed<Street | null>(() => {
  if (props.street) return props.street
  switch (props.cards.length) {
    case 3:
      return 'flop'
    case 4:
      return 'turn'
    case 5:
      return 'river'
    default:
      return null
  }
})

const streetText = computed(() => (derivedStreet.value ? STREET_NAMES[derivedStreet.value] : '等待发牌'))

/** 公共牌的中文读法，供屏幕阅读器播报。 */
const spoken = computed(() => {
  if (props.cards.length === 0) return '公共牌尚未发出'
  return `公共牌 ${String(props.cards.length)} 张`
})

function isHighlighted(card: Card): boolean {
  return props.highlight.includes(card)
}
</script>

<template>
  <section class="board" aria-label="公共牌">
    <p class="street">
      <span class="street-name">{{ streetText }}</span>
      <span class="street-count num">{{ cards.length }}/5</span>
    </p>

    <div class="row">
      <template v-for="slot in SLOTS" :key="slot">
        <!-- 发牌间隙：翻牌与转牌之间留一道可见停顿，方便一眼数牌。 -->
        <span v-if="slot === 3" class="gap" aria-hidden="true" />
        <template v-if="cards[slot]">
          <PlayingCard
            class="slot anim-rise"
            size="md"
            :card="cards[slot]"
            :dimmed="highlight.length > 0 && !isHighlighted(cards[slot]!)"
          />
        </template>
        <span v-else class="slot slot--empty" aria-hidden="true" />
      </template>
    </div>

    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ spoken }}</p>
  </section>
</template>

<style scoped>
.board {
  display: grid;
  justify-items: center;
  gap: 6px;
}

.street {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  margin: 0;
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  color: var(--gold);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}

.street-count {
  color: rgba(242, 241, 234, 0.62);
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.gap {
  width: var(--space-2);
}

.slot {
  animation-delay: 40ms;
}

.slot--empty {
  display: block;
  width: 42px;
  height: 59px;
  border-radius: var(--radius-sm);
  border: 1px dashed rgba(242, 241, 234, 0.18);
  background: rgba(0, 0, 0, 0.12);
}
</style>
