<script setup lang="ts">
import { computed } from 'vue'
import type { Card } from '../../shared/poker.ts'
import { STREET_NAMES } from '../../shared/poker.ts'
import type { SeatPublic } from '../../shared/protocol.ts'
import CommunityCards from './CommunityCards.vue'
import PlayerSeat from './PlayerSeat.vue'

const props = withDefaults(
  defineProps<{
    /** 座位数组，下标即座位号，空位为 null。 */
    seats: readonly (SeatPublic | null)[]
    maxSeats: number
    buttonSeat?: number | null
    board?: readonly Card[]
    potTotal?: number
    pots?: readonly { amount: number; eligiblePlayerIds: readonly string[] }[]
    currentBet?: number
    /** 本人座位号；用于把本人固定放在桌面下沿中央。 */
    heroSeat?: number | null
    /** 本人底牌；只发给本人渲染。 */
    heroCards?: readonly Card[]
    /** 本人 playerId，用于标记。 */
    heroPlayerId?: string | null
    actingPlayerId?: string | null
    remainingRatio?: number
    remainingSeconds?: number
    turnSeconds?: number
    /** 本手牌赢家 playerId 集合（结算时高亮）。 */
    winnerPlayerIds?: readonly string[]
    /** 结算高亮的最佳五张。 */
    highlightCards?: readonly Card[]
    /** 公共牌轮次文案。 */
    street?: 'preflop' | 'flop' | 'turn' | 'river' | null
    /** 系统提示（如「XX 超时自动弃牌」）。 */
    notice?: string
  }>(),
  {
    buttonSeat: null,
    board: () => [],
    potTotal: 0,
    pots: () => [],
    currentBet: 0,
    heroSeat: null,
    heroCards: () => [],
    heroPlayerId: null,
    actingPlayerId: null,
    remainingRatio: 1,
    remainingSeconds: 0,
    turnSeconds: 20,
    winnerPlayerIds: () => [],
    highlightCards: () => [],
    street: null,
    notice: '',
  },
)

/** 座位锚点：椭圆 + 本人固定在下沿中央。百分比定位，随容器等比缩放。 */
const RX = 47
const RY = 41

/** 座位相对桌心的极角：偏移半桌，使本人落在 90°（椭圆下沿中央）。 */
function polarFor(index: number): { angle: number } {
  const total = Math.max(props.maxSeats, 2)
  const hero = props.heroSeat ?? -1
  const offset = hero >= 0 ? hero + total / 2 : 0
  return { angle: ((index - offset) / total) * Math.PI * 2 + Math.PI / 2 }
}

function offsetFor(index: number): { x: number; y: number } {
  const { angle } = polarFor(index)
  // 下注筹码朝桌心挪 30%，始终留在桌布范围内。
  const dx = -Math.cos(angle) * RX * 0.3
  const dy = -Math.sin(angle) * RY * 0.3
  return { x: 50 + RX * Math.cos(angle) + dx, y: 50 + RY * Math.sin(angle) + dy }
}

/** 庄家按钮贴着对应座位的面板外沿，与座位一起旋转对齐。 */
function dealerStyle(index: number): Record<string, string> {
  const { angle } = polarFor(index)
  const dx = -Math.cos(angle) * RX * 0.12
  const dy = -Math.sin(angle) * RY * 0.12
  const x = 50 + RX * Math.cos(angle) + dx
  const y = 50 + RY * Math.sin(angle) + dy
  const rotate = Math.round((Math.atan2(y - 50, x - 50) * 180) / Math.PI)
  return { left: `${String(x)}%`, top: `${String(y)}%`, transform: `translate(-50%, -50%) rotate(${String(rotate)}deg)` }
}

function seatStyle(index: number): Record<string, string> {
  const { angle } = polarFor(index)
  // y 方向的半径由 CSS 变量控制，小屏时自动收窄，避免座位越出桌面。
  return {
    left: `calc(50% + var(--seat-anchor-x, ${String(RX)}%) * ${String(Math.cos(angle))})`,
    top: `calc(50% + var(--seat-anchor-y, ${String(RY)}%) * ${String(Math.sin(angle))})`,
  }
}

function chipStyle(index: number): Record<string, string> {
  const { x, y } = offsetFor(index)
  return { left: `${String(x)}%`, top: `${String(y)}%` }
}

/** 桌面中央的一句话状态，用 aria-live 播报给屏幕阅读器。 */
const tableStatus = computed(() => {
  const street = props.street ? STREET_NAMES[props.street] : '等待发牌'
  return `${street}，底池 ${String(props.potTotal)} 筹码`
})
</script>

