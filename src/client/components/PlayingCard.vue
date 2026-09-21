<script setup lang="ts">
import { computed } from 'vue'
import type { Card } from '../../shared/poker.ts'
import { RANK_LABEL, SUIT_NAME, SUIT_SYMBOL, isRedSuit } from '../../shared/poker.ts'
import type { Rank, Suit } from '../../shared/protocol.ts'

const props = withDefaults(
  defineProps<{
    /** 牌面；背面向下时不需要传。 */
    card?: Card | null
    /** 是否盖牌（背面）。他人未公开底牌永远只能是背面。 */
    hidden?: boolean
    /** 尺寸档位：牌桌通用 / 公共牌稍大 / 本人底牌最大。 */
    size?: 'sm' | 'md' | 'lg'
    /** 已弃牌或已出局的牌做去饱和处理。 */
    dimmed?: boolean
    /** 操作区 / 结算区的牌：两个角标都朝上，保证正向可读。 */
    upright?: boolean
  }>(),
  { card: null, hidden: false, size: 'md', dimmed: false, upright: false },
)

const rank = computed<Rank | null>(() => (props.card ? (props.card[0] as Rank) : null))
const suit = computed<Suit | null>(() => (props.card ? (props.card[1] as Suit) : null))
const red = computed(() => (suit.value ? isRedSuit(suit.value) : false))
/** 花色字形（♠♥♦♣），与文字标签一起保证颜色不是唯一区分手段。 */
const suitSymbol = computed(() => (suit.value ? SUIT_SYMBOL[suit.value] : ''))

/** 屏幕阅读器可读的完整牌面，如「黑桃 A」「红桃 10」。 */
const label = computed(() =>
  rank.value && suit.value ? `${SUIT_NAME[suit.value]} ${RANK_LABEL[rank.value]}` : '盖住的牌',
)

