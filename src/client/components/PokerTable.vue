<script setup lang="ts">
import { computed } from 'vue'
import type { Card } from '../../shared/poker.ts'
import { STREET_NAMES } from '../../shared/poker.ts'
import type { SeatPublic } from '../../shared/protocol.ts'
import CommunityCards from './CommunityCards.vue'
import PlayerSeat from './PlayerSeat.vue'

const emit = defineEmits<{ pickSeat: [seat: number] }>()

const props = withDefaults(
  defineProps<{
    /** 座位数组，下标即座位号，空位为 null。 */
    seats: readonly (SeatPublic | null)[]
    maxSeats: number
    board?: readonly Card[]
    potTotal?: number
    pots?: readonly { amount: number; eligiblePlayerIds: readonly string[] }[]
    currentBet?: number
    /** 本人座位号；用于把本人固定放在桌面下沿中央。 */
    heroSeat?: number | null
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
    /** 本人是否可以挑座位（旁观中、或离座保留座位时）：空位会渲染成可点按钮。 */
    canPickSeat?: boolean
    /** 本人保留的座位号（离座后仍属于本人）：点它表示坐回。 */
    reservedSeat?: number | null
  }>(),
  {
    board: () => [],
    potTotal: 0,
    pots: () => [],
    currentBet: 0,
    heroSeat: null,
    heroPlayerId: null,
    actingPlayerId: null,
    remainingRatio: 1,
    remainingSeconds: 0,
    turnSeconds: 20,
    winnerPlayerIds: () => [],
    highlightCards: () => [],
    street: null,
    canPickSeat: false,
    reservedSeat: null,
  },
)

/** 座位锚点：椭圆 + 本人固定在下沿中央。百分比定位，随容器等比缩放。 */
const RX = 47
const RY = 41

