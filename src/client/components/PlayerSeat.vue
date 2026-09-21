<script setup lang="ts">
import { computed } from 'vue'
import type { Card } from '../../shared/poker.ts'
import { ACTION_NAMES } from '../../shared/poker.ts'
import type { SeatPublic } from '../../shared/protocol.ts'
import PlayingCard from './PlayingCard.vue'

const props = withDefaults(
  defineProps<{
    seat: SeatPublic
    /** 只对本人传底牌；他人永远是背面。 */
    holeCards?: readonly Card[]
    /** 是否为本人座位（决定是否显示牌面与「你」标记）。 */
    isHero?: boolean
    /** 是否正在行动（光环 + YOUR TURN + 进度条三重提示）。 */
    isActing?: boolean
    /** 本手牌赢家（叠加金色标记，不是唯一提示手段）。 */
    isWinner?: boolean
    /** 剩余时间比例 0–1；仅行动中需要。 */
    remainingRatio?: number
    /** 剩余秒数；仅行动中需要。 */
    remainingSeconds?: number
    /** 每轮行动总秒数，用于进度条的无障碍范围。 */
    turnSeconds?: number
  }>(),
  {
    holeCards: () => [],
    isHero: false,
    isActing: false,
    isWinner: false,
    remainingRatio: 1,
    remainingSeconds: 0,
    turnSeconds: 20,
  },
)

/** 手牌张数：本人用真实底牌，其他玩家只按 holeCardCount 画背面。 */
const cardCount = computed(() => (props.isHero ? props.holeCards.length : props.seat.holeCardCount))

const statusText = computed(() => {
  if (!props.seat.connected) return '已断线'
  if (props.seat.folded) return '已弃牌'
  if (props.seat.allIn) return '全下'
  if (props.isHero) return '你'
  return ''
})

const lastActionText = computed(() => (props.seat.lastAction ? ACTION_NAMES[props.seat.lastAction] : ''))

const roleText = computed(() => {
  if (props.seat.isDealer) return '庄家位'
  if (props.seat.isSmallBlind) return '小盲'
  if (props.seat.isBigBlind) return '大盲'
  return ''
})

const avatarText = computed(() => props.seat.nickname.slice(0, 1) || '?')

/** 屏幕阅读器摘要：昵称、筹码、当前状态，一次读完。 */
const spoken = computed(() => {
  const parts = [`座位 ${String(props.seat.seat + 1)}`, props.seat.nickname, `筹码 ${String(props.seat.stack)}`]
  if (roleText.value) parts.push(roleText.value)
  if (statusText.value) parts.push(statusText.value)
  if (props.isActing) parts.push('正在行动')
  return parts.join('，')
})

const percent = computed(() => Math.round(Math.min(1, Math.max(0, props.remainingRatio)) * 100))
</script>

<template>
  <article
    class="seat"
    :class="{
      'is-acting': isActing,
      'is-folded': seat.folded,
      'is-out': !seat.connected,
      'is-allin': seat.allIn,
      'is-winner': isWinner,
      'is-hero': isHero,
    }"
    :aria-label="spoken"
  >
    <!-- 底牌：本人正面，其他人按手牌张数画背面。 -->
    <div v-if="cardCount > 0" class="cards">
      <template v-if="isHero">
        <PlayingCard v-for="card in holeCards" :key="card" size="sm" upright :card="card" :dimmed="seat.folded" />
      </template>
      <template v-else>
        <PlayingCard
          v-for="index in cardCount"
          :key="`back-${String(index)}`"
          size="sm"
          hidden
          :dimmed="seat.folded"
        />
      </template>
    </div>

    <div class="panel">
      <span class="seat-aura" aria-hidden="true" />
      <span class="avatar" aria-hidden="true">{{ avatarText }}</span>

      <span class="meta">
        <span class="name">
          {{ seat.nickname }}
          <span v-if="isHero" class="tag tag--hero">你</span>
        </span>
        <span class="stack num">{{ seat.stack }}</span>
      </span>

      <span v-if="!seat.connected" class="flag flag--off" aria-hidden="true">
        <i class="pi pi-wifi" />
      </span>
      <span v-else-if="seat.allIn" class="flag flag--allin" aria-hidden="true">ALL IN</span>
    </div>

    <!-- 状态行：文本形式（不仅靠颜色）。 -->
    <p v-if="isActing || statusText || lastActionText" class="status">
      <span v-if="isActing" class="turn">YOUR TURN</span>
      <span v-else-if="statusText" class="state">{{ statusText }}</span>
      <span v-else-if="lastActionText" class="state">{{ lastActionText }}</span>
    </p>

    <!-- 倒计时进度条：仅在轮到该玩家时出现。 -->
    <div
      v-if="isActing"
      class="timer"
      role="progressbar"
      :aria-valuenow="remainingSeconds"
      aria-valuemin="0"
      :aria-valuemax="turnSeconds"
      :aria-label="`行动倒计时，剩余 ${String(remainingSeconds)} 秒`"
    >
      <span class="timer-fill" :style="{ transform: `scaleX(${String(percent / 100)})` }" />
    </div>
  </article>