<template>
  <div class="table-wrap">
    <div class="table">
      <span class="felt-texture" aria-hidden="true" />
      <span class="betting-line" aria-hidden="true" />

      <div class="center">
        <p class="pot">
          <span class="pot-label">底池</span>
          <b class="num">{{ potTotal }}</b>
        </p>
        <p v-if="pots.length > 1" class="pots">
          <span v-for="(pot, index) in pots" :key="index" class="num">
            {{ index === 0 ? '主池' : `边池${String(index)}` }} {{ pot.amount }}
          </span>
        </p>
        <CommunityCards :cards="board" :street="street" :highlight="highlightCards" />
      </div>

      <!-- 座位：按 maxSeats 分布，2–9 人都能正常排布。 -->
      <template v-for="(seat, index) in seats" :key="index">
        <div v-if="seat" class="seat-slot" :class="{ 'is-hero-slot': index === heroSeat }" :style="seatStyle(index)">
          <PlayerSeat
            :seat="seat"
            :is-hero="seat.playerId === heroPlayerId"
            :hole-cards="seat.playerId === heroPlayerId ? heroCards : []"
            :is-acting="seat.playerId === actingPlayerId"
            :is-winner="winnerPlayerIds.includes(seat.playerId)"
            :remaining-ratio="seat.playerId === actingPlayerId ? remainingRatio : 1"
            :remaining-seconds="seat.playerId === actingPlayerId ? remainingSeconds : 0"
            :turn-seconds="turnSeconds"
          />
        </div>

        <!-- 本轮下注：朝桌心方向显示筹码与数额。 -->
        <div v-if="seat && seat.committedStreet > 0" class="bet" :style="chipStyle(index)">
          <span class="chip" aria-hidden="true" />
          <span class="num">{{ seat.committedStreet }}</span>
        </div>
      </template>

      <!-- 庄家按钮。 -->
      <div v-if="buttonSeat !== null && buttonSeat !== undefined" class="dealer" :style="dealerStyle(buttonSeat)">
        <span aria-hidden="true">D</span>
        <span class="sr-only">庄家位</span>
      </div>
    </div>

    <!-- 系统提示（超时弃牌、断线等）不遮挡牌面。 -->
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p class="sr-only" aria-live="polite">{{ tableStatus }}</p>
  </div>
</template>

<style scoped>
.table-wrap {
  position: relative;
  display: grid;
  justify-items: center;
  gap: var(--space-1);
  width: 100%;
}

.table {
  position: relative;
  width: var(--table-w);
  height: var(--table-h);
  margin-inline: auto;
  border-radius: 50% / 50%;
  background: radial-gradient(ellipse at 50% 34%, #1b5a4c 0%, var(--felt) 46%, var(--felt-deep) 100%);
  /* 内圈亮边 + 外侧深色台边，不用厚阴影制造浮起感。 */
  box-shadow:
    inset 0 0 0 1px rgba(242, 241, 234, 0.08),
    inset 0 0 46px rgba(0, 0, 0, 0.34),
    0 0 0 9px #16232c,
    0 0 0 10px var(--line);
}

.felt-texture {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28'%3E%3Cg fill='none' stroke='%23ffffff' stroke-opacity='.035'%3E%3Cpath d='M0 14h28M14 0v28'/%3E%3C/g%3E%3C/svg%3E");
  pointer-events: none;
}

/* 下注线：把公共牌区与座位区分开的结构线，不是装饰。 */
.betting-line {
  position: absolute;
  inset: 16% 13%;
  border-radius: 50% / 50%;
  border: 1px solid rgba(212, 177, 106, 0.2);
  pointer-events: none;
}

.center {
  position: absolute;
  left: 50%;
  top: 42%;
  display: grid;
  justify-items: center;
  gap: 6px;
  width: max-content;
  transform: translate(-50%, -50%);
}

.pot {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  padding: 3px 12px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--gold-dim);
}

.pot-label {
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.pot b {
  font-size: 1.02rem;
  color: var(--gold);
}

.pots {
  display: flex;
  gap: 10px;
  margin: 0;
  font-size: 0.68rem;
  color: var(--muted);
}

.seat-slot {
  position: absolute;
  z-index: 2;
  transform: translate(-50%, -50%);
}

/* 本人座位压在桌沿下沿，视觉上最靠近底部操作区。 */
.is-hero-slot {
  z-index: 3;
}

.bet {
  position: absolute;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px 1px 3px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.42);
  border: 1px solid var(--line);
  font-size: 0.72rem;
  color: var(--text);
  transform: translate(-50%, -50%);
}

.chip {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--gold);
  box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.35);
}

.dealer {
  position: absolute;
  z-index: 5;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--gold);
  color: var(--bg);
  font-size: 0.68rem;
  font-weight: 700;
}

.notice {
  margin: 0;
  padding: 3px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.78rem;
}

@media (max-width: 1100px) {
  .table {
    --table-h: min(44vh, 380px);
  }
}

@media (max-width: 560px) {
  .table {
    /* 竖屏窄屏：桌面不抢高度，优先保证操作区完整可见。 */
    --table-h: min(33vh, 252px);
    --seat-anchor-y: 45%;
    /* 椭圆横向半径收窄，座位面板不越出屏幕（无横向滚动）。 */
    --seat-anchor-x: 43%;
  }
}

/* 横屏手机：压低桌面高度，给底部操作区留出空间。 */
@media (max-height: 430px) {
  .table {
    --table-h: min(35vh, 118px);
    /* 座位锚点向内收：顶部座位不越出桌面，底部座位不压住公共牌。 */
    --seat-anchor-y: 46%;
  }

  /* 公共牌整体上移，与本人座位面板拉开距离。 */
  .center {
    top: 36%;
  }

  .pot b {
    font-size: 0.92rem;
  }
}
</style>