/** 座位相对桌心的极角：偏移半桌，使本人落在 90°（椭圆下沿中央）。 */
function polarFor(index: number): { angle: number } {
  const total = Math.max(props.maxSeats, 2)
  const hero = props.heroSeat ?? -1
  // 本人固定在下沿中央（angle = +90°）：以本人座位为起点排序，其余人顺时针铺开。
  // 早先写成 hero + total / 2，实际把本人放到了上沿中央（与注释不符，也让本人的下注筹码
  // 落在自己的座位面板上）；现在按注释修正。
  const offset = hero >= 0 ? hero : 0
  return { angle: ((index - offset) / total) * Math.PI * 2 + Math.PI / 2 }
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
  const { angle } = polarFor(index)
  /*
   * 下注筹码朝桌心收：横向 30%、纵向 39%。
   * 纵向比横向收得多，是因为上下两排座位面板（本人 36+47=83px 高）与中央块之间只剩
   * 这条空隙——单挑时本人的筹码正好落在自己面板下沿下面一点点（实测 25% 半径：
   * 上面板 2px、下面中央块 2px），多收一点就会压住自己的筹码数字。
   * 小屏（矮屏横屏 / 竖屏）不画浮动筹码，改由座位面板角标显示（见 PlayerSeat 的 .panel-bet）。
   */
  return {
    left: `${String(50 + RX * 0.7 * Math.cos(angle))}%`,
    top: `${String(50 + RY * 0.61 * Math.sin(angle))}%`,
  }
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

/**
 * 正对本人（环的最上沿）的那个座位：它的状态行/进度条落在面板「朝向桌心」的一侧，
 * 正好是下注筹码与底池所在的位置（实测全下时筹码压住「全下」文字 9×22px）。
 * 这一个座位的状态行不画：全下/断线/弃牌状态由面板里的 ALL IN 标记、断线图标、
 * 面板淡化给出，下注额由筹码给出，完整状态仍在 aria-label 里。
 */
function isCenterTop(index: number): boolean {
  return Math.sin(polarFor(index).angle) <= -0.9
}

/**
 * 9 人满桌：环上相邻座位只有 40° 间距（纵向 sin 差最小 0.592），
 * 完整面板（底牌背面 36 + 面板 47 + 状态行 14）在 RY=41% 的椭圆上必然互相压住。
 * 这一档不再画座位里的小底牌背面（见 .is-full-ring 样式）。
 */
const isFullRing = computed(() => props.maxSeats >= 9)

/**
 * 某个座位是不是「本人离座后保留的座位」。
 * 第 4 项需求：别人看到的是「已离座」卡片，本人看到的是可点的「坐回」空位。
 */
function isReservedSeat(index: number): boolean {
  return props.reservedSeat === index
}

/** 桌面中央的一句话状态，用 aria-live 播报给屏幕阅读器。 */
const tableStatus = computed(() => {
  const street = props.street ? STREET_NAMES[props.street] : '等待发牌'
  return `${street}，底池 ${String(props.potTotal)} 筹码`
})
</script>

<template>
  <div class="table-wrap">
    <div class="table" :class="{ 'is-full-ring': isFullRing }">
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
          v-if="seat && !seat.away"
          class="seat-slot"
          :class="{
            'is-hero-slot': index === heroSeat,
            'is-side-seat': isSideSeat(index),
            'is-center-top': isCenterTop(index),
          }"
          :style="seatStyle(index)"
        >
          <PlayerSeat
            :seat="seat"
            :is-hero="seat.playerId === heroPlayerId"
            :is-acting="seat.playerId === actingPlayerId"
            :is-winner="winnerPlayerIds.includes(seat.playerId)"
            :remaining-ratio="seat.playerId === actingPlayerId ? remainingRatio : 1"
            :remaining-seconds="seat.playerId === actingPlayerId ? remainingSeconds : 0"
            :turn-seconds="turnSeconds"
          />
        </div>

        <!--
          本人离座保留的座位（第 4 项需求）：显示成一个可点的「坐回」空位。
          它同时满足「有人的座位」与「本人可点的入口」，所以排在离座卡片之前单独处理；
          点它就坐回来，筹码跟人走、不用再买入（也可以改点别的空位，见下面那一支）。
        -->
        <div
          v-else-if="seat && seat.away && isReservedSeat(index) && canPickSeat"
          class="seat-slot"
          :class="{ 'is-side-seat': isSideSeat(index), 'is-center-top': isCenterTop(index) }"
          :style="seatStyle(index)"
        >
          <button
            type="button"
            class="seat-empty is-reserved"
            :aria-label="`坐回 ${String(index + 1)} 号座位（座位为你保留，筹码原样带回）`"
            title="这个座位为你保留，点击直接坐回；也可以点别的空位"
            @click="emit('pickSeat', index)"
          >
            <span class="num seat-empty-no">{{ index + 1 }}</span>
            <span class="seat-empty-label">坐回</span>
          </button>
        </div>

        <!-- 别人离座保留的座位：卡片直接写「已离座」，一眼看出这个位子暂时不能坐。 -->
        <div
          v-else-if="seat && seat.away"
          class="seat-slot"
          :class="{ 'is-side-seat': isSideSeat(index) }"
          :style="seatStyle(index)"
        >
          <p
            class="away-pill"
            :aria-label="`${String(index + 1)} 号座位，${seat.nickname} 已离座（座位保留，本人可坐回）`"
          >
            <span class="num away-no">{{ index + 1 }}</span>
            <span class="away-text">已离座</span>
          </p>
        </div>

        <!--
          空位：旁观者 / 离座者可以点它落座（买入确认在牌桌页面弹窗里做）。
          第 2 项需求：座位号与「入座」并排一行——原来是「+ / 号码 / 入座」三行，卡片偏高。
        -->
        <div
          v-else-if="canPickSeat"
          class="seat-slot"
          :class="{ 'is-side-seat': isSideSeat(index) }"
          :style="seatStyle(index)"
        >
          <button
            type="button"
            class="seat-empty"
            :aria-label="`坐到 ${String(index + 1)} 号座位`"
            title="点击选择这个座位并买入"
            @click="emit('pickSeat', index)"
          >
            <span class="num seat-empty-no">{{ index + 1 }}</span>
            <span class="seat-empty-label">入座</span>
          </button>
        </div>

        <!-- 本轮下注：朝桌心方向显示筹码与数额。data-seat 供几何探针区分「自己的筹码」与「别人的」。 -->
        <div
          v-if="seat && seat.committedStreet > 0"
          class="bet"
          :style="chipStyle(index)"
          :data-seat="index + 1"
        >
          <span class="chip" aria-hidden="true" />
          <span class="num">{{ seat.committedStreet }}</span>
        </div>
      </template>

    </div>

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

