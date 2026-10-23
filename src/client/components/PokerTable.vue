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
    /** 摊牌时每个亮牌玩家的牌型名（playerId → 牌型，如「同花」）；仅摊牌时下发。 */
    revealedHandNames?: Readonly<Record<string, string>>
    /** 赢家牌型名（去重；展示在公共牌下方）。 */
    winnerHandNames?: readonly string[]
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
    revealedHandNames: () => ({}),
    winnerHandNames: () => [],
    street: null,
    canPickSeat: false,
    reservedSeat: null,
  },
)

/**
 * 环形角度表：每个座位号（含空座）一个角度。
 *
 * 在座玩家按「实际在座人数」均分整圈，本人固定在下沿中央（+90°）——
 * 这是 task-1 验收过的规则（人数奇偶时上排都自然对称）。
 *
 * 空座（seats[i] === null）不能再到在座列表里 indexOf 取角度：以前会拿到 -1，
 * 所有空座都落到 +90° 与本人重叠（观战/空桌时 9 个「入座」按钮全叠在底部中央，
 * Playwright 点「坐到 N 号座位」会被同位置的另一个按钮拦截，e2e takeSeat 全部超时）。
 *
 * 现在的规则：
 *   1. 没有在座玩家（纯观战/空桌）：所有座位按座位号均分整圈，0 号位在正下方；
 *   2. 有在座玩家：第 g 个空隙（在座玩家 g → g+1，顺时针、最后一个空隙跨回 0°）
 *      分到 n_g = floor(空座数/空隙数) (+1) 个空座，隙内按 (j+1)/(n_g+1) 均匀取样。
 * 因此空座互不重叠、不与在座玩家重叠；空座和玩家数量刚好成环时就是标准均分环。
 */
const ringAngles = computed<number[]>(() => {
  const seats = props.seats
  const count = seats.length
  if (count === 0) return []
  const hero = props.heroSeat ?? -1
  const start = hero >= 0 ? hero : 0

  // 按「从本人（观战时为 0 号位）开始、顺时针」排出的槽位顺序
  const order: number[] = []
  for (let step = 0; step < count; step += 1) order.push((start + step) % count)

  const occupiedOrder = order.filter((index) => Boolean(seats[index]))
  const angles = new Array<number>(count).fill(Math.PI / 2)

  // 纯观战/空桌：与谁在座无关，按座位号从 0 号位（正下方）开始均分整圈。
  if (occupiedOrder.length === 0) {
    for (let index = 0; index < count; index += 1) {
      angles[index] = Math.PI / 2 + (index / count) * Math.PI * 2
    }
    return angles
  }

  // 在座玩家：与 task-1 完全一致的均分（本人 90°，其余顺时针铺满）。
  const occupiedAngles = occupiedOrder.map(
    (_index, k) => Math.PI / 2 + (k / occupiedOrder.length) * Math.PI * 2,
  )
  occupiedOrder.forEach((index, k) => {
    angles[index] = occupiedAngles[k]
  })

  const emptyOrder = order.filter((index) => !seats[index])
  if (emptyOrder.length === 0) return angles

  const gaps = occupiedOrder.length
  const perGap = Math.floor(emptyOrder.length / gaps)
  const extra = emptyOrder.length % gaps
  let cursor = 0
  for (let gap = 0; gap < gaps; gap += 1) {
    const from = occupiedAngles[gap]
    // 最后一个空隙跨回 0°，加 2π 保证角度单调递增。
    const to = gap + 1 < gaps ? occupiedAngles[gap + 1] : occupiedAngles[0] + Math.PI * 2
    const inGap = perGap + (gap < extra ? 1 : 0)
    for (let j = 0; j < inGap; j += 1) {
      angles[emptyOrder[cursor]] = from + ((to - from) * (j + 1)) / (inGap + 1)
      cursor += 1
    }
  }
  return angles
})

/** 环形极坐标：统一查角度表（空座也有角度，见 ringAngles）。 */
function polarFor(index: number): { angle: number } {
  return { angle: ringAngles.value[index] ?? Math.PI / 2 }
}

