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
          <div :key="cards[slot]" class="board-card-wrap" :class="`slot--${slot}`">
            <!-- 真正正面对准玩家的公共牌（终态绝对保证100%正面可读） -->
            <PlayingCard
              class="board-card"
              size="md"
              :card="cards[slot]"
              :dimmed="highlight.length > 0 && !isHighlighted(cards[slot]!)"
            />
            <!-- 翻牌前半段微窥见牌背纹理层（45%即顺滑消失） -->
            <span class="board-card-back-peek" aria-hidden="true" />
            <!-- 翻正落桌后的流金划过层 -->
            <span class="board-card-gleam" aria-hidden="true" />
          </div>
        </template>
        <span v-else class="slot--empty" aria-hidden="true" />
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

/* 3D 翻开公共牌卡槽容器 */
.board-card-wrap {
  position: relative;
  width: var(--board-cw, 42px);
  height: calc(var(--board-cw, 42px) * 1.4);
  flex: none;
  perspective: 700px;
  animation: board-card-flip 0.58s cubic-bezier(0.25, 1, 0.35, 1) both;
  transform-origin: center center;
}

/* 翻牌圈前三张牌依次递进翻开（0ms, 90ms, 180ms），转牌与河牌发牌即时翻开 */
.slot--0 {
  animation-delay: 0ms;
}

.slot--1 {
  animation-delay: 90ms;
}

.slot--2 {
  animation-delay: 180ms;
}

.slot--3 {
  animation-delay: 0ms;
}

.slot--4 {
  animation-delay: 0ms;
}

/* 物理 3D 翻牌动画：侧立入场、翻转过冲、弹性平稳落桌，终态必定100%正面对准玩家 */
@keyframes board-card-flip {
  0% {
    transform: perspective(700px) rotateY(-88deg) translateY(-14px) scale(0.9);
    opacity: 0.2;
    filter: drop-shadow(0 16px 20px rgba(0, 0, 0, 0.8));
  }
  45% {
    transform: perspective(700px) rotateY(-40deg) translateY(-10px) scale(1.05);
    opacity: 1;
    filter: drop-shadow(0 10px 14px rgba(0, 0, 0, 0.65));
  }
  75% {
    transform: perspective(700px) rotateY(6deg) translateY(-2px) scale(1.02);
    opacity: 1;
    filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.5));
  }
  100% {
    transform: perspective(700px) rotateY(0deg) translateY(0) scale(1);
    opacity: 1;
    filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.45));
  }
}

.board-card {
  width: 100% !important;
  height: 100% !important;
}

/* 翻转前半段（0%~45%）牌背微窥层，翻过45度顺滑淡出消失 */
.board-card-back-peek {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-sm);
  background: radial-gradient(circle at 30% 18%, #1b5674 0%, var(--card-back, #0d2b3c) 62%, #081a24 100%);
  border: 1px solid rgba(212, 177, 106, 0.35);
  pointer-events: none;
  animation: back-peek-fade 0.58s cubic-bezier(0.25, 1, 0.35, 1) both;
}

.slot--0 .board-card-back-peek {
  animation-delay: 0ms;
}

.slot--1 .board-card-back-peek {
  animation-delay: 90ms;
}

.slot--2 .board-card-back-peek {
  animation-delay: 180ms;
}

.slot--3 .board-card-back-peek {
  animation-delay: 0ms;
}

.slot--4 .board-card-back-peek {
  animation-delay: 0ms;
}

@keyframes back-peek-fade {
  0% {
    opacity: 1;
  }
  38% {
    opacity: 0.95;
  }
  48% {
    opacity: 0;
  }
  100% {
    opacity: 0;
  }
}

/* 翻牌落桌后的金色流光掠过层 */
.board-card-gleam {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-sm);
  background: linear-gradient(105deg, transparent 20%, rgba(255, 255, 255, 0.45) 45%, rgba(212, 177, 106, 0.5) 55%, transparent 75%);
  background-size: 200% 200%;
  pointer-events: none;
  opacity: 0;
  animation: gleam-swipe 0.65s cubic-bezier(0.2, 0.8, 0.25, 1) forwards;
}

.slot--0 .board-card-gleam {
  animation-delay: 0.22s;
}

.slot--1 .board-card-gleam {
  animation-delay: 0.31s;
}

.slot--2 .board-card-gleam {
  animation-delay: 0.40s;
}

.slot--3 .board-card-gleam {
  animation-delay: 0.22s;
}

.slot--4 .board-card-gleam {
  animation-delay: 0.22s;
}

@keyframes gleam-swipe {
  0% {
    opacity: 0;
    background-position: 200% 0;
  }
  30% {
    opacity: 0.85;
  }
  100% {
    opacity: 0;
    background-position: -200% 0;
  }
}

.slot--empty {
  display: block;
  width: var(--board-cw, 42px);
  height: calc(var(--board-cw, 42px) * 1.4);
  border-radius: var(--radius-sm);
  border: 1px dashed rgba(242, 241, 234, 0.18);
  background: rgba(0, 0, 0, 0.12);
  box-sizing: border-box;
}
</style>
