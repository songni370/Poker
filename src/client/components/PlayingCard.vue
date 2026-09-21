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

/**
 * 牌面文字：点数用「2–10 / J / Q / K / A」，10 就是两个字符的 10（不是 T）。
 * RANK_LABEL 与 aria-label 共用同一份映射，屏幕阅读器读到的也是 10。
 */
const rankText = computed(() => (rank.value ? RANK_LABEL[rank.value] : ''))
/** 花色字形（♠♥♦♣）：颜色之外的第二重区分手段。 */
const suitSymbol = computed(() => (suit.value ? SUIT_SYMBOL[suit.value] : ''))

/** 屏幕阅读器可读的完整牌面，如「黑桃 A」「红桃 10」。 */
const label = computed(() =>
  rank.value && suit.value ? `${SUIT_NAME[suit.value]} ${RANK_LABEL[rank.value]}` : '盖住的牌',
)

/** 十点用两位数字：角标要略窄一点，避免在 26px 的座位上顶到牌边。 */
const isTen = computed(() => rank.value === 'T')
</script>

<template>
  <span
    class="card"
    :class="[
      `card--${size}`,
      red ? 'is-red' : 'is-black',
      { 'is-hidden': hidden || !card, 'is-dim': dimmed, 'is-ten': isTen, 'is-upright': upright },
    ]"
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
      <!--
        牌面：左上角「点数 + 花色」角标 + 中央大花色 + 右下角镜像角标。
        点数用真实字形而不是七段数码：26px 的座位牌上，七段数字的 8/9/6 几乎分不出来，
        而且 10 会被画成 T。字号随牌宽缩放（--cw），12–58px 各档都做过截图核对。
      -->
      <span class="corner corner--tl" aria-hidden="true">
        <span class="rank">{{ rankText }}</span>
        <span class="suit">{{ suitSymbol }}</span>
      </span>

      <span class="pip" aria-hidden="true">{{ suitSymbol }}</span>

      <!-- 右下角标：桌上的牌朝向桌心（rotate 180），操作区的牌保持正向。 -->
      <span class="corner corner--br" :class="{ 'corner--br-flat': upright }" aria-hidden="true">
        <span class="rank">{{ rankText }}</span>
        <span class="suit">{{ suitSymbol }}</span>
      </span>
    </template>
  </span>
</template>

<style scoped>
.card {
  /* 发牌/亮牌：新建的牌淡入（元素复用不会重播），只动 opacity，合成层友好。
     prefers-reduced-motion 由 theme.css 的全局规则统一关闭。 */
  animation: card-in 200ms ease-out both;
}

@keyframes card-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

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
  /* 牌面文字全部用等宽数字，点数变化不跳位。 */
  font-variant-numeric: tabular-nums;
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

/*
 * 角标：点在上、花色在下，紧贴左上角；字号按牌宽等比缩放。
 * 10 是两位数，字号略收一点并压紧字距，避免在 26px 的牌上顶出边界。
 */
.corner {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 0.92;
  font-weight: 700;
}

.corner--tl {
  top: 5%;
  left: 8%;
}

.corner--br {
  right: 8%;
  bottom: 5%;
  transform: rotate(180deg);
}

/* 操作区（本人底牌、结算最佳五张）里的牌整张正向摆放，角标也要正向。 */
.corner--br-flat {
  transform: none;
}

.rank {
  font-family: var(--font-sans);
  font-size: calc(var(--cw) * 0.38);
  letter-spacing: -0.06em;
}

.is-ten .rank {
  font-size: calc(var(--cw) * 0.32);
  letter-spacing: -0.08em;
}

.suit {
  font-size: calc(var(--cw) * 0.26);
}

/*
 * 中央大花色：小尺寸下也能一眼认出花色（配合角标与颜色三重区分）。
 * 正中对齐，并收小到 0.42 牌宽——再大就会顶到右下角的镜像角标。
 */
.pip {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: calc(var(--cw) * 0.42);
  line-height: 1;
  opacity: 0.92;
}

/* 26px 的座位牌：中央花色再收一点，保证角标完整。 */
.card--sm .pip {
  font-size: calc(var(--cw) * 0.38);
}

/* 牌桌上朝向桌心的牌：小尺寸下右下角标不旋转，字形更清楚。 */
@media (max-width: 1100px) {
  .corner--br {
    transform: none;
  }
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