/** 除本人外的座位（按入座顺序），compact 布局用。 */
function otherSeatIndexes(): number[] {
  const hero = props.heroSeat ?? -1
  return props.seats.map((_seat, i) => i).filter((i) => i !== hero && props.seats[i])
}

/**
 * 超短屏（≤360 宽 且 ≤620 高）专用：桌面只有 ~160px 高，
 * 6–9 个面板按百分比排必然重叠，改用「左右两列 + 本人桌底」。
 * 只排真正有人的座位，空位不占行。
 */
function compactSeatStyle(index: number): Record<string, string> {
  const hero = props.heroSeat ?? -1
  if (index === hero) return { left: '50%', top: 'calc(100% - 2px)' }
  const occupied = otherSeatIndexes()
  const order = Math.max(0, occupied.indexOf(index))
  const side = order % 2 === 0 ? 'left' : 'right'
  const row = Math.floor(order / 2)
  const rows = Math.max(1, Math.ceil(occupied.length / 2))
  const top = rows === 1 ? 50 : 14 + (row * 72) / (rows - 1)
  return {
    [side]: '2px',
    top: `${String(Math.round(top))}%`,
  }
}

/**
 * 把座位换算成 CSS。
 *
 * 锚点 = 椭圆参数方程，radial 半径 50%/50% 时锚点正好落在桌面椭圆外沿；
 * `.seat-slot` 再用 translate(-50%, -50%) 把**面板中心**对到锚点上，
 * 于是面板一半在桌外、一半压在护栏上（用户要求的「跨在桌沿」）。
 *
 * x 方向仍需收边，但边界是**视口**而不是桌面：桌面在视口里水平居中，
 * 桌面左沿到视口的距离 = (100vw - 桌面宽) / 2，因此
 *   面板左沿 >= 0  ⇔  left >= 面板半宽 - slack
 * 允许 left 在桌面内部坐标为负（面板探出桌面），但不能被视口裁掉、不能产生横向滚动。
 * 右侧对称。桌面档（无档位变量）下 slack 很大，max/min 不会生效，行为与旧版一致。
 */
function seatStyle(index: number): Record<string, string> {
  const { angle } = polarFor(index)
  const seat = 'var(--seat-w, 144px)'
  const slack = '(100vw - var(--table-width, 100%)) / 2'
  const anchor = `calc(50% + var(--seat-anchor-x, ${String(RX)}%) * ${String(Math.cos(angle))})`
  /*
   * 接近水平的中左/中右座位（9 人桌 170°/10°、6 人桌 150°/30°/210°/330° 等，
   * |sin| ≤ 0.55）整体下移一点：它们的卡片正好落在上一张卡片的正下方，
   * 视觉上信息容易贴得太近；下移用档位变量 --seat-side-shift-y（竖屏 8px、桌面 0），
   * 左右两侧 sin 相同 → 偏移量相同，镜像对称不受影响。
   */
  const sideShift =
    Math.abs(Math.sin(angle)) <= 0.55 ? ' + var(--seat-side-shift-y, 0px)' : ''
  return {
    left: `max(calc(${seat} / 2 - ${slack} + 2px), min(calc(100% - ${seat} / 2 + ${slack} - 2px), ${anchor}))`,
    top: `calc(50% + var(--seat-anchor-y, ${String(RY)}%) * ${String(Math.sin(angle))}${sideShift})`,
  }
}

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
  /* 「侧边座位」= 环上最左/最右的两个（角度接近 0° 或 180°），面板需要收窄。 */
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

      <div class="center" :class="{ 'has-hand-names': winnerHandNames.length > 0 }">
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
        <!-- 赢家牌型（摊牌时展示在公共牌正下方；平分时并列、去重）。 -->
        <p v-if="winnerHandNames.length > 0" class="center-hand-names" aria-label="赢家牌型">
          <span v-for="name in winnerHandNames" :key="name" class="center-hand-name">
            <span class="center-hand-crown" aria-hidden="true">👑</span>{{ name }}
          </span>
        </p>
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
            :hand-name="revealedHandNames[seat.playerId] ?? ''"
          />
          <!-- 本轮下注：贴在玩家信息卡片正上方（跟着卡片高度自动走，含摊牌亮牌）。 -->
          <div v-if="seat.committedStreet > 0" class="bet" :data-seat="index + 1">
            <span class="chip" aria-hidden="true" />
            <span class="num">{{ seat.committedStreet }}</span>
          </div>
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
          <div v-if="seat.committedStreet > 0" class="bet" :data-seat="index + 1">
            <span class="chip" aria-hidden="true" />
            <span class="num">{{ seat.committedStreet }}</span>
          </div>
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
          <div v-if="seat.committedStreet > 0" class="bet" :data-seat="index + 1">
            <span class="chip" aria-hidden="true" />
            <span class="num">{{ seat.committedStreet }}</span>
          </div>
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

