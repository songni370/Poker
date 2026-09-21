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

    <!-- 状态行：文本形式（不仅靠颜色）。
         is-action-only 只说明「上一手做了什么」，矮屏/竖屏可以让位给公共牌；
         已弃牌、全下、断线、轮到你这些状态永远不会被隐藏。 -->
    <p
      v-if="isActing || statusText || lastActionText"
      class="status"
      :class="{ 'is-action-only': !isActing && !statusText && Boolean(lastActionText) }"
    >
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
    /* 走变量：牌桌会给「贴边座位」单独设一个更窄的 --seat-w（见 PokerTable 竖屏规则）。 */
    width: var(--seat-w, 108px);
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

  /*
   * 竖屏只有 ~358px 宽、9 个座位环成一圈：座位面板每高 10px，公共牌就被吃掉 10px。
   * 这里只保留「头像 + 昵称 + 筹码」，面板从 ~105px 收到 ~47px，公共牌区不再被压住：
   *   - 底牌：本人底牌在下方操作区有大图；他人只画背面，弃牌/全下的状态由面板淡化与 ALL IN 标记给出；
   *   - 「上一手动作」文本：下注筹码本身就在桌上显示金额；
   *   - 行动提示：本人由底部 YOUR TURN + 进度条给出，他人由操作区的「等待 X 行动」给出；
   *   - 已弃牌 / 全下 / 已断线 / 轮到你的文本状态一律保留（不靠颜色区分）。
   */
  .seat .cards,
  .seat .status.is-action-only {
    display: none;
  }

  .is-hero .status,
  .is-hero .timer {
    display: none;
  }
}

@media (max-height: 430px) {
  /* 矮屏：座位收窄，避免挡住中央的公共牌。 */
  .seat {
    width: 104px;
    gap: 2px;
  }

  /*
   * 矮屏下座位面板有 ~100px 高，无论锚点怎么调都会压到公共牌/底池（实测 9 人桌 740×360
   * 时底池被完全盖住）。这里让所有座位只保留「姓名 + 筹码」两项关键信息：
   *   - 头像与光环让位；行动提示仍由「面板描边 + YOUR TURN 文本 + 进度条」三重给出；
   *   - 本人座位的底牌在下方操作区已有大图，座位里重复的小牌一并省掉。
   *
   * 进一步：状态行（YOUR TURN + 进度条、上一手动作文字）让面板从 47px 长到 67px，
   * 在 118px 高的桌面上必然重新压住公共牌。因此矮屏连状态行一起收起：
   *   - 轮到本人：底部操作区有 YOUR TURN + 秒数 + 整条进度条，信息不丢；
   *   - 轮到别人：操作区显示「等待 X 行动」，也是文本；
   *   - 已弃牌 / 全下 / 已断线：仍由面板淡化、ALL IN 标记、断线图标与虚线边框给出（不靠颜色）。
   */
  .seat .avatar,
  .seat .seat-aura,
  .seat .cards,
  .seat .status,
  .seat .timer {
    display: none;
  }

  .name {
    font-size: 0.74rem;
  }
}
</style>
