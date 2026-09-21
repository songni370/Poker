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
  // x 方向额外用 clamp 按「座位面板自身宽度的一半」收边：锚点是百分比而面板是固定宽度，
  // 窄屏时最左/最右的座位必然顶出桌子，造成横向溢出。
  // 注意括号：上限必须是 100% - (半宽 + 4px)，漏掉括号会退化成 100% - 半宽 + 4px（多出 4px）。
  const edge = 'var(--seat-w, 144px) / 2 + 4px'
  return {
    left: `clamp(calc(${edge}), calc(50% + var(--seat-anchor-x, ${String(RX)}%) * ${String(Math.cos(angle))}), calc(100% - (${edge})))`,
    top: `calc(50% + var(--seat-anchor-y, ${String(RY)}%) * ${String(Math.sin(angle))})`,
  }
}

function chipStyle(index: number): Record<string, string> {
  const { x, y } = offsetFor(index)
  return { left: `${String(x)}%`, top: `${String(y)}%` }
}

/** 已入座人数：用于空桌引导与状态播报。 */
const seatedCount = computed(() => props.seats.filter(Boolean).length)

/** 边池明细的中文读法（屏幕阅读器用；视觉上由 .pots 行展示）。 */
const potBreakdownText = computed(() =>
  props.pots
    .map((pot, index) => `${index === 0 ? '主池' : `边池${String(index)}`} ${String(pot.amount)}`)
    .join('，'),
)

/**
 * 横向贴边的座位（|cos| 接近 1，如 9 人桌的 ±10°/±30° 位）。
 * 竖屏窄屏上它们正好落在公共牌所在的水平带上，需要单独收窄面板（见 .is-side-seat 样式）。
 */
function isSideSeat(index: number): boolean {
  return Math.abs(Math.cos(polarFor(index).angle)) >= 0.85
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
        <!-- 空桌：给一句可执行的引导，而不是空荡荡的桌面。 -->
        <p v-if="seatedCount === 0" class="empty-state">
          还没有人入座，把房间链接发给朋友即可开局。
        </p>

        <div class="center-pot">
          <p class="pot">
            <span class="pot-label">底池</span>
            <b class="num">{{ potTotal }}</b>
            <!-- 边池明细：视觉上由旁边的 .pots 给出（窄屏会隐藏它），
                 无障碍读法始终挂在底池这一处，避免读两遍。 -->
            <span v-if="pots.length > 1" class="sr-only">（{{ potBreakdownText }}）</span>
          </p>
          <p v-if="pots.length > 1" class="pots" aria-hidden="true">
            <span v-for="(pot, index) in pots" :key="index" class="num">
              {{ index === 0 ? '主池' : `边池${String(index)}` }} {{ pot.amount }}
            </span>
          </p>
        </div>
        <CommunityCards :cards="board" :street="street" :highlight="highlightCards" />
      </div>

      <!-- 座位：按 maxSeats 分布，2–9 人都能正常排布。 -->
      <template v-for="(seat, index) in seats" :key="index">
        <div
          v-if="seat"
          class="seat-slot"
          :class="{ 'is-hero-slot': index === heroSeat, 'is-side-seat': isSideSeat(index) }"
          :style="seatStyle(index)"
        >
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

/*
 * 中央信息区：两行（底池+边池 / 公共牌），整体居中。
 *   - 竖排而不是 grid 堆叠：`.center` 的宽度必须是「两行里较宽的那一行」，
 *     否则块会比内容宽（曾用 `.board { flex-basis: 100% }` 强行独占一行，
 *     结果容器的 max-content 把两行宽度相加，块变宽 87px 还会压到侧边座位面板）。
 *   - 边池与底池同一行：边池另起一行会让中心块高 20px，桌面高度不变时就会顶到
 *     上沿的座位面板（实测 1280×720 出现底池压住本人座位面板）。
 */
.center {
  position: absolute;
  left: 50%;
  /* 45%（而非正中）：本人座位固定在环的下沿中央，其面板比别的座位高一截
     （昵称 + 筹码 + 底牌 + 行动提示），中心块略微下移才不会顶到它。 */
  top: 45%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: max-content;
  transform: translate(-50%, -50%);
}

/* 底池与边池同行。 */
.center-pot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
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

.empty-state {
  margin: 0;
  padding: 4px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--gold-dim);
  background: rgba(0, 0, 0, 0.3);
  color: var(--text);
  font-size: 0.82rem;
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
    /* 座位面板同时收窄，9 人桌在竖屏下才不会互相压住。 */
    --seat-w: 108px;
  }
}

/*
 * 竖屏（≤560px 宽）：桌面高度跟着视口走（390×844 时 310px），公共牌缩到 34px 上下，
 * 贴边座位单独收窄——三件事一起做，公共牌区才真正空出来。
 * 竖屏是 9 人桌最紧张的一档：`|sin|` 最小的两个座位（9 人桌的 ±10° 位）与公共牌同高，
 * 只能在宽度上让路（108px → 64px）；收窄后中央 222px 全部留给公共牌。
 * 实测 390×844：6 人桌与 9 人桌的公共牌与任何座位面板都零重叠。
 */