/* 七段数字：小尺寸下比文字字形更清晰，且不需要额外字体。 */
const SEGMENTS: Record<string, readonly string[]> = {
  '2': ['a', 'b', 'd', 'e', 'g'],
  '3': ['a', 'b', 'c', 'd', 'g'],
  '4': ['b', 'c', 'f', 'g'],
  '5': ['a', 'c', 'd', 'f', 'g'],
  '6': ['a', 'c', 'd', 'e', 'f', 'g'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  '9': ['a', 'b', 'c', 'd', 'f', 'g'],
  T: ['a', 'b', 'c', 'e', 'f', 'g'],
  J: ['b', 'c', 'd', 'e'],
  Q: ['a', 'b', 'c', 'e', 'f', 'g'],
  K: ['b', 'c', 'e', 'f', 'g'],
  A: ['a', 'b', 'c', 'e', 'f', 'g'],
}

const segments = computed<readonly string[]>(() => (rank.value ? SEGMENTS[rank.value] : []))
</script>

<template>
  <span
    class="card"
    :class="[`card--${size}`, red ? 'is-red' : 'is-black', { 'is-hidden': hidden || !card, 'is-dim': dimmed }]"
    role="img"
    :aria-label="hidden || !card ? '盖住的牌' : label"
  >
    <!-- 背面：自绘桌布纹理，不含任何第三方美术资产。 -->
    <span v-if="hidden || !card" class="back" aria-hidden="true">
      <span class="back-svg">
        <svg class="back-weave" viewBox="0 0 40 56" preserveAspectRatio="none" focusable="false">
          <defs>
            <pattern id="cardWeave" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <path d="M0 3.5H7M3.5 0V7" stroke="currentColor" stroke-width="0.6" opacity="0.35" fill="none" />
            </pattern>
          </defs>
          <rect width="40" height="56" fill="url(#cardWeave)" />
        </svg>
      </span>
      <svg class="back-mark" viewBox="0 0 24 24" focusable="false">
        <path
          d="M12 3.6 20.4 12 12 20.4 3.6 12Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          opacity="0.75"
        />
        <path d="M12 8.6 15.4 12 12 15.4 8.6 12Z" fill="currentColor" opacity="0.5" />
      </svg>
    </span>

    <template v-else>
      <!-- 左上角标始终正向：座位上的牌可能整张朝上，这两个角一定可读。 -->
      <span class="corner corner--tl" aria-hidden="true">
        <span class="pip">
          <span v-for="seg in segments" :key="`t-${seg}`" class="seg" :class="`seg-${seg}`" />
        </span>
        <span class="suit">{{ suitSymbol }}</span>
      </span>

      <!-- 右下角标：桌上的牌朝向桌心（rotate 180），操作区的牌保持正向。 -->
      <span class="corner corner--br" :class="{ 'corner--br-flat': upright }" aria-hidden="true">
        <span class="pip">
          <span v-for="seg in segments" :key="`b-${seg}`" class="seg" :class="`seg-${seg}`" />
        </span>
        <span class="suit">{{ suitSymbol }}</span>
      </span>
    </template>
  </span>
</template>

<style scoped>
.card {
  position: relative;
  display: block;
  flex: none;
  width: var(--cw);
  height: calc(var(--cw) * 1.4);
  border-radius: calc(var(--cw) * 0.11);
  background: var(--card-face);
  color: var(--card-black);
  border: 1px solid rgba(0, 0, 0, 0.45);
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  transition: opacity 0.2s ease-out;
}

.card--sm {
  --cw: 26px;
}

.card--md {
  --cw: 42px;
}

.card--lg {
  --cw: 58px;
}

.is-red {
  color: var(--card-red);
}

.is-dim {
  opacity: 0.42;
}

/* 角标：左上角是主索引，右下角镜像；旋转仅用于牌角，不影响可读性。 */
.corner {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  line-height: 1;
}

.corner--tl {
  top: 8%;
  left: 9%;
}

.corner--br {
  right: 9%;
  bottom: 8%;
  transform: rotate(180deg);
}

/* 操作区（本人底牌、结算最佳五张）里的牌整张正向摆放，角标也要正向。 */
.corner--br-flat {
  transform: none;
}

/* 牌桌座位上的小牌：角标不旋转，避免小尺寸下字形难辨。 */
@media (max-width: 1100px) {
  .corner--br {
    transform: none;
  }
}

.suit {
  font-size: calc(var(--cw) * 0.26);
}

/* 七段数字：2.5:5 的比例，段宽随牌宽缩放。 */
.pip {
  position: relative;
  display: block;
  width: calc(var(--cw) * 0.26);
  height: calc(var(--cw) * 0.44);
}

.seg {
  position: absolute;
  background: currentColor;
  border-radius: 1px;
}

.seg-a,
.seg-d,
.seg-g {
  left: 12%;
  width: 76%;
  height: 13%;
}

.seg-a {
  top: 0;
}

.seg-g {
  top: 43.5%;
}

.seg-d {
  bottom: 0;
}

.seg-b,
.seg-c,
.seg-e,
.seg-f {
  width: 15%;
  height: 33%;
}

.seg-b,
.seg-c {
  right: 0;
}

.seg-e,
.seg-f {
  left: 0;
}

.seg-b,
.seg-f {
  top: 6%;
}

.seg-c,
.seg-e {
  bottom: 6%;
}

/* 背面。 */
.back {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--card-back-line);
  background: radial-gradient(circle at 30% 18%, #1b5674 0%, var(--card-back) 62%, #0d2b3c 100%);
}

.back-svg {
  position: absolute;
  inset: 3px;
  border-radius: calc(var(--cw) * 0.08);
  overflow: hidden;
}

.back-weave {
  display: block;
  width: 100%;
  height: 100%;
}

.back-mark {
  position: relative;
  width: 42%;
  color: var(--gold);
  opacity: 0.85;
}
</style>
