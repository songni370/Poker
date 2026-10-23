<script setup lang="ts">
/**
 * Phaser 牌桌 Demo：验证「Vue 管业务、Phaser 管牌桌画面」的混合架构。
 *
 * 这个页面验证三件事：
 * 1. Phaser 能在 Vue 里正常初始化和销毁（不泄漏）。
 * 2. 牌的落桌回弹（物理手感）比纯 CSS 更像"真牌"。
 * 3. WebGL 粒子能扛住大量金币而不掉帧。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import Phaser from 'phaser'
import { createPokerTableGame, PokerTableScene } from '../phaser/table-scene.ts'

const canvasHost = ref<HTMLElement | null>(null)
const game = shallowRef<Phaser.Game | null>(null)
const scene = shallowRef<PokerTableScene | null>(null)
const ready = ref(false)
const errorMsg = ref('')

/** 演示用的牌面。 */
const BOARD = [
  { face: 'A♥', color: 'red' as const },
  { face: 'K♠', color: 'black' as const },
  { face: 'Q♦', color: 'red' as const },
  { face: 'J♣', color: 'black' as const },
  { face: '10♠', color: 'black' as const },
]

let dealt = 0

/** 实时帧率（来自 Phaser 的游戏循环，比 rAF 采样可靠）。 */
const fps = ref(0)

onMounted(() => {
  if (!canvasHost.value) return
  try {
    const host = canvasHost.value
    // 固定内部分辨率，交给 Phaser 的 FIT 缩放，保证不同屏幕上比例一致。
    const g = createPokerTableGame(host, { width: 960, height: 540 })
    game.value = g
    // 方便在浏览器控制台排查渲染问题（仅 demo 页使用）。
    ;(window as unknown as { __phaserGame?: Phaser.Game }).__phaserGame = g

    g.events.once('ready', () => {
      scene.value = g.scene.getScene('PokerTableScene') as PokerTableScene
      ready.value = true
    })

    // Phaser 的 LOOP 已完成初始化后取场景。
    g.events.on(Phaser.Core.Events.READY, () => {
      scene.value = g.scene.getScene('PokerTableScene') as PokerTableScene
      ready.value = true
    })

    // 每 500ms 刷新一次帧率显示。
    const fpsTimer = window.setInterval(() => {
      fps.value = Math.round(g.loop.actualFps)
    }, 500)
    g.events.once(Phaser.Core.Events.DESTROY, () => window.clearInterval(fpsTimer))
  } catch (cause) {
    errorMsg.value = cause instanceof Error ? cause.message : String(cause)
  }
})

onBeforeUnmount(() => {
  // 关键：一定要销毁，否则热更新会残留多个 canvas 和游戏循环。
  game.value?.destroy(true)
  game.value = null
  scene.value = null
})

/** 发下一张公共牌。 */
function dealNext(): void {
  const s = scene.value
  if (!s || dealt >= BOARD.length) return
  const card = BOARD[dealt]!
  dealt += 1
  void s.dealCommunityCard(dealt - 1, card.face, card.color)
}

/** 一次发翻牌三张。 */
async function dealFlop(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    dealNext()
    await new Promise((r) => setTimeout(r, 110))
  }
}

/** 筹码推注。 */
function pushChips(): void {
  scene.value?.pushChips(14, 120, 300)
}

/** 金币雨。 */
function burst(): void {
  scene.value?.burstCoins()
}

function reset(): void {
  scene.value?.reset()
  dealt = 0
}
</script>