/*
 * 空位：可点的座位槽。描边虚线 + 「座位号 入座」，键盘可达（是真正的 button）。
 * 第 2 项需求：座位号与「入座」并排一行（原来是「+ / 号码 / 入座」三行），
 * 卡片整体也收小一圈——空位只是入口，不需要占一张玩家卡的体量。
 */
.seat-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: var(--seat-w, 144px);
  /* 5px 内边距 + 0.82rem 字号 ≈ 32px：一小再小也守住 e2e 里 32px 的触控下限。 */
  padding: 5px 8px;
  border: 1px dashed rgba(212, 177, 106, 0.45);
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.24);
  color: var(--muted);
  font: inherit;
  font-size: 0.76rem;
  line-height: 1.5;
  cursor: pointer;
  transition: border-color 0.15s ease-out, color 0.15s ease-out, background 0.15s ease-out;
}

/* 座位号：比自己那一枚「座位徽标」稍大一点，因为这里是唯一的操作对象。 */
.seat-empty-no {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--gold);
}

/*
 * 别人离座保留的座位：一行小胶囊「N 已离座」。
 * 比完整玩家卡矮一半以上，同时明确「这个位子有人、只是暂时不在」。
 */
.away-pill {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: var(--seat-w, 144px);
  margin: 0;
  padding: 3px 8px;
  border: 1px dashed var(--gold-soft);
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.2);
  color: var(--muted);
  font-size: 0.74rem;
  line-height: 1.5;
}

.away-no {
  color: var(--gold);
  font-weight: 700;
}

.away-text {
  white-space: nowrap;
}

.seat-empty:hover,
.seat-empty:focus-visible {
  border-color: var(--gold);
  color: var(--text);
  background: rgba(0, 0, 0, 0.34);
}

/* 本人保留的座位：金色实线，一眼看出「这是我的位置」。 */
.seat-empty.is-reserved {
  border-style: solid;
  border-color: var(--gold-soft);
  color: var(--gold);
}

.seat-empty-label {
  font-size: 0.68rem;
}



@media (max-width: 560px) and (orientation: portrait) {
  .seat-empty {
    padding: 4px 6px;
    font-size: 0.78rem;
  }
}

/* 本人座位压在桌沿下沿，视觉上最靠近底部操作区。 */
.is-hero-slot {
  z-index: 3;
}

