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
          v-if="seat"
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

        <!-- 空位：旁观者/离座者可以点它落座（买入确认在牌桌页面弹窗里做）。 -->
        <div
          v-else-if="canPickSeat"
          class="seat-slot"
          :class="{ 'is-side-seat': isSideSeat(index) }"
          :style="seatStyle(index)"
        >
          <button
            type="button"
            class="seat-empty"
            :class="{ 'is-reserved': reservedSeat === index }"
            :aria-label="
              reservedSeat === index
                ? `坐回 ${String(index + 1)} 号座位（座位为你保留）`
                : `坐到 ${String(index + 1)} 号座位`
            "
            :title="reservedSeat === index ? '这个座位为你保留，点击坐回' : '点击选择这个座位并买入'"
            @click="emit('pickSeat', index)"
          >
            <i :class="reservedSeat === index ? 'pi pi-user' : 'pi pi-plus'" aria-hidden="true" />
            <span class="num">{{ index + 1 }}</span>
            <span class="seat-empty-label">{{ reservedSeat === index ? '坐回' : '入座' }}</span>
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

/* 空位：可点的座位槽。描边虚线 + 「入座」文字，键盘可达（是真正的 button）。 */
.seat-empty {
  display: grid;
  justify-items: center;
  gap: 2px;
  width: var(--seat-w, 144px);
  padding: 6px 8px;
  border: 1px dashed rgba(212, 177, 106, 0.45);
  border-radius: var(--radius-md);
  background: rgba(0, 0, 0, 0.24);
  color: var(--muted);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  transition: border-color 0.15s ease-out, color 0.15s ease-out, background 0.15s ease-out;
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

/* 紧凑布局下的空位按钮：只留「+ 座位号」，高度与座位面板对齐，避免相邻空位互相压住。 */
@media (max-height: 430px) {
  .seat-empty {
    gap: 0;
    padding: 2px 6px;
    font-size: 0.74rem;
  }

  .seat-empty-label {
    display: none;
  }
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
     * 桌面高度跟着视口走：竖屏下顶栏 + 横屏引导 + 底部操作区要占掉 500px 上下
     * （动作区有下注滑块时最高），桌面吃掉剩下的高度，否则矮一点的手机（360×740）
     * 会被底部操作区顶出屏幕、整页纵向滚动。
     *
     * 重标定（本轮把底部操作区在竖屏压扁之后重新实测）：
     *   除桌面以外的固定占用在 390×844 / 360×740 下都是 486px 左右（顶栏 105 + 引导 38 +
     *   底部区约 330 + 舞台内边距 16），而可用高度是 100dvh（`#app` 已是 min-height: 100dvh）。
     *   所以桌面最多能拿 0.268 × dvh：844 → 226px（实测页面高度 844，零纵向滚动），
     *   740 → 198px，568 → 152px。系数取 0.268 而不是「1.1dvh - 618px」的旧写法，
     *   是因为旧写法把 390×844 顶到上限 310px，整页溢出 75px，而矮屏又掉到下限 196px。
     *   用 dvh 而不是 vh：地址栏伸缩时 vh 会算错。
     */
    --table-h: calc(100dvh * 0.268);
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

  /* 下注筹码同样改用面板角标：118px 高的桌面上，浮动筹码会压到公共牌或自己的筹码数字。 */
  .bet {
    display: none;
  }

  .pot b {
    font-size: 0.92rem;
  }
}
</style>
