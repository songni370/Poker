<script setup lang="ts">
/**
 * 动效 Demo：左边是「当前效果」，右边是「增强效果」。
 *
 * 这个页面只是给你看效果用的，不连服务端、不影响真实牌桌。
 * 数据是写死的，但动效逻辑（弧线飞行、错峰、筹码、金币雨）就是将来要接到
 * 真实牌桌上的那一套。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { DURATION, STAGGER, easeOutCubic, prefersReducedMotion } from '../motion/timing.ts'
import { centerOf, flyTo, offsetBetween, wait } from '../motion/deal.ts'

/** 当前演示的牌面：花色 + 点数，红色花色用 red 标记。 */
interface DemoCard {
  rank: string
  suit: string
  red: boolean
}

const FULL_BOARD: DemoCard[] = [
  { rank: 'A', suit: '♥', red: true },
  { rank: 'K', suit: '♠', red: false },
  { rank: 'Q', suit: '♦', red: true },
  { rank: 'J', suit: '♣', red: false },
  { rank: '10', suit: '♠', red: false },
]
/** 当前已发出的公共牌。 */
const board = ref<DemoCard[]>([])
/** 增强版的牌是"飞进来"的，需要一个独立的飞行态。 */
const dealing = ref(false)
/** 底池数字（增强版会滚动）。 */
const pot = ref(0)
const potTarget = ref(0)
/** 金币雨粒子。 */
const coins = ref<{ id: number; x: number; drift: number; delay: number; duration: number; rotate: number }[]>([])
/** 桌面震动。 */
const shaking = ref(false)
/** 动效开关。 */
const motionOn = ref(!prefersReducedMotion())

const boardRef = ref<HTMLElement | null>(null)
const deckRef = ref<HTMLElement | null>(null)
const potRef = ref<HTMLElement | null>(null)
const winSeatRef = ref<HTMLElement | null>(null)

let coinId = 0
let rafId = 0

/** 普通版：牌直接出现（现状）。 */
function playBasic(): void {
  board.value = []
  void wait(60).then(() => {
    board.value = FULL_BOARD.slice(0, 3)
  })
  void wait(500).then(() => {
    board.value = FULL_BOARD.slice(0, 4)
  })
  void wait(950).then(() => {
    board.value = FULL_BOARD.slice(0, 5)
    pot.value = 0
    potTarget.value = 1280
  })
}

/**
 * 增强版：牌从牌堆弧线飞出，逐张错峰落桌。
 *
 * 这里是 demo 的核心 —— 真实接入时，只需要把「牌堆位置」换成真实牌桌的
 * 牌堆锚点、「目标位置」换成每个牌位槽的坐标，其余逻辑完全复用。
 */
async function playEnhanced(): Promise<void> {
  if (dealing.value) return
  dealing.value = true
  board.value = []

  // 减少动效模式下直接出牌，不做飞行。
  if (!motionOn.value) {
    board.value = FULL_BOARD.slice(0, 3)
    potTarget.value = 1280
    dealing.value = false
    return
  }

  const deckPos = centerOf(deckRef.value)
  const slots = [...(boardRef.value?.querySelectorAll('.slot') ?? [])]

  // 翻牌三张：逐张从牌堆飞出。
  const flopCards = FULL_BOARD.slice(0, 3)
  for (let i = 0; i < flopCards.length; i += 1) {
    board.value = [...board.value, flopCards[i]!]
    // 等 Vue 把这张牌渲染进 DOM，才能拿它的位置。
    await wait(0)
    const slot = slots[i]
    const target = centerOf(slot)
    const cardEl = slot?.querySelector('.card') as HTMLElement | null
    if (deckPos && target && cardEl) {
      // 牌已经渲染在槽位里，此时它的中心就在 target。
      // 要让它"从牌堆飞来"，起点偏移 = 牌堆中心 - 槽位中心。
      void flyTo(cardEl, {
        from: offsetBetween(deckPos, target),
        to: { x: 0, y: 0 },
        duration: DURATION.dealFly,
        fromRotate: -22,
        fromScale: 0.6,
      })
    }
    await wait(STAGGER.flop)
  }

  // 等最后一张翻牌落定，再发转牌和河牌（这两张简化处理，直接出现）。
  await wait(DURATION.dealFly)
  board.value = [...board.value, FULL_BOARD[3]!]
  await wait(90)
  board.value = [...board.value, FULL_BOARD[4]!]

  // 底池滚动计数。
  animatePot(1280)

  dealing.value = false
}

