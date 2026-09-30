<script setup lang="ts">
import { computed } from 'vue'
import { ACTION_NAMES } from '../../shared/poker.ts'
import type { SeatPublic } from '../../shared/protocol.ts'
import PlayingCard from './PlayingCard.vue'

const props = withDefaults(
  defineProps<{
    seat: SeatPublic
    /** 是否为本人座位（决定是否显示「你」标记与角标位置）。 */
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
    isHero: false,
    isActing: false,
    isWinner: false,
    remainingRatio: 1,
    remainingSeconds: 0,
    turnSeconds: 20,
  },
)

/**
 * 手牌张数：本人座位不画牌（正面背面都不画），其余玩家按 holeCardCount 画背面。
 * 本人底牌只在底部操作区显示：那里牌更大、不会被桌沿或筹码挡住，
 * 也避免同一份底牌在屏幕上出现两次。
 */
const cardCount = computed(() => (props.isHero ? 0 : props.seat.holeCardCount))

const statusText = computed(() => {
  // 「已离座」优先于弃牌/全下：座位还占着、筹码还留着，但人已经离开牌桌
  //（第 6 项需求）。别人必须能一眼看出这个座位只是被保留。
  if (props.seat.away) return '已离座'
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

/**
 * 庄家 / 盲位角标（D、SB、BB）。
 * 位置从「桌面上的庄家按钮」搬到座位面板内：桌面按钮会压住底牌背面或底池
 * （实测 740×360 压住底池 6.9×22px），面板内角标则永远只占面板自己的空间。
 * 双人桌时同一座位可能既是庄家又是小盲，所以是一组角标。
 * 头像圆与首字头像已删除：左侧这一块改成纯粹的「牌局角色」槽位，
 * 没有角色时整块不渲染也不占位（昵称与筹码因此拿到更多宽度）。
 */
const roleBadges = computed(() => {
  const badges: { key: string; label: string; tone: 'dealer' | 'blind' }[] = []
  if (props.seat.isDealer) badges.push({ key: 'dealer', label: 'D', tone: 'dealer' })
  if (props.seat.isSmallBlind) badges.push({ key: 'sb', label: 'SB', tone: 'blind' })
  if (props.seat.isBigBlind) badges.push({ key: 'bb', label: 'BB', tone: 'blind' })
  return badges
})

/** 屏幕阅读器摘要：昵称、筹码、当前状态，一次读完。 */
const spoken = computed(() => {
  const parts = [`座位 ${String(props.seat.seat + 1)}`, props.seat.nickname, `筹码 ${String(props.seat.stack)}`]
  if (roleText.value) parts.push(roleText.value)
  if (props.seat.committedStreet > 0) parts.push(`本轮下注 ${String(props.seat.committedStreet)}`)
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
      'is-away': seat.away,
    }"
    :aria-label="spoken"
  >
    <!-- 底牌：本人正面在底部操作区看大图，其他人按手牌张数画背面 -->
    <div v-if="cardCount > 0" class="cards">
      <PlayingCard
        v-for="index in cardCount"
        :key="`back-${String(index)}`"
        size="sm"
        hidden
        :dimmed="seat.folded"
      />
    </div>

    <!-- 紧凑自适应玩家卡片（轻巧双行结构，彻底告别臃肿厚重，尺寸随屏幕流式缩放） -->
    <div class="panel">
      <!-- 第一行：座位号 + 完整昵称（含自己标） + 右侧角色徽标（D/SB/BB） -->
      <div class="seat-row seat-row--top">
        <div class="seat-identity">
          <span class="seat-no num" aria-hidden="true">{{ seat.seat + 1 }}</span>
          <span
            class="name"
            :class="{
              'name--compact': seat.nickname.length >= 5 && seat.nickname.length < 8,
              'name--tight': seat.nickname.length >= 8,
            }"
            :title="seat.nickname"
          >
            {{ seat.nickname }}
          </span>
          <span v-if="isHero" class="tag tag--hero">你</span>
        </div>
        <div v-if="roleBadges.length > 0" class="roles" aria-hidden="true">
          <span
            v-for="badge in roleBadges"
            :key="badge.key"
            class="role-badge"
            :class="`role-badge--${badge.tone}`"
          >
            {{ badge.label }}
          </span>
        </div>
      </div>

      <!-- 第二行：筹码金额（等宽鲜艳、100% 完整无截断） + 右侧状态标（ALL IN / 离座 / 弃牌 / 断线） -->
      <div class="seat-row seat-row--bottom">
        <span
          class="stack num"
          :class="{
            'stack--compact': String(seat.stack).length >= 6 && String(seat.stack).length < 8,
            'stack--tight': String(seat.stack).length >= 8,
          }"
          :title="`筹码：${seat.stack}`"
        >
          {{ seat.stack }}
        </span>
        <div class="seat-flags">
          <span v-if="!seat.connected" class="flag flag--off" aria-hidden="true" title="已断线">
            <i class="pi pi-wifi" />
          </span>
          <span v-else-if="seat.allIn" class="flag flag--allin" aria-hidden="true">ALL IN</span>
          <span v-else-if="seat.away" class="flag flag--away" aria-hidden="true">已离座</span>
          <span v-else-if="seat.folded" class="flag flag--folded" aria-hidden="true">已弃牌</span>
        </div>
      </div>

      <!-- 本轮下注面板角标（在小屏无桌面浮动筹码时显示） -->
      <span v-if="seat.committedStreet > 0" class="panel-bet num" aria-hidden="true">
        {{ seat.committedStreet }}
      </span>
    </div>

    <!-- 倒计时进度条与时间一体化胶囊：轮到该玩家行动时出现 -->
    <div
      v-if="isActing"
      class="seat-timer-capsule"
      :class="{ 'is-urgent': remainingSeconds <= 5 }"
      role="progressbar"
      :aria-valuenow="remainingSeconds"
      aria-valuemin="0"
      :aria-valuemax="turnSeconds"
      :aria-label="`行动倒计时，剩余 ${String(remainingSeconds)} 秒`"
    >
      <span class="seat-timer-fill" :style="{ transform: `scaleX(${String(percent / 100)})` }" />
      <span class="seat-timer-label num">
        <i class="pi pi-clock seat-timer-icon" aria-hidden="true" />
        <span>{{ isHero ? '轮到你' : '思考中' }} {{ remainingSeconds }}s</span>
      </span>
    </div>

    <!-- 非行动态的状态行（动作反馈） -->
    <p
      v-else-if="statusText || lastActionText"
      class="status"
      :class="{ 'is-action-only': !statusText && Boolean(lastActionText) }"
    >
      <span class="state">{{ statusText || lastActionText }}</span>
    </p>
  </article>
</template>

<style scoped>
/* 整个座位容器：尺寸随屏幕流式自适应，彻底告别死板过大尺寸 */
.seat {
  display: grid;
  justify-items: center;
  gap: 2px;
  width: var(--seat-w, clamp(80px, 10vw, 122px));
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.cards {
  display: flex;
  gap: 2px;
  margin-bottom: -1px;
}

.cards :deep(.card--sm) {
  --cw: clamp(19px, 2.2vw, 24px);
}

/* 核心面板：极其轻巧扁平的两行架构，内边距与圆角流式自适应 */
.panel {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  width: 100%;
  min-width: 0;
  padding: clamp(2px, 0.4vw, 4px) clamp(4px, 0.6vw, 7px);
  border-radius: clamp(4px, 0.5vw, 6px);
  border: 1px solid rgba(212, 177, 106, 0.22);
  background: linear-gradient(180deg, rgba(24, 32, 42, 0.94) 0%, rgba(14, 19, 26, 0.97) 100%);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  box-sizing: border-box;
}

.is-acting .panel {
  border-color: #ffd875;
  box-shadow: 0 0 16px rgba(212, 177, 106, 0.65), inset 0 0 8px rgba(212, 177, 106, 0.35);
  animation: seat-glow 1.8s ease-in-out infinite;
}

.is-hero .panel {
  border-color: rgba(212, 177, 106, 0.65);
  background: linear-gradient(180deg, rgba(28, 38, 50, 0.96) 0%, rgba(18, 24, 32, 0.98) 100%);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(212, 177, 106, 0.25);
}

.is-folded {
  opacity: 0.42;
  filter: grayscale(0.4);
}

.is-out .panel {
  border-style: dashed;
  border-color: var(--danger);
}

.is-away .panel {
  border-style: dashed;
  border-color: var(--gold-soft);
  background: rgba(20, 26, 34, 0.75);
}

.is-winner .panel {
  border-color: #ffe394;
  box-shadow: 0 0 20px rgba(255, 227, 148, 0.75), inset 0 0 8px rgba(255, 227, 148, 0.4);
  animation: soft-pulse 1.3s ease-in-out infinite;
}

/* 行容器：左右对齐，利用率 100% */
.seat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-width: 0;
  gap: 3px;
  line-height: 1.15;
}

/* 身份区域（座位号 + 昵称 + 你） */
.seat-identity {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  flex: 1 1 auto;
}

.seat-no {
  flex: none;
  min-width: 12px;
  padding: 0 2px;
  border-radius: 2px;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg) 60%, transparent);
  color: var(--muted);
  font-size: clamp(0.50rem, 0.6vw, 0.58rem);
  line-height: 1.25;
  text-align: center;
  font-weight: 700;
}

