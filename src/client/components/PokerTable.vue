<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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
    /** 本手每个赢家赢得的筹码（playerId → 金额）。 */
    winAmounts?: Readonly<Record<string, number>>
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
    winAmounts: () => ({}),
    highlightCards: () => [],
    street: null,
    canPickSeat: false,
    reservedSeat: null,
  },
)

/**
 * 紧凑牌桌：超短屏（宽度 ≤360 且高度 ≤620）时桌面只有 ~160px 高，
 * 环状 9 人座必然压住公共牌，因此改用「左右两列 + 本人桌底」的规整布局。
 */
const compact = ref(false)

/** 竖屏（≤560px 宽）：下注筹码的落点半径要收，否则会压住公共牌。 */
const portrait = ref(false)
let portraitQuery: MediaQueryList | null = null
function syncPortrait(e?: MediaQueryListEvent | MediaQueryList): void {
  portrait.value = e ? e.matches : (portraitQuery?.matches ?? false)
}
let compactQuery: MediaQueryList | null = null
function syncCompact(e?: MediaQueryListEvent | MediaQueryList): void {
  compact.value = e ? e.matches : (compactQuery?.matches ?? false)
}
onMounted(() => {
  compactQuery = window.matchMedia('(max-width: 360px) and (max-height: 620px)')
  syncCompact()
  portraitQuery = window.matchMedia('(max-width: 560px) and (orientation: portrait)')
  syncPortrait()
  portraitQuery.addEventListener('change', syncPortrait)
  compactQuery.addEventListener('change', syncCompact)
})
onBeforeUnmount(() => {
  compactQuery?.removeEventListener('change', syncCompact)
  portraitQuery?.removeEventListener('change', syncPortrait)
})

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

/**
 * 紧凑牌桌（超短屏）下的座位定位：
 * 桌面只有 ~160px 高时 9 人环放不下，改成「整齐两列」——
 * 左右两列各 4 个对手座位，纵向按序号均分桌面高度，本人座位单独落在桌底中央。
 * 这样任何两排座位都不会与中央公共牌区在横向上相交（中央列左右各留出 150px）。
 */
function compactSeatStyle(index: number): Record<string, string> {
  const hero = props.heroSeat ?? -1
  if (index === hero) return { left: '50%', top: 'calc(100% - 2px)' }
  // 只排「确实有人」的座位，空位不占行，避免 2 人桌也按 9 人桌留出空行。
  const occupied = props.seats
    .map((seat, i) => i)
    .filter((i) => i !== hero && props.seats[i] && !props.seats[i]!.away)
  const order = Math.max(0, occupied.indexOf(index))
  const side = order % 2 === 0 ? 'left' : 'right'
  const row = Math.floor(order / 2)
  const rows = Math.max(1, Math.ceil(occupied.length / 2))
  // 纵向均分：上下各留 6%，中间等距
  const top = rows === 1 ? 50 : 6 + (row * 88) / (rows - 1)
  return {
    [side]: '2px',
    top: `${String(Math.round(top))}%`,
  }
}