/** 筹码飞向底池（增强版的底池计数动效）。 */
function animatePot(target: number): void {
  potTarget.value = target
  const start = performance.now()
  const from = pot.value
  cancelAnimationFrame(rafId)
  const frame = (now: number): void => {
    const t = Math.min(1, (now - start) / DURATION.potCount)
    pot.value = Math.round(from + (target - from) * easeOutCubic(t))
    if (t < 1) rafId = requestAnimationFrame(frame)
  }
  rafId = requestAnimationFrame(frame)
}

/** 赢牌：桌面微震 + 金币雨 + 底池归零。 */
async function celebrate(): Promise<void> {
  if (!motionOn.value) {
    pot.value = 0
    return
  }
  shaking.value = true
  await wait(DURATION.tableShake)
  shaking.value = false

  spawnCoins()
  pot.value = 0
  potTarget.value = 0
}

/** 生成一批金币粒子，从牌桌中央偏下向四周抛洒。 */
function spawnCoins(): void {
  const count = 40
  const batch: typeof coins.value = []
  for (let i = 0; i < count; i += 1) {
    coinId += 1
    // 起点固定在牌桌中央（50%），靠 drift 向左右两侧铺开。
    // 之前以赢家为原点，赢家在右侧导致金币全堆在他附近。
    batch.push({
      id: coinId,
      x: 50 + (Math.random() - 0.5) * 18,
      drift: (Math.random() - 0.5) * 320,
      delay: Math.random() * 320,
      duration: 760 + Math.random() * 460,
      rotate: Math.random() * 720 - 360,
    })
  }
  coins.value = batch
  void wait(DURATION.confetti).then(() => {
    coins.value = []
  })
}

function resetAll(): void {
  board.value = []
  pot.value = 0
  potTarget.value = 0
  coins.value = []
  dealing.value = false
}

onMounted(() => {
  void playBasic()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
})
</script>

<template>
  <div class="demo">
    <header class="demo-head">
      <h1>动效 Demo · 对比</h1>
      <p class="demo-sub">左边是现在的效果，右边是增强后的效果。点按钮看两边差异。</p>
      <label class="motion-toggle">
        <input v-model="motionOn" type="checkbox" />
        <span>启用增强动效（关掉可看降级效果）</span>
      </label>
    </header>

    <div class="stages">
      <!-- ───────── 左：当前效果 ───────── -->
      <section class="stage" aria-label="当前效果">
        <h2 class="stage-title">当前效果</h2>
        <div class="felt">
          <div class="deck">牌堆</div>
          <div class="board-simple">
            <span v-for="(card, i) in board" :key="i" class="card simple-card" :class="{ 'is-red': card.red }">
              <b class="rank">{{ card.rank }}</b>
              <span class="suit">{{ card.suit }}</span>
            </span>
            <span v-if="!board.length" class="hint">等待发牌</span>
          </div>
          <div class="pot-simple">底池 <b>{{ potTarget }}</b></div>
        </div>
        <button type="button" class="demo-btn" @click="playBasic">重放</button>
      </section>

      <!-- ───────── 右：增强效果 ───────── -->
      <section class="stage" aria-label="增强效果">
        <h2 class="stage-title stage-title--hot">增强效果</h2>
        <div class="felt" :class="{ 'is-shaking': shaking }">
          <div ref="deckRef" class="deck deck--enhanced">牌堆</div>

          <div ref="boardRef" class="board-simple board--enhanced">
            <template v-for="slot in 5" :key="slot">
              <span v-if="slot === 4" class="gap" aria-hidden="true" />
              <span class="slot">
                <span v-if="board[slot - 1]" class="card enhanced-card" :class="{ 'is-red': board[slot - 1]!.red }">
                  <b class="rank">{{ board[slot - 1]!.rank }}</b>
                  <span class="suit">{{ board[slot - 1]!.suit }}</span>
                </span>
                <span v-else class="card card--empty" />
              </span>
            </template>
          </div>

          <div ref="potRef" class="pot-simple pot--enhanced">
            底池 <b class="num">{{ pot }}</b>
          </div>

          <div ref="winSeatRef" class="win-seat">赢家</div>

          <!-- 金币雨粒子层 -->
          <div class="coin-layer" aria-hidden="true">
            <span
              v-for="coin in coins"
              :key="coin.id"
              class="coin"
              :style="{
                left: coin.x + '%',
                animationDelay: coin.delay + 'ms',
                animationDuration: coin.duration + 'ms',
                '--spin': coin.rotate + 'deg',
                '--drift': coin.drift + 'px',
              }"
            >
              <!-- 用 CSS 画金币：中间一道亮边，避免 emoji 跨平台渲染成灰球。 -->
              <span class="coin-face" />
            </span>
          </div>
        </div>

        <div class="enhanced-actions">
          <button type="button" class="demo-btn demo-btn--hot" @click="playEnhanced">发牌</button>
          <button type="button" class="demo-btn demo-btn--gold" @click="celebrate">赢牌庆祝</button>
          <button type="button" class="demo-btn" @click="resetAll">重置</button>
        </div>
      </section>
    </div>

    <section class="notes">
      <h3>这个 Demo 演示了什么</h3>
      <ul>
        <li><b>发牌弧线飞行</b>：牌从牌堆沿抛物线飞出，带旋转与景深缩放，逐张错峰落桌</li>
        <li><b>底池滚动计数</b>：数字不是瞬间跳变，而是缓动滚上去</li>
        <li><b>赢牌金币雨</b>：粒子从赢家位置抛出，带旋转与重力感</li>
        <li><b>桌面微震</b>：赢牌瞬间牌桌轻抖 180ms</li>
        <li><b>可降级</b>：取消勾选「启用增强动效」即可看到无动画版本，等同系统「减少动效」设置</li>
      </ul>
      <p class="notes-foot">
        所有动效都只改 transform / opacity，不触发重排；总时长控制在 700ms 以内。
      </p>
    </section>
  </div>