.name {
  color: var(--text);
  font-size: clamp(0.66rem, 0.8vw, 0.76rem);
  font-weight: 600;
  line-height: 1.15;
  word-break: break-all;
  white-space: normal;
  overflow: visible;
  letter-spacing: -0.01em;
}

.name--compact {
  font-size: clamp(0.60rem, 0.72vw, 0.68rem);
  letter-spacing: -0.02em;
}

.name--tight {
  font-size: clamp(0.54rem, 0.65vw, 0.62rem);
  letter-spacing: -0.03em;
}

.tag {
  flex: none;
  padding: 0 2px;
  border-radius: 2px;
  font-size: clamp(0.48rem, 0.55vw, 0.54rem);
  line-height: 1.2;
}

.tag--hero {
  background: var(--gold-dim);
  color: var(--gold);
  font-weight: 700;
}

/* 角色徽标 */
.roles {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.role-badge {
  min-width: 11px;
  padding: 0 2px;
  border-radius: 2px;
  font-size: clamp(0.48rem, 0.56vw, 0.54rem);
  font-weight: 800;
  line-height: 1.25;
  text-align: center;
}

.role-badge--dealer {
  background: linear-gradient(135deg, #ffd875 0%, #cb9b51 100%);
  color: #0b0f14;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

.role-badge--blind {
  background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);
  color: #ffffff;
}

/* 筹码数字：金黄色鲜艳、等宽数字、100% 完整展示绝不截断 */
.stack {
  color: #ffd875;
  font-size: clamp(0.70rem, 0.85vw, 0.80rem);
  font-weight: 700;
  white-space: nowrap;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  overflow: visible;
  line-height: 1.15;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  flex: 1 1 auto;
  min-width: 0;
}

.stack--compact {
  font-size: clamp(0.64rem, 0.76vw, 0.72rem);
  letter-spacing: -0.03em;
}

.stack--tight {
  font-size: clamp(0.58rem, 0.68vw, 0.64rem);
  letter-spacing: -0.04em;
}

/* 状态标集 */
.seat-flags {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.flag {
  font-size: clamp(0.48rem, 0.56vw, 0.54rem);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: 0.02em;
  padding: 1px 3px;
  border-radius: 2px;
}

.flag--off {
  color: var(--danger);
}

.flag--allin {
  color: #0b0f14;
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
}

.flag--away {
  color: var(--gold-soft);
  border: 1px dashed var(--gold-soft);
}

.flag--folded {
  color: var(--muted);
  background: rgba(255, 255, 255, 0.1);
}

/* 本人座位不重复显示「行动倒计时」：底部操作区已有专属的大型倒计时舱 */
.is-hero .status,
.is-hero .seat-timer-capsule {
  display: none;
}

.panel-bet {
  display: none;
  position: absolute;
  right: 3px;
  bottom: 2px;
  color: var(--gold);
  font-size: 0.58rem;
  line-height: 1.2;
  font-weight: 700;
}

.status {
  margin: 0;
  font-size: clamp(0.58rem, 0.68vw, 0.66rem);
  line-height: 1.2;
  text-align: center;
  color: var(--muted);
}

.state {
  color: var(--muted);
}

.seat-timer-capsule {
  position: relative;
  width: 100%;
  max-width: var(--seat-w, 110px);
  height: clamp(14px, 1.8vw, 17px);
  border-radius: 999px;
  overflow: hidden;
  background: rgba(10, 15, 22, 0.9);
  border: 1px solid rgba(212, 177, 106, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
}

.seat-timer-capsule.is-urgent {
  border-color: rgba(239, 68, 68, 0.7);
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.5);
}

.seat-timer-fill {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background: linear-gradient(90deg, #10b981 0%, #f59e0b 60%, #ef4444 100%);
  opacity: 0.85;
  transition: transform 0.15s linear;
}

.seat-timer-capsule.is-urgent .seat-timer-fill {
  background: linear-gradient(90deg, #dc2626 0%, #ef4444 100%);
}

.seat-timer-label {
  position: relative;
  z-index: 2;
  font-size: clamp(0.56rem, 0.66vw, 0.62rem);
  font-weight: 700;
  color: #ffffff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95);
  display: flex;
  align-items: center;
  gap: 2px;
  line-height: 1;
}

.seat-timer-icon {
  font-size: 0.58rem;
  color: #ffd875;
}

/* 竖屏窄屏自适应规则 */
@media (max-width: 560px) and (orientation: portrait) {
  .seat .cards,
  .seat .status.is-action-only {
    display: none;
  }

  .panel-bet {
    display: inline-flex;
  }
}
</style>