function chipStyle(index: number): Record<string, string> {
  const { angle } = polarFor(index)
  /*
   * 下注筹码朝桌心收：桌面档横向 70%、纵向 61% 半径。
   * 纵向比横向收得多，是因为上下两排座位面板与中央块之间只剩这条窄缝。
   * 竖屏更紧（66% / 52%）：座位面板离桌心更近，不收一点就会压住自己的筹码数字或公共牌。
   */
  /*
   * 位置用绝对百分比（相对桌面），半径系数由 JS 传入：
   * CSS 的 calc() 里 `N% * var(--x)` 的 N% 是相对**元素自身**宽度，不是桌面宽，
   * 会算到桌子外面去（曾导致筹码飞到座位上方）。
   */
  /*
   * 竖屏座位面板贴着桌沿，筹码要更靠座位（半径更大）才落在「座位与底池之间」的窄带里；
   * 桌面档空间充足，用 0.7 / 0.61 朝桌心更近一点。
   */
  const radius = portrait.value ? { x: 0.79, y: 0.70 } : { x: 0.7, y: 0.61 }
  return {
    left: `${String(50 + RX * radius.x * Math.cos(angle))}%`,
    top: `${String(50 + RY * radius.y * Math.sin(angle))}%`,
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
    <div class="table" :class="{ 'is-full-ring': isFullRing, 'is-compact': compact }">
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
          :style="compact ? compactSeatStyle(index) : seatStyle(index)"
        >
          <PlayerSeat
            :seat="seat"
            :is-hero="seat.playerId === heroPlayerId"
            :is-acting="seat.playerId === actingPlayerId"
            :is-winner="winnerPlayerIds.includes(seat.playerId)"
            :win-amount="winAmounts[seat.playerId] ?? 0"
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

/*
 * 几何变量的兜底默认值放在 `:where()` 里（零优先级）：
 * 档位表 table-geometry.css 里 `.table` 的媒体查询覆盖不会被组件内更高优先级的
 * 类选择器盖掉；变量缺失时也能退化成可用的桌面档。
 */
:where(.table) {
  --seat-w: clamp(86px, 11vw, 126px);
  --seat-w-side: clamp(74px, 9vw, 110px);
  --seat-padding-block: 4px;
  --center-inset: 0px;
  --board-cw: clamp(30px, 4vw, 44px);
  --center-top: 45%;
  --center-max-height-inset: 0px;
}

.table {
  position: relative;
  width: var(--table-width, var(--table-w));
  height: var(--table-height, var(--table-h));
  max-height: var(--table-max-height, none);
  margin-inline: auto;
  border-radius: 50% / 50%;
  /* 拟物牌桌：真皮包边（--leather-bg）+ 内侧黄铜压条，呢绒由 .felt-texture 叠上来 */
  background: var(--leather-bg);
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.18),
    inset 0 -3px 8px rgba(0, 0, 0, 0.75),
    inset 0 0 0 1px rgba(232, 204, 150, 0.22),
    0 2px 0 rgba(0, 0, 0, 0.9),
    0 4px 2px rgba(0, 0, 0, 0.65),
    0 26px 56px rgba(0, 0, 0, 0.8);
}

/* 缝线：贴着皮革内侧一圈虚线，拟物风最关键的工艺细节。 */
.table::before {
  content: '';
  position: absolute;
  inset: 7px;
  border-radius: 50% / 50%;
  border: 1.6px dashed var(--stitch, rgba(232, 204, 150, 0.32));
  pointer-events: none;
  z-index: 1;
}

.felt-texture {
  position: absolute;
  inset: 16px;
  border-radius: 50% / 50%;
  overflow: hidden;
  /* 呢绒：光池 + 织物交叉纹理 + 深绿径向，边缘内阴影做出「凹陷下去」的体感 */
  background: var(--felt-skeuo);
  box-shadow:
    inset 0 0 0 2px rgba(0, 0, 0, 0.55),
    inset 0 0 0 3px rgba(255, 255, 255, 0.06),
    inset 0 10px 26px rgba(0, 0, 0, 0.55),
    inset 0 -14px 34px rgba(0, 0, 0, 0.6);
  pointer-events: none;
  z-index: 0;
}

/* 中央暗刻徽标：比呢绒更暗的一行字 + 1px 亮边，像压进布面。 */
.felt-texture::after {
  content: 'FSPOKE';
  position: absolute;
  left: 50%;
  top: 58%;
  transform: translate(-50%, -50%);
  font-size: clamp(22px, 6vw, 38px);
  font-weight: 800;
  letter-spacing: 0.34em;
  color: rgba(0, 0, 0, 0.13);
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.06);
  pointer-events: none;
  user-select: none;
}

/* 下注线：呢绒上的细圈，压暗而不是发光。 */
.betting-line {
  position: absolute;
  inset: 16% 12%;
  border-radius: 50% / 50%;
  border: 1px solid rgba(255, 255, 255, 0.06);
  pointer-events: none;
}