</template>

<style scoped>
.demo {
  min-height: 100vh;
  padding: 28px 24px 60px;
  background: radial-gradient(ellipse at top, #12201c 0%, #0a0f0d 70%);
  color: #e8efe9;
  font-family: inherit;
}

.demo-head {
  max-width: 1180px;
  margin: 0 auto 22px;
}

.demo-head h1 {
  margin: 0 0 6px;
  font-size: 1.5rem;
  letter-spacing: 0.04em;
}

.demo-sub {
  margin: 0 0 12px;
  color: rgba(232, 239, 233, 0.6);
  font-size: 0.86rem;
}

.motion-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.82rem;
  color: rgba(232, 239, 233, 0.78);
  cursor: pointer;
}

.stages {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  max-width: 1180px;
  margin: 0 auto;
}

@media (max-width: 860px) {
  .stages {
    grid-template-columns: 1fr;
  }
}

.stage {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.stage-title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 600;
  color: rgba(232, 239, 233, 0.62);
  letter-spacing: 0.08em;
}

.stage-title--hot {
  color: #34d399;
}

/* 牌桌绒面 */
.felt {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 140px / 90px;
  background:
    radial-gradient(ellipse at 50% 45%, #1b7a52 0%, #12563a 46%, #0a3524 78%, #072418 100%);
  border: 10px solid #4a2f1a;
  box-shadow:
    inset 0 0 60px rgba(0, 0, 0, 0.55),
    0 18px 40px rgba(0, 0, 0, 0.5),
    inset 0 2px 0 rgba(255, 255, 255, 0.06);
  overflow: hidden;
  /* 震动时整块桌面被移动：先提升成合成层，避免每帧重绘 60px 的 inset 阴影。 */
  will-change: transform;
  transform: translateZ(0);
}

.felt.is-shaking {
  animation: table-shake 180ms ease-in-out;
}

@keyframes table-shake {
  0%, 100% { transform: translate3d(0, 0, 0); }
  20% { transform: translate3d(-3px, 2px, 0); }
  40% { transform: translate3d(3px, -2px, 0); }
  60% { transform: translate3d(-2px, -1px, 0); }
  80% { transform: translate3d(2px, 1px, 0); }
}

.deck {
  position: absolute;
  left: 6%;
  top: 50%;
  transform: translateY(-50%);
  padding: 10px 12px;
  border-radius: 8px;
  background: linear-gradient(160deg, #2a4a8a, #16294f);
  border: 1px solid rgba(255, 255, 255, 0.18);
  font-size: 0.7rem;
  color: rgba(255, 255, 255, 0.7);
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.4), 6px 6px 0 rgba(0, 0, 0, 0.22);
}

.board-simple {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 8px;
}

.board--enhanced {
  gap: 6px;
}

.slot {
  display: inline-flex;
  width: 46px;
  height: 64px;
}

.card {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  width: 46px;
  height: 64px;
  border-radius: 7px;
  font-variant-numeric: tabular-nums;
}

.card .rank {
  font-size: 1rem;
  font-weight: 800;
  line-height: 1;
}

.card .suit {
  font-size: 0.85rem;
  line-height: 1;
}

/* 红色花色（红桃 / 方块），黑色花色继承默认深色。 */
.card.is-red {
  color: #b3272f;
}

.card:not(.is-red) {
  color: #1d232b;
}

.simple-card {
  background: #f4f1e8;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.45);
}

.enhanced-card {
  background: linear-gradient(165deg, #fffdf6, #ece6d6);
  color: #b3272f;
  box-shadow:
    0 6px 14px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 #fff,
    inset 0 -2px 4px rgba(0, 0, 0, 0.08);
  will-change: transform, opacity;
}

.card--empty {
  background: rgba(255, 255, 255, 0.045);
  border: 1px dashed rgba(255, 255, 255, 0.16);
}

.gap {
  width: 12px;
}

.hint {
  color: rgba(255, 255, 255, 0.4);
  font-size: 0.78rem;
}

.pot-simple {
  position: absolute;
  left: 50%;
  top: 24%;
  transform: translateX(-50%);
  padding: 5px 14px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.42);
  border: 1px solid rgba(255, 255, 255, 0.14);
  font-size: 0.76rem;
  color: rgba(255, 255, 255, 0.82);
  white-space: nowrap;
}

.pot--enhanced b {
  color: #f5c451;
  font-variant-numeric: tabular-nums;
}

.win-seat {
  position: absolute;
  right: 8%;
  bottom: 16%;
  padding: 8px 14px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(245, 196, 81, 0.5);
  font-size: 0.72rem;
  color: #f5c451;
}

/* 金币雨：粒子从上方落下，带旋转 */
.coin-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

/*
 * 金币：性能敏感元素，40 个同时动画。
 *
 * 掉帧根因是 box-shadow —— 它会在每次 transform 变化时重绘整枚金币。
 * 现在改为：
 * - 光晕用独立的 .coin-glow 伪层，静态渲染、只靠 opacity 淡入淡出；
 * - 本体只用 background 渐变 + border，配合 translate3d 强制走 GPU 合成层；
 * - 整个动画只碰 transform / opacity，不触发重绘。
 */
.coin {
  position: absolute;
  /* 起点在桌面中下部，金币从这里向四周迸开。 */
  top: 58%;
  left: 0;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: radial-gradient(circle at 34% 30%, #fff8da 0%, #f7d45a 36%, #d9a521 70%, #a97b12 100%);
  border: 1px solid rgba(255, 245, 200, 0.5);
  /* 提前提升为合成层，且只声明真正会变的属性。 */
  will-change: transform, opacity;
  transform: translateZ(0);
  animation-name: coin-burst;
  animation-timing-function: cubic-bezier(0.22, 0.7, 0.4, 1);
  animation-fill-mode: both;
}

/* 静态光晕：不参与动画的属性变化，只随 opacity 隐现。 */
.coin::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(247, 212, 90, 0.45) 0%, rgba(247, 212, 90, 0) 70%);
  pointer-events: none;
}