/* 正对本人那个座位的状态行/进度条会让位给下注筹码与底池（见 isCenterTop 注释）。 */
.seat-slot.is-center-top :deep(.status),
.seat-slot.is-center-top :deep(.timer) {
  display: none;
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

/*
 * 9 人满桌：座位面板不画底牌背面。
 *
 * 环上相邻座位只有 40° 间距，纵向最小 sin 差 0.592：在 390×844 竖屏（桌面 226px、RY 48%）
 * 相邻座位中心只差约 64px，而「底牌 36 + 面板 41 + 状态 14」仍然装不下——实测把底牌背面
 * 显示回来后「座位2 压住中央区 10×44px」。第 4 项需求已经靠「座位号并进面板左侧」把面板
 * 从两行收到一行（矮 ~13px），但省下的高度是先还给公共牌区的净空，不拿去换底牌背面。
 * 信息不丢：还在牌局里的信息由「面板淡化 + 已弃牌/全下/已断线文本 + 桌面下注筹码」给出，
 * 本人底牌在底部操作区有大图；2–8 人桌照常显示底牌背面，矮屏与竖屏本来就不画。
 */
.table.is-full-ring .seat-slot :deep(.cards) {
  display: none;
}

.chip {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--gold);
  box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.35);
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
     * 竖屏桌面高度 = **flex 布局算出来的剩余空间**，不再猜数值。
     *
     * 竖屏固定占用是「顶栏 53 + 提示条 22 + 通知槽 26 + 舞台内边距 8 + 底部区」，
     * 底部区随状态变化（等待时 ~180px，「轮到自己 + 额度台」时 ~296px）。
     * 早先按 dvh 推公式（`min(0.275×dvh, dvh - 536px)`）仍会溢出 9px——dvh 与 innerHeight
     * 在某些环境下并不相等。现在改成：`.stage`（flex: 1）拿到剩余高度，`.table` 用
     * `height: 100%` 精确填满它。390×844 得到 232px、360×740 得到 204px，
     * 任何牌局状态下都不会把页面顶出纵向滚动（e2e 有「竖屏一屏放下」的守卫断言）。
     * max-height 给桌面档（≥561px 宽，走固定 --table-h）之外的情况兜底。
     */
    /*
     * 用公式定高，**不要**用 `height: 100% / auto`：
     *   竖屏下 `.table` 的子元素全是绝对定位，`height: auto` 会让桌面高度直接归零
     *   （实测踩到：桌面 0px、公共牌跑到桌面外）；`height: 100%` 又会被基础规则里的
     *   `height: var(--table-h)` 覆盖。
     * 公式本身：0.275×dvh 是「桌面该占多少」，dvh-536px 是「除桌面外还剩多少」，
     * 取小的那个。548 = 顶栏 53 + 提示 22 + 通知槽 26 + 舞台内边距 8 + 最高一档底部区 422 + 余量 17。
     * 390×844 → 232px，360×740 → 204px。下限 190px 兜底更小的机器（那些本来就会滚动）。
     */
    --table-h: clamp(190px, min(calc(100dvh * 0.275), calc(100dvh - 548px)), 320px);
    /*
     * 纵向半径 44% → 48%：桌面高度按 dvh 重标定后（390×844 时 226px、360×740 时 198px），
     * 9 人桌顶部那一排（±50° 位，面板高约 47px）会与中央块/公共牌重叠。
     * 这个半径是「离桌心多远」：调大 = 座位更贴边、面板离中央块更远（调小反而更糟）。
     * `npm run probe:table` 实测：44% 时 360×740 压 5.2×46.3px、40% 时压 11.3×46.3px，
     * 48% 时两个规格档（390×844 / 360×740）都全绿；再往上只多 1px 余量，意义不大。
     * 竖屏座位面板本来就会溢出桌面椭圆（桌面只有 198px 高），这与「公共牌必须落在桌面内」不冲突。
     */
    --seat-anchor-y: 48%;
  }

  /* 中央块（底池/边池 + 轮次 + 公共牌）竖排居中：宽度只由公共牌决定，左右两侧留给贴边座位。 */
  .center {
    top: 50%;
  }

  /* 贴边座位：只留「角色 + 昵称 + 筹码」，头像圆已整体删除（见 PlayerSeat）。 */
  .seat-slot {
    /* 非贴边座位 96px：9 人桌上相邻面板（本人↔两侧 ±50° 位、下沿的两个 sin 0.94 位）
       才不会互相压住；再宽一点就要靠截断昵称来换，没必要。 */
    --seat-w: 88px;
  }

  .seat-slot.is-side-seat {
    --seat-w: 64px;
  }

  /* 贴边座位只有 64px：面板内边距从 8px 收到 5px，把 6px 让给「昵称 + 筹码」。
     不这么做的话，同时挂着 BB 胶囊的座位会把筹码「2640」省略成「264…」（实测 24/30px）。 */
  .seat-slot.is-side-seat :deep(.panel) {
    padding-inline: 5px;
  }

  /*
   * 竖屏面板高度也是稀缺资源：桌面按 dvh 缩到 198px（360×740）后，9 人桌相邻座位的
   * 纵向中心距只有约 40px，而面板本身约 41px —— 必然会互相压住。
   * 内边距 6 → 4px（面板 41 → 37px），并在 740 及以下再收一档到 3px（→ 35px），
   * `npm run probe:table` 实测：360×740 上 4px 还剩 1.2×2px、3px 完全干净。
   */
  .seat-slot :deep(.panel) {
    padding-block: 4px;
  }

  /* 更矮的竖屏手机（如 740 高）：面板再收 1px/边，换掉最后那点互压。 */
  @media (max-height: 780px) {
    .seat-slot :deep(.panel) {
      padding-block: 3px;
    }
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

  /*
   * 下注筹码：竖屏座位面板很窄，默认 70% 半径的落点必然压住东西——
   * 压自己的筹码数字（实测 15×16px）、压公共牌最外侧那张牌，二者之间没有净空
   * （公共牌宽度与贴边座位面板内沿在竖屏基本贴合）。
   * 因此竖屏不画浮动筹码，改由座位面板右下角的角标显示本轮下注（见 PlayerSeat 的 .panel-bet）。
   */
  .bet {
    display: none;
  }
}

/* 横屏手机：压低桌面高度，给底部操作区留出空间。 */
</style>