/*
 * 摊牌时中央多了一行「赢家牌型」，中央块会变高；非竖屏（桌面/平板横屏）把它整体下移，
 * 避免顶部座位（桌沿上方的卡片）被中央块压到。
 * 竖屏有自己的 --center-top（45%，纵向余量足够），这条规则不作用于竖屏。
 */
@media (min-width: 561px) {
  .center.has-hand-names {
    top: 50%;
  }
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

/* 赢家牌型：公共牌正下方的小号金框胶囊，平分时并列 */
.center-hand-names {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px;
  margin: 0;
}

.center-hand-name {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 9px;
  border-radius: 999px;
  background: linear-gradient(180deg, #3a2c15 0%, #231a0e 100%);
  border: 1px solid #c39a4f;
  color: #ffe9ac;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.02em;
  white-space: nowrap;
  box-shadow:
    inset 0 1px 0 rgba(255, 230, 170, 0.35),
    0 0 12px rgba(255, 200, 90, 0.35),
    0 2px 6px rgba(0, 0, 0, 0.6);
}

.center-hand-crown {
  font-size: 0.72rem;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8));
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

/*
 * 本人座位：锚点落在桌面下沿（50%/50% 椭圆），面板中心对齐桌沿、一半探出桌外。
 * 之前这里用 translateY(-6px) 把整块面板塞回桌面内，与「座位跨在桌沿上」的目标相反，
 * 已删除。
 */
.is-hero-slot {
  z-index: 3;
}

/*
 * 正对本人（环的最上沿）那个座位隐藏状态行/进度条：
 * 让顶部座位面板更矮，给卡片上方的下注徽章留出「桌外 → HUD 胶囊」之间的净空
 * （历史原因：以前这里让位给桌面浮动筹码，本轮筹码已挪到卡片上方）。
 */
.seat-slot.is-center-top :deep(.status),
.seat-slot.is-center-top :deep(.timer) {
  display: none;
}

/*
 * 本轮下注徽章：贴在对应玩家信息卡片**正上方**（位置由 .seat-slot 高度决定，
 * 摊牌亮牌 / 底牌背面 / 离座胶囊增高时自动跟着上移），一眼看出「谁下了多少」。
 * 药丸底 + 黄铜描边 + 微光；金色数字 ≥0.78rem。data-seat 供 e2e/几何探针关联座位。
 */
.bet {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 3px);
  transform: translateX(-50%);
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 9px 2px 5px;
  border-radius: 999px;
  background: linear-gradient(180deg, #2c2318 0%, #140f0a 100%);
  border: 1px solid rgba(212, 177, 106, 0.85);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    inset 0 -2px 6px rgba(0, 0, 0, 0.7),
    0 2px 8px rgba(0, 0, 0, 0.7),
    0 0 10px rgba(212, 177, 106, 0.22);
  color: #ffdf9a;
  font-size: 0.8rem;
  font-weight: 800;
  line-height: 1.2;
  white-space: nowrap;
  pointer-events: none;
  text-shadow: 0 1px 0 #000, 0 0 6px rgba(255, 190, 90, 0.45);
}

.bet .num {
  color: inherit;
  font-size: inherit;
  letter-spacing: 0.01em;
}

.bet .chip {
  width: 10px;
  height: 10px;
  flex: none;
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
.table.is-full-ring .seat-slot :deep(.cards:not(.is-revealed)) {
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
   .table 只保留材质与结构规则。 */

/*
 * 竖屏（≤560px 宽）：牌桌缩成固定尺寸（390×844 时 306×334、360×740 时 296×252），
 * 座位锚点 50%/50% —— 面板中心落在桌沿、一半探出桌外（见 table-geometry.ts）。
 * 舞台剩余高度只做「垂直居中」容器：桌面上下留白由尺寸差自然形成，
 * 顶部 HUD 胶囊（底边 y≈107）与底部操作区都不会被座位压到（实测 390/360 两档）。
 */
@media (max-width: 560px) and (orientation: portrait) {
  /* 空桌引导放进下方观战栏，避免中央长句压住环形座位。 */
  .empty-state {
    display: none;
  }

  .table-wrap {
    height: 100%;
  }

  .table {
    /*
     * 在舞台剩余高度里垂直居中。用 align-self 而不是容器 align-content：
     * 紧凑档的桌面高度是 100%，需要行先被拉伸（默认 stretch）才能解析出高度，
     * 再让固定高度的牌桌在行内居中。
     *
     * top 用档位表的 --table-shift-y 整体下移 12px：亮牌后卡片向上长高，
     * 顶部座位卡片上方的下注/赢家徽章需要让开 HUD；只做视觉偏移，
     * 座位仍用 .table 内的百分比定位，不影响 ringAngles/seatStyle。
     */
    position: relative;
    top: var(--table-shift-y, 0px);
    align-self: center;
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
    /*
     * 座位面板现在窄 3 行、且中心落在桌沿外，公共牌行与座位面板纵向错开，
     * 中央列不再需要按「两侧各让一张座位面板」收窄：只留 16px 边距，
     * 让 390 的 5 张 36px 公共牌（≈208px）完整展开。
     * 实测公共牌行与所有座位面板零重叠（probe 全绿）。
     */
    max-width: calc(100% - 16px);
    /* 纵向安全边距：中央列最多占「桌面高 - 2×inset」，给上下两排座位留净空 */
    max-height: calc(100% - var(--center-max-height-inset, 0px) * 2);
  }

  /*
   * 正对本人（环的最上沿）的座位：不要再叠加 translateY 覆盖 .seat-slot 的
   * translate(-50%, -50%) —— 那会让顶部座位丢失水平居中，两张卡片整体向右下偏移
   * 约半个面板（用户反馈的「顶部 2 个玩家信息卡片不对称」就是这个）。
   * 50%/50% 的锚点已经让面板中心落在桌沿，无需额外位移。
   */

  /* 贴边座位与常规座位自适应宽度：保证昵称与筹码信息全部完整展示且卡片不笨重 */
  /*
   * 座位宽度：普通座位直接继承 .table 上的 --seat-w（档位表注入）；
   * 左右两列要伸出桌面、且不能顶到视口，再用 --seat-w-side 收窄一档。
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
   * 竖屏面板高度也是稀缺资源：把内边距收到档位表的 --seat-padding-block
   * （390×844 用 4px、360×740 用 3px），面板本体约 35–37px。
   * 摊牌时面板会因「显示真实底牌」增高到 ~81px，座位锚点按 50%/50% 预留了这份高度
   * （顶部不压 HUD、底部不压操作区，见 table-geometry.ts 的档位说明）。
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

  /*
   * 公共牌宽度：档位表的 --board-cw 已从 .table 继承下来（390 宽 28px、360 宽 22px），
   * 这里不再写第二份像素公式，避免两处不一致。中央列净宽 = 桌面宽 - 2×(侧边面板+8)。
   */
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
   * 竖屏的本轮下注徽章与桌面档共用同一套样式（贴在座位卡片正上方）：
   * 座位面板只有 74–90px 宽，徽章宽约 42–68px、高约 21px，居中后不会越界；
   * 原来写在桌面径向圆环上的 .bet 定位已删除，不再需要 --bet-radius-*。
   */
}

/* 横屏手机：压低桌面高度，给底部操作区留出空间。 */
</style>