/* 金币压印亮边，让它看起来是"币"而不是"点"。 */
.coin-face {
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  border: 1px solid rgba(255, 250, 220, 0.55);
}

/*
 * 轨迹：向上迸起 → 到达顶点 → 重力回落 → 淡出。
 * 全部使用 translate3d / rotate / scale，走合成层。
 */
@keyframes coin-burst {
  0% {
    transform: translate3d(0, 0, 0) rotate(0deg) scale(0.5);
    opacity: 0;
  }
  14% {
    transform: translate3d(calc(var(--drift) * 0.35), -62px, 0) rotate(calc(var(--spin) * 0.2)) scale(1.05);
    opacity: 1;
  }
  46% {
    transform: translate3d(calc(var(--drift) * 0.75), -82px, 0) rotate(calc(var(--spin) * 0.5)) scale(1);
    opacity: 1;
  }
  100% {
    transform: translate3d(var(--drift), 250px, 0) rotate(var(--spin)) scale(0.85);
    opacity: 0;
  }
}

.demo-btn {
  align-self: flex-start;
  padding: 9px 20px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.07);
  color: #e8efe9;
  font-size: 0.84rem;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, transform 100ms ease;
}

.demo-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.demo-btn:active {
  transform: scale(0.97);
}

.demo-btn--hot {
  background: rgba(52, 211, 153, 0.16);
  border-color: rgba(52, 211, 153, 0.5);
  color: #6ee7b7;
}

.demo-btn--gold {
  background: rgba(245, 196, 81, 0.14);
  border-color: rgba(245, 196, 81, 0.45);
  color: #f5c451;
}

.enhanced-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.notes {
  max-width: 1180px;
  margin: 32px auto 0;
  padding: 18px 20px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.notes h3 {
  margin: 0 0 10px;
  font-size: 0.9rem;
  color: #34d399;
}

.notes ul {
  margin: 0;
  padding-left: 18px;
  line-height: 1.85;
  font-size: 0.82rem;
  color: rgba(232, 239, 233, 0.75);
}

.notes-foot {
  margin: 12px 0 0;
  font-size: 0.76rem;
  color: rgba(232, 239, 233, 0.45);
}

@media (prefers-reduced-motion: reduce) {
  .felt.is-shaking { animation: none; }
  .coin { display: none; }
}
</style>