/*
 * 中央信息区：底池铭牌 + 街名 + 公共牌，整体居中的一列。
 */
.center {
  position: absolute;
  left: 50%;
  top: 45%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: max-content;
  transform: translate(-50%, -50%);
  z-index: 4;
}

/* 底池与边池同行 */
.center-pot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

/* 黄铜嵌框底池铭牌：内凹深棕底 + 1.5px 铜框 + 外投影。 */
.pot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 5px 18px 6px;
  border-radius: 10px;
  background: linear-gradient(180deg, #241c13 0%, #130e09 100%);
  border: 1.5px solid var(--brass, #8a6a32);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    inset 0 -2px 6px rgba(0, 0, 0, 0.8),
    0 4px 10px rgba(0, 0, 0, 0.65),
    0 0 0 1px rgba(0, 0, 0, 0.8);
}

.pot-label {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  color: #b39a6c;
}

.pot b {
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 700;
  color: #ffdf9a;
  line-height: 1.05;
  text-shadow: 0 1px 0 #000, 0 0 16px rgba(255, 190, 90, 0.35);
  letter-spacing: 0.01em;
}

.pots .num {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #a08f74;
}

.empty-state {
  margin: 0;
  padding: 6px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(212, 177, 106, 0.25);
  background: rgba(14, 20, 27, 0.75);
  color: var(--text);
  font-size: 0.84rem;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
}

.pots {
  display: flex;
  gap: 8px;
  margin: 0;
  font-size: 0.7rem;
  color: var(--muted);
}

.pots .num {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(16, 22, 28, 0.7);
  border: 1px solid rgba(212, 177, 106, 0.2);
  color: var(--gold);
}

.seat-slot {
  position: absolute;
  /* 必须高于 .felt-texture（z-index:1）与 .table::before 缝线层：同层级时后出现的呢绒会压住座位。 */
  z-index: 5;
  transform: translate(-50%, -50%);
}

/*
 * 空位：可点的座位槽。微金细线 + 「座位号 入座」，键盘可达
 */
.seat-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: var(--seat-w);
  padding: clamp(2px, 0.4vw, 4px) clamp(4px, 0.6vw, 8px);
  border: 1px dashed rgba(212, 177, 106, 0.45);
  border-radius: clamp(4px, 0.5vw, 6px);
  background: rgba(14, 20, 27, 0.65);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: var(--muted);
  font: inherit;
  font-size: clamp(0.66rem, 0.78vw, 0.74rem);
  line-height: 1.35;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.25);
  box-sizing: border-box;
}

.seat-empty:hover {
  border-color: var(--gold);
  border-style: solid;
  color: #ffffff;
  background: rgba(212, 177, 106, 0.16);
  box-shadow: 0 0 16px rgba(212, 177, 106, 0.35);
  transform: scale(1.03);
}

.seat-empty.is-reserved {
  border: 1px solid var(--gold);
  background: rgba(212, 177, 106, 0.2);
  box-shadow: 0 0 14px rgba(212, 177, 106, 0.35);
}

/* 座位号 */
.seat-empty-no {
  font-size: clamp(0.72rem, 0.85vw, 0.82rem);
  font-weight: 700;
  color: var(--gold);
}

/*
 * 别人离座保留的座位：一行小胶囊「N 已离座」
 */