<template>
  <div class="phaser-demo">
    <header class="demo-head">
      <div>
        <h1>Phaser 牌桌 Demo</h1>
        <p class="demo-sub">
          Vue 负责布局与文字，Phaser 只渲染牌桌画面：物理落桌回弹 + WebGL 粒子。
        </p>
      </div>
      <div class="fps-badge" :class="{ 'fps-badge--good': fps >= 55, 'fps-badge--mid': fps >= 40 && fps < 55 }">
        <span class="fps-num">{{ fps }}</span>
        <span class="fps-label">FPS</span>
      </div>
    </header>

    <p v-if="errorMsg" class="demo-error">Phaser 初始化失败：{{ errorMsg }}</p>

    <div class="table-shell">
      <!-- Phaser 的 canvas 挂在这里，Z 轴在牌桌背景之上。 -->
      <div ref="canvasHost" class="canvas-host" />
      <!-- DOM 层：牌桌背景与文字仍由 CSS 负责。 -->
      <div class="felt-underlay" aria-hidden="true" />
    </div>

    <div class="controls">
      <button type="button" class="demo-btn demo-btn--hot" :disabled="!ready" @click="dealFlop">
        发翻牌
      </button>
      <button type="button" class="demo-btn demo-btn--hot" :disabled="!ready" @click="dealNext">
        发下一张
      </button>
      <button type="button" class="demo-btn demo-btn--gold" :disabled="!ready" @click="pushChips">
        筹码推注
      </button>
      <button type="button" class="demo-btn demo-btn--gold" :disabled="!ready" @click="burst">
        金币雨
      </button>
      <button type="button" class="demo-btn" :disabled="!ready" @click="reset">重置</button>
    </div>

    <section class="notes">
      <h3>这个 Demo 验证了什么</h3>
      <ul>
        <li><b>物理落桌</b>：牌先飞到牌位上方，再 <code>Bounce.easeOut</code> 落下，有真实回弹</li>
        <li><b>翻牌</b>：牌背压扁到 0 再展开牌面，<code>Back.easeOut</code> 带轻微过冲</li>
        <li><b>筹码物理</b>：14 枚筹码带初速度飞向底池，Arcade Physics 负责减速与落位</li>
        <li><b>WebGL 粒子</b>：一次爆发 120 枚金币，单个 draw call</li>
        <li><b>帧率实时显示</b>：右上角是 Phaser 游戏循环的真实 FPS，不是估算值</li>
        <li><b>可销毁</b>：离开页面时 <code>game.destroy(true)</code>，不留残余循环</li>
      </ul>
      <p class="notes-foot">
        canvas 内部固定 960×540，由 Phaser 的 FIT 缩放适配容器，因此物理参数跨屏幕一致。
      </p>
    </section>
  </div>
</template>

<style scoped>
.phaser-demo {
  min-height: 100vh;
  padding: 26px 24px 60px;
  background: radial-gradient(ellipse at top, #101a17 0%, #080c0a 72%);
  color: #e8efe9;
}

.demo-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  max-width: 1000px;
  margin: 0 auto 18px;
}

.demo-head h1 {
  margin: 0 0 6px;
  font-size: 1.42rem;
  letter-spacing: 0.03em;
}

.demo-sub {
  margin: 0;
  max-width: 620px;
  font-size: 0.84rem;
  line-height: 1.6;
  color: rgba(232, 239, 233, 0.58);
}

.fps-badge {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 74px;
  height: 60px;
  border-radius: 12px;
  background: rgba(248, 113, 113, 0.14);
  border: 1px solid rgba(248, 113, 113, 0.4);
}

.fps-badge--mid {
  background: rgba(245, 196, 81, 0.14);
  border-color: rgba(245, 196, 81, 0.4);
}

.fps-badge--good {
  background: rgba(52, 211, 153, 0.14);
  border-color: rgba(52, 211, 153, 0.45);
}

.fps-num {
  font-size: 1.4rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.fps-label {
  margin-top: 3px;
  font-size: 0.62rem;
  letter-spacing: 0.14em;
  color: rgba(232, 239, 233, 0.5);
}

.demo-error {
  max-width: 1000px;
  margin: 0 auto 14px;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(248, 113, 113, 0.12);
  border: 1px solid rgba(248, 113, 113, 0.35);
  font-size: 0.82rem;
}

/* 牌桌容器：CSS 画桌面，Phaser canvas 叠在上面 */
.table-shell {
  position: relative;
  max-width: 1000px;
  margin: 0 auto;
  aspect-ratio: 16 / 9;
  border-radius: 150px / 96px;
  border: 10px solid #4a2f1a;
  overflow: hidden;
  box-shadow:
    0 22px 50px rgba(0, 0, 0, 0.62),
    inset 0 2px 0 rgba(255, 255, 255, 0.05);
}

.felt-underlay {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: radial-gradient(ellipse at 50% 45%, #1b7a52 0%, #12563a 46%, #0a3524 78%, #072418 100%);
  box-shadow: inset 0 0 70px rgba(0, 0, 0, 0.58);
}

.canvas-host {
  position: absolute;
  inset: 0;
  z-index: 1;
}

/* Phaser 会把 canvas 插进 .canvas-host，确保它撑满容器。 */
.canvas-host :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  max-width: 1000px;
  margin: 18px auto 0;
}

.demo-btn {
  padding: 9px 20px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.07);
  color: #e8efe9;
  font-size: 0.84rem;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, transform 100ms ease;
}

.demo-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
}

.demo-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.demo-btn:disabled {
  opacity: 0.4;
  cursor: default;
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

.notes {
  max-width: 1000px;
  margin: 30px auto 0;
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
  line-height: 1.9;
  font-size: 0.82rem;
  color: rgba(232, 239, 233, 0.75);
}

.notes code {
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 0.78em;
}

.notes-foot {
  margin: 12px 0 0;
  font-size: 0.76rem;
  color: rgba(232, 239, 233, 0.45);
}
</style>