@media (max-width: 560px) and (orientation: portrait) {
  .table {
    /*
     * 桌面高度跟着视口走：竖屏下顶栏 + 横屏引导 + 底部操作区要占掉 500px 上下
     * （动作区有下注滑块时最高），桌面吃掉剩下的高度，否则矮一点的手机（360×740）
     * 会被底部操作区顶出屏幕、整页纵向滚动。
     * 系数 1.1 是让 390×844（规格书要求的最小竖屏）刚好拿到上限 310px，
     * 更矮的机器按比例缩小桌面，不再撑破页面。dvh 而不是 vh：地址栏伸缩时 vh 会算错。
     */
    --table-h: clamp(196px, calc(100dvh * 1.1 - 618px), 310px);
    --seat-anchor-y: 44%;
  }

  /* 中央块（底池/边池 + 轮次 + 公共牌）竖排居中：宽度只由公共牌决定，左右两侧留给贴边座位。 */
  .center {
    top: 50%;
  }

  /* 贴边座位：只留「昵称 + 筹码」，头像与光环让位给公共牌。 */
  .seat-slot.is-side-seat {
    --seat-w: 64px;
  }

  .seat-slot.is-side-seat :deep(.avatar),
  .seat-slot.is-side-seat :deep(.seat-aura) {
    display: none;
  }

  /* 公共牌宽度跟着视口走：两侧贴边座位各占 64px + 4px 边距后剩下的横向空间，
     五张牌加牌距必须全部装下（390px 宽时 34px，360px 宽时 30px，320px 宽时 24px）。 */
  .center :deep(.board) {
    --board-cw: clamp(24px, calc((100vw - 210px) / 5), 34px);
  }

  .center :deep(.board .card--md) {
    --cw: var(--board-cw);
  }

  .center :deep(.board .slot--empty) {
    width: var(--board-cw);
    height: calc(var(--board-cw) * 1.4);
  }

  /* 牌距同步收紧：五张牌加上牌距必须留出余量。 */
  .center :deep(.board .row) {
    gap: 4px;
  }

  .center :deep(.board .gap) {
    width: 8px;
  }

  /* 边池明细行同横屏矮屏：会让中央块宽过两侧座位之间的净宽，明细交给 sr-only 与结算叠层。 */
  .pots {
    display: none;
  }
}

/* 横屏手机：压低桌面高度，给底部操作区留出空间。 */
@media (max-height: 430px) {
  /*
   * 矮屏下座位面板与底池/公共牌在同一条垂直线上。`.center` 因为 transform 自成一个层叠上下文，
   * 光给 `.pot` 加 z-index 是逃不出去的，必须把整个中心区抬到座位之上：
   * 座位 z-index 2/3、下注筹码 4，这里给 5，保证「底池与公共牌」永远可读。
   */
  .center {
    z-index: 5;
  }

  .pot {
    background: color-mix(in srgb, var(--felt-deep) 88%, black);
    padding: 1px 10px;
  }

  .table {
    --table-h: min(35vh, 118px);
    /* 座位锚点外移：面板已收窄（见 PlayerSeat 矮屏规则），外移后正好贴住桌沿。
       60% 时上下两排座位与中央块只剩 3px 净空，64% 能拉到 7–12px
       （本人座位面板略高于顶栏中线，但顶栏中段是空的，不会挡住任何顶栏文字）。 */
    --seat-anchor-y: 64%;
    /* 横屏手机同样收窄座位面板，给公共牌与操作区留出宽度。 */
    --seat-w: 116px;
  }

  /*
   * 极矮横屏（740×360 只有 ~118px 桌面高度）的紧凑环形布局：
   * 中央信息压成「[底池/边池] 一行 + [轮次][公共牌] 一行」。
   * 纵向每省一行都是公共牌与座位面板之间的净空：中心块从 114px 降到 83px，
   * 座位面板收在上下两侧，公共牌区与底池都不再被压住。
   * 轮次标签原本在公共牌上方独占一行，这里让 `.board` 横排（标签在左、牌在右）。
   *
   * 边池明细行（.pots）在这一档隐藏：它会把底池那一行撑到 ~277px，再加上公共牌就比
   * 两侧座位之间的净宽还宽（实测 740×360 会压住座位面板整 17px）。底池总额仍在底池胶囊里，
   * 明细由屏幕阅读器读同一处的 sr-only 文本，结算叠层与手牌历史里也照常列出。
   */
  .center {
    top: 50%;
    gap: 2px;
  }

  .center > :deep(.board) {
    grid-auto-flow: column;
    align-items: center;
    column-gap: 6px;
    row-gap: 0;
  }

  /* 公共牌小一档：中心块宽度直接决定它与两侧座位面板之间的净宽。
     42px 时净宽只剩 1px（字体或文案一变就会压上），38px 能留出 6px。 */
  .center :deep(.board .card--md) {
    --cw: 38px;
  }

  .center :deep(.board .slot--empty) {
    width: 38px;
    height: 53px;
  }

  .pots {
    display: none;
  }

  .pot b {
    font-size: 0.92rem;
  }
}
</style>