</template>

<style scoped>
.seat {
  display: grid;
  justify-items: center;
  gap: 4px;
  width: var(--seat-w, 144px);
  transition: opacity 0.2s ease-out;
}

.cards {
  display: flex;
  gap: 3px;
}

.panel {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
}

.is-hero .panel {
  border-color: var(--gold-soft);
}

.is-folded {
  opacity: 0.55;
}

.is-out .panel {
  border-style: dashed;
  border-color: var(--danger);
}

.is-winner .panel {
  border-color: var(--gold);
}

/* 头像光环：颜色之外还有动画与 YOUR TURN 文本。 */
.seat-aura {
  position: absolute;
  left: 8px;
  top: 50%;
  width: 34px;
  height: 34px;
  margin-top: -17px;
  border-radius: 50%;
  pointer-events: none;
}

.avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--felt-deep);
  border: 1px solid var(--gold-soft);
  color: var(--text);
  font-size: 0.95rem;
  font-weight: 600;
}

.meta {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.name {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.82rem;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag {
  flex: none;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 0.62rem;
  line-height: 1.5;
}

.tag--hero {
  background: var(--gold-dim);
  color: var(--gold);
}

.stack {
  font-size: 0.78rem;
  color: var(--muted);
}

.flag {
  margin-left: auto;
  font-size: 0.6rem;
  letter-spacing: 0.06em;
}

.flag--off {
  color: var(--danger);
}

.flag--allin {
  color: var(--gold);
  font-weight: 700;
}

.status {
  margin: 0;
  font-size: 0.68rem;
  line-height: 1.3;
  text-align: center;
  color: var(--muted);
}

.turn {
  color: var(--gold);
  font-weight: 700;
  letter-spacing: 0.08em;
}

.state {
  color: var(--muted);
}

.timer {
  position: relative;
  width: 100%;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.35);
}

.timer-fill {
  display: block;
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background: var(--gold);
}

/* 横向空间不足时压缩座位宽度，保证 9 人桌不横向溢出。 */
@media (max-width: 1100px) {
  .seat {
    width: 124px;
  }
}

/* 竖屏窄屏：座位收窄到桌面内，避免横向溢出。 */
@media (max-width: 560px) and (orientation: portrait) {
  .seat {
    width: 108px;
  }

  .avatar {
    width: 28px;
    height: 28px;
    font-size: 0.85rem;
  }

  .seat-aura {
    left: 8px;
    width: 28px;
    height: 28px;
    margin-top: -14px;
  }

  .name {
    font-size: 0.74rem;
  }
}

@media (max-height: 430px) {
  /* 矮屏：座位收窄，避免挡住中央的公共牌。 */
  .seat {
    width: 104px;
  }

  .status {
    font-size: 0.62rem;
  }

  .avatar {
    width: 28px;
    height: 28px;
    font-size: 0.85rem;
  }

  .seat-aura {
    left: 8px;
    width: 28px;
    height: 28px;
    margin-top: -14px;
  }

  .name {
    font-size: 0.74rem;
  }
}
</style>