.away-pill {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: var(--seat-w);
  margin: 0;
  padding: clamp(2px, 0.4vw, 3px) clamp(4px, 0.6vw, 7px);
  border: 1px dashed rgba(212, 177, 106, 0.3);
  border-radius: clamp(4px, 0.5vw, 6px);
  background: rgba(14, 20, 27, 0.45);
  color: var(--muted);
  font-size: clamp(0.62rem, 0.74vw, 0.70rem);
  line-height: 1.35;
  box-sizing: border-box;
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

/* 赌场筹码：白边 + 黄铜环 + 中心色块 + 顶部高光 + 落地阴影。 */
.chip {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 50%, #b8262e 0 38%, #f3ead6 38% 62%, #c9a24b 62% 78%, #8a6a32 78% 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    inset 0 -1px 2px rgba(0, 0, 0, 0.55),
    0 1px 2px rgba(0, 0, 0, 0.7);
}

@media (max-width: 1100px) {
  .table {
    --table-h: min(44vh, 380px);
  }
}

/* 竖屏的尺寸/锚点/公共牌/中央净宽全部来自 table-geometry.ts 的档位表，
   .table 只保留材质与「撑满舞台」的结构规则。 */

/*
 * 竖屏（≤560px 宽）：桌面高度跟着视口走（390×844 时 310px），公共牌缩到 34px 上下，
 * 贴边座位单独收窄——三件事一起做，公共牌区才真正空出来。
 * 竖屏是 9 人桌最紧张的一档：`|sin|` 最小的两个座位（9 人桌的 ±10° 位）与公共牌同高，
 * 只能在宽度上让路；收窄后中央 222px 全部留给公共牌。
 * 实测 390×844：6 人桌与 9 人桌的公共牌与任何座位面板都零重叠。
 */
@media (max-width: 560px) and (orientation: portrait) {
  /* 空桌引导放进下方观战栏，避免中央长句压住环形座位。 */
  .empty-state {
    display: none;
  }

  /*
   * 竖屏桌面重构（2026-10）：
   * 旧方案把桌面压到 232px 给底部座舱让路，结果桌面又小又空。现在改成
   * 「舞台剩余高度全部给桌面」——`.table-wrap` 撑满 `.stage`，`.table` 用 100% 填满，
   * 底部操作区另行压缩（见 TableView / ActionBar 的竖屏规则）。
   * 顶部 50px / 底部 38px 的舞台内边距由 TableView 提供：上方给 HUD 浮动胶囊让位，
   * 下方给本人座位面板 + 英雄手牌区留呼吸空间。
   */
  .table-wrap {
    height: 100%;
  }

  .table {
    /* 更深的翡翠毡面 + 更细的黄铜围边：向「私室牌桌」靠拢。 */
    background:
      radial-gradient(ellipse 62% 52% at 50% 38%, #1b5a4b 0%, #12493d 38%, #0a332a 70%, #06201a 100%);
    box-shadow:
      inset 0 0 0 1px rgba(212, 177, 106, 0.28),
      inset 0 0 80px rgba(0, 0, 0, 0.55),
      inset 0 2px 24px rgba(255, 255, 255, 0.04),
      0 0 0 2px #14110d,
      0 0 0 4px rgba(212, 177, 106, 0.55),
      0 0 0 6px rgba(212, 177, 106, 0.12),
      0 0 0 14px #121820,
      0 0 0 16px #0a0f14,
      0 24px 60px rgba(0, 0, 0, 0.85);
  }

  /* 中央块（底池/边池 + 轮次 + 公共牌）竖排居中偏下：顶部一排座位带着黄铜徽章，
     会向左探出 12px，信息列下移 4% 才彻底让开。 */
  .center {
    top: var(--center-top, 45%);
    /* 侧边座位面板左右各占一段宽度，中央列只能落在中间净宽里，否则会与侧边座位相碰。 */
    max-width: calc(100% - var(--center-inset, 190px));
    /* 纵向安全边距：中央列最多占「桌面高 - 2×inset」，给上下两排座位留净空 */
    max-height: calc(100% - var(--center-max-height-inset, 0px) * 2);
  }

  /* 正对本人（环的最上沿）的座位：向上提一点，骑在黄铜护栏上，而不是缩进毡面里。 */
  .seat-slot.is-center-top {
    transform: translateY(-6px);
  }

  /* 贴边座位与常规座位自适应宽度：保证昵称与筹码信息全部完整展示且卡片不笨重 */
  /*
   * 座位宽度：普通座位直接继承 .table 上的 --seat-w（档位表注入）；
   * 侧边座位再用 --seat-w-side 收窄一档。
   * 注意不要写成 `var(--seat-w-side, var(--seat-w))`——在同一个元素上引用自身的
   * --seat-w 会造成循环引用，变量变成无效值，宽度回退到 `.seat-slot` 的 126px。
   */
  .seat-slot.is-side-seat {
    --seat-w: var(--seat-w-side);
  }

  .seat-slot.is-side-seat :deep(.panel) {
    padding-inline: 3px;
  }

  /*
   * 竖屏面板高度也是稀缺资源：桌面按 dvh 缩到 198px（360×740）后，9 人桌相邻座位的
   * 纵向中心距只有约 40px，而面板本身约 41px —— 必然会互相压住。
   * 内边距 6 → 4px（面板 41 → 37px），并在 740 及以下再收一档到 3px（→ 35px），
   * `npm run probe:table` 实测：360×740 上 4px 还剩 1.2×2px、3px 完全干净。
   */
  .seat-slot :deep(.panel) {
    padding-block: var(--seat-padding-block, 4px);
  }

  /*
   * 超短屏（如 320×568）：桌面只有 120px 高，9 人环在纵向上必然与中央块相交。
   * 这一档只收紧「本人座位那张卡片」与中央块之间的重叠：中央列整体上移、本人座位下移，
   * 其余座位靠 .center 的净宽约束横向让开。
   */
  /*
   * 320×568 的超短屏（老款 iPhone SE 一代等）：桌面只剩约 120px 高，9 人环在纵向
   * 必然与中央块相交。这里的策略是「环压缩 + 中央列居中」：
   *   1. 座位椭圆纵向半径压到 30%，把上下两排拉回桌内；
   *   2. 中央列按座位面板净宽收窄，居中显示底池与公共牌；
   *   3. 本人座位保持在下沿（e2e 断言要求居中且在桌面下半部分）。
   */
  /* 紧凑牌桌：座位改由 compactSeatStyle 左右两列排布，中央列回到桌面正中。 */
  .table.is-compact .center {
    transform: translate(-50%, -50%);
  }

  .table.is-compact .seat-slot {
    transform: translate(0, -50%);
  }

  .table.is-compact .seat-slot.is-hero-slot {
    transform: translate(-50%, -100%);
    z-index: 6;
  }

  @media (max-width: 340px) {
    /* 桌面撑满舞台可用高度（舞台本身只有 ~208px，再扣掉状态条等，靠 height:100% 吃满）。 */
    /* 超短屏只剩排版微调：几何尺寸统一来自 table-geometry.ts 的 compact 档位。 */
    .center {
      gap: 5px;
    }

    .pot {
      padding: 3px 12px 4px;
    }

    .pot b {
      font-size: 1.15rem;
    }

    .pot-label {
      font-size: 0.56rem;
    }

    .pots {
      display: none;
    }
  }

  /* 公共牌宽度跟着视口走：两侧贴边座位各占 64px + 4px 边距后剩下的横向空间，
     五张牌加牌距必须全部装下。390px 宽时 36px（旧 34px），360px 宽时 30px，320px 宽时 24px。 */
  .center :deep(.board) {
    --board-cw: clamp(24px, calc((100vw - 210px) / 5), 38px);
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
   * 竖屏也要显示本轮下注，但要比桌面档更紧凑：
   * 座位面板很窄，默认尺寸的筹码会压住自己的筹码数字与公共牌最外侧那张。
   * 缩小字号/内边距，并把落点半径收一点（见 chipStyle 的 --bet-radius），
   * 让筹码落在「座位面板与底池之间」那条窄带里。
   */
  .table {
    /* 筹码更靠近座位（远离桌心）：58% / 46% 仍会压到中央区的公共牌 */
    --bet-radius-x: 0.76;
    --bet-radius-y: 0.64;
  }

  .bet {
    gap: 1px;
    padding: 0 3px 0 2px;
    font-size: 0.58rem;
    line-height: 1.25;
    border-radius: 999px;
  }

  .bet .chip {
    width: 7px;
    height: 7px;
  }
}

/* 横屏手机：压低桌面高度，给底部操作区留出空间。 */
</style>
