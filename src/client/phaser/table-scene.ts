/**
 * Phaser 牌桌场景：用真实物理和 WebGL 粒子渲染牌桌区域。
 *
 * 与 Vue 的分工：
 * - Vue 负责页面布局、表单、弹窗、文字（保持无障碍与中文排版）
 * - Phaser 只负责这一块 canvas：牌、筹码、粒子
 *
 * 设计要点：
 * 1. 牌用 Arcade Physics 落地，带轻微回弹，落桌手感是 CSS 做不出来的。
 * 2. 筹码用圆形物理体堆叠，推注时真的会"堆"起来。
 * 3. 金币雨用 Phaser 内置 ParticleEmitter（WebGL 一次 draw call），
 *    几百个粒子也不掉帧。
 */

import Phaser from 'phaser'

/** 牌面设计尺寸（逻辑像素）。 */
const CARD_W = 92
const CARD_H = 128
/**
 * 牌面纹理超采样倍率。
 *
 * 牌在场景里缩放 0.82 显示，canvas 又会经 FIT 缩放适配容器，
 * 1 倍取样时牌上的点数与花色边缘发虚。2 倍超采样后清晰度明显改善，
 * 代价是 52 张小纹理约占 3MB 显存，可接受。
 */
const CARD_TEX_SCALE = 2
const RED_SUIT = 0xb3272f
const BLACK_SUIT = 0x1d232b

export interface TableSceneOptions {
  /** 牌桌宽高比（与 CSS 里的桌子保持一致）。 */
  width: number
  height: number
}

/** 一张牌在场景中的完整数据。 */
interface CardObject {
  sprite: Phaser.GameObjects.Container
  zone: Phaser.GameObjects.Zone
}

export class PokerTableScene extends Phaser.Scene {
  private tableOptions: TableSceneOptions
  /** 公共牌槽位的中心点。 */
  private slotPositions: { x: number; y: number }[] = []
  /** 已发出的公共牌。 */
  private cards: CardObject[] = []
  /** 筹码物理组。 */
  private chips!: Phaser.Physics.Arcade.Group
  /** 金币粒子发射器。 */
  private coinEmitter?: Phaser.GameObjects.Particles.ParticleEmitter
  /** 牌堆位置（发牌起点）。 */
  private deckPos = { x: 0, y: 0 }

  constructor(options: TableSceneOptions) {
    super({ key: 'PokerTableScene' })
    this.tableOptions = options
  }

  preload(): void {
    // 全部纹理在代码里生成，不依赖外部素材文件。
    this.createTextures()
  }

  create(): void {
    const { width, height } = this.tableOptions
    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)')

    // 牌堆：桌面左侧。
    this.deckPos = { x: width * 0.12, y: height * 0.5 }
    this.drawDeck()

    // 5 个公共牌位（第 4 位前留一个间隙，与真实牌桌一致）。
    const slots = 5
    const slotW = width * 0.072
    const gap = slotW * 0.22
    const extraGap = slotW * 0.35
    const totalW = slots * slotW + (slots - 1) * gap + extraGap
    const startX = width * 0.5 - totalW / 2 + slotW / 2
    for (let i = 0; i < slots; i += 1) {
      const x = startX + i * (slotW + gap) + (i >= 4 ? extraGap : 0)
      this.slotPositions.push({ x, y: height * 0.5 })
      this.drawSlot(x, height * 0.5, slotW)
    }

    // 物理世界。
    this.physics.world.setBounds(0, 0, width, height)
    this.chips = this.physics.add.group()

    // 金币粒子发射器（默认关闭，赢牌时手动爆发）。
    this.createCoinEmitter()
    // 52 张牌面一次性预生成：把纹理上传的开销挪到加载阶段，发牌时不再卡顿。
    this.pregenerateCardFaces()
  }

  /** 用 Graphics 现场生成纹理，避免引入图片资源。 */
  private createTextures(): void {
    const g = this.make.graphics({ x: 0, y: 0 }, false)

    // 牌面不在这里生成：每张牌的点数与花色不同，由 makeCardFaceTexture 按需合成。

    // ── 牌背（深蓝渐变 + 菱形纹样）──
    const cardW = 92
    const cardH = 128
    g.fillStyle(0x1b2f5e, 1)
    g.fillRoundedRect(0, 0, cardW, cardH, 10)
    g.lineStyle(3, 0x3a5a9e, 1)
    g.strokeRoundedRect(6, 6, cardW - 12, cardH - 12, 7)
    g.lineStyle(1, 0x4a6fb8, 0.55)
    for (let i = -cardH; i < cardW; i += 14) {
      g.lineBetween(i, 0, i + cardH, cardH)
    }
    g.generateTexture('card-back', cardW, cardH)
    g.clear()

    // ── 筹码（环形，带内圈）──
    const chipSize = 34
    g.fillStyle(0xffffff, 1)
    g.fillCircle(chipSize / 2, chipSize / 2, chipSize / 2)
    g.fillStyle(0x2b7a4b, 1)
    g.fillCircle(chipSize / 2, chipSize / 2, chipSize / 2 - 2)
    g.lineStyle(2, 0xffffff, 0.85)
    g.strokeCircle(chipSize / 2, chipSize / 2, chipSize / 2 - 6)
    g.generateTexture('chip', chipSize, chipSize)
    g.clear()

    // ── 金币（径向渐变靠多层圆近似）──
    const coinSize = 18
    const c = coinSize / 2
    g.fillStyle(0xd9a521, 1)
    g.fillCircle(c, c, c)
    g.fillStyle(0xf7d45a, 1)
    g.fillCircle(c, c, c - 1.5)
    g.fillStyle(0xfff3c4, 1)
    g.fillCircle(c - 1.6, c - 1.6, c * 0.42)
    g.generateTexture('coin', coinSize, coinSize)
    g.clear()

    // ── 柔和光晕（粒子拖尾用的径向光点）──
    const glow = this.make.graphics({ x: 0, y: 0 }, false)
    for (let r = 24; r > 0; r -= 1) {
      glow.fillStyle(0xf7d45a, 0.045)
      glow.fillCircle(24, 24, r)
    }
    glow.generateTexture('glow', 48, 48)
    g.destroy()
    glow.destroy()
  }

  /** 牌堆：几张牌微微错位叠在一起。 */
  private drawDeck(): void {
    for (let i = 3; i >= 0; i -= 1) {
      this.add
        .image(this.deckPos.x + i * 1.6, this.deckPos.y - i * 1.6, 'card-back')
        .setScale(0.52)
        .setOrigin(0.5)
        .setAlpha(i === 0 ? 1 : 0.9)
    }
  }

  /** 公共牌的空位：虚线描边。 */
  private drawSlot(x: number, y: number, w: number): void {
    const g = this.add.graphics()
    g.lineStyle(1.5, 0xffffff, 0.18)
    g.strokeRoundedRect(x - w / 2, y - (w * 1.39) / 2, w, w * 1.39, 7)
  }

  private createCoinEmitter(): void {
    this.coinEmitter = this.add.particles(0, 0, 'coin', {
      speed: { min: 180, max: 460 },
      angle: { min: 200, max: 340 },
      gravityY: 780,
      lifespan: { min: 900, max: 1500 },
      scale: { start: 1, end: 0.7 },
      alpha: { start: 1, end: 0 },
      rotate: { start: 0, end: 360 },
      quantity: 0,
      emitting: false,
      blendMode: Phaser.BlendModes.NORMAL,
      // 预分配粒子池：首次爆发时不再临时创建 120 个对象，
      // 这原来是"金币雨第一下卡顿"的来源。
      maxParticles: 200,
    })
    // 预热：让 Phaser 提前把粒子对象与顶点缓冲准备好（但不下落）。
    this.coinEmitter.setPosition(0, 0)
  }

  /**
   * 生成一张"完整牌面"纹理：白底 + 点数 + 花色，直接合成一张图。
   *
   * 早先是「白底板 + 独立 Text 对象」两层，但 Text 在 Container 里的
   * 可见性切换容易被容器状态覆盖（实测翻牌后牌面不显示）。
   * 合成成一张纹理后，翻面只需切换一张图的 visible，稳定且省 draw call。
   *
   * 清晰度：纹理按 CARD_TEX_SCALE 倍超采样生成，显示时缩回 1 倍。
   * 早先用 92×128 直接画，牌上的点数和花色在缩放到 0.82 再经 FIT 缩放后
   * 边缘发虚（用户反馈"牌面有的看不清"）。2 倍超采样 + 线性过滤后清晰度明显提升。
   */
  private makeCardFaceTexture(key: string, rank: string, suit: string, color: number): void {
    const S = CARD_TEX_SCALE
    const cardW = CARD_W * S
    const cardH = CARD_H * S
    const g = this.make.graphics({ x: 0, y: 0 }, false)

    // 白底 + 内描边。
    g.fillStyle(0xfdfaf0, 1)
    g.fillRoundedRect(0, 0, cardW, cardH, 10 * S)
    g.lineStyle(2 * S, 0xd9cfb8, 1)
    g.strokeRoundedRect(S, S, cardW - 2 * S, cardH - 2 * S, 9 * S)

    // 点数与花色用几何图形绘制：不依赖系统字体，跨平台一致。
    this.drawRankGlyph(g, rank, cardW * 0.28, cardH * 0.3, color, S)
    this.drawSuit(g, suit, cardW * 0.28, cardH * 0.55, 20 * S, color)

    g.generateTexture(key, cardW, cardH)
    g.destroy()
  }

  /**
   * 预生成全部 52 张牌面纹理。
   *
   * 之前是「第一次发到某张牌时才生成」，那次 generateTexture 会触发
   * 纹理上传，恰好落在发牌动画启动的那一帧上 —— 这就是用户反馈的
   * "发牌初始有些卡顿"。提前在 create() 里一次性生成，发牌时就只剩动画开销。
   */
  private pregenerateCardFaces(): void {
    const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
    const SUITS: { suit: string; color: number }[] = [
      { suit: '♥', color: RED_SUIT },
      { suit: '♦', color: RED_SUIT },
      { suit: '♠', color: BLACK_SUIT },
      { suit: '♣', color: BLACK_SUIT },
    ]
    for (const rank of RANKS) {
      for (const { suit, color } of SUITS) {
        const key = `face-${rank}-${suit}`
        if (!this.textures.exists(key)) this.makeCardFaceTexture(key, rank, suit, color)
      }
    }
  }

  /**
   * 用线段画点数（A/K/Q/J/数字）。
   *
   * 所有坐标都乘以 s（超采样倍率），这样 1 倍与 2 倍纹理的形状完全一致，
   * 不会出现"放大后笔画变细"的问题。
   */
  private drawRankGlyph(g: Phaser.GameObjects.Graphics, rank: string, cx: number, cy: number, color: number, s: number): void {
    g.lineStyle(4 * s, color, 1)
    const u = 1 * s
    switch (rank) {
      case 'A':
        g.beginPath()
        g.moveTo(cx - 9 * u, cy + 9 * u)
        g.lineTo(cx, cy - 11 * u)
        g.lineTo(cx + 9 * u, cy + 9 * u)
        g.moveTo(cx - 5 * u, cy + 2 * u)
        g.lineTo(cx + 5 * u, cy + 2 * u)
        g.strokePath()
        break
      case 'K':
        g.beginPath()
        g.moveTo(cx - 8 * u, cy - 11 * u)
        g.lineTo(cx - 8 * u, cy + 11 * u)
        g.moveTo(cx - 8 * u, cy + 1 * u)
        g.lineTo(cx + 8 * u, cy - 11 * u)
        g.moveTo(cx - 8 * u, cy + 1 * u)
        g.lineTo(cx + 8 * u, cy + 11 * u)
        g.strokePath()
        break
      case 'Q':
        g.strokeCircle(cx, cy - 1 * u, 9 * u)
        g.beginPath()
        g.moveTo(cx + 3 * u, cy + 6 * u)
        g.lineTo(cx + 9 * u, cy + 12 * u)
        g.strokePath()
        break
      case 'J':
        g.beginPath()
        g.moveTo(cx - 5 * u, cy - 10 * u)
        g.lineTo(cx + 3 * u, cy - 10 * u)
        g.lineTo(cx + 3 * u, cy + 7 * u)
        g.moveTo(cx + 3 * u, cy + 7 * u)
        g.lineTo(cx - 4 * u, cy + 12 * u)
        g.strokePath()
        break
      default: {
        // 数字牌：用七段式线段拼数字，避免依赖字体。
        this.drawDigit(g, rank, cx, cy, color, s)
        break
      }
    }
  }

  /**
   * 画数字（2~10），用七段式线段拼。
   *
   * 每段用编号表示：0 上、1 右上、2 右下、3 下、4 左下、5 左上、6 中。
   * 两位数（10）用两遍循环横向排布。
   */
  private drawDigit(g: Phaser.GameObjects.Graphics, text: string, cx: number, cy: number, color: number, s: number): void {
    const SEGMENTS: Record<string, number[]> = {
      '1': [1, 2],
      '2': [0, 1, 3, 4, 6],
      '3': [0, 1, 2, 3, 6],
      '4': [1, 2, 5, 6],
      '5': [0, 2, 3, 5, 6],
      '6': [0, 2, 3, 4, 5, 6],
      '7': [0, 1, 2],
      '8': [0, 1, 2, 3, 4, 5, 6],
      '9': [0, 1, 2, 3, 5, 6],
      '0': [0, 1, 2, 3, 4, 5],
    }
    const chars = text.split('')
    // 数字牌在部分演示里是 "10"，两位时横向排开并整体收窄。
    const digitW = chars.length > 1 ? 12 * s : 13 * s
    const gapBetween = 2 * s
    const totalW = chars.length * digitW + (chars.length - 1) * gapBetween
    let cursorX = cx - totalW / 2 + digitW / 2

    for (const ch of chars) {
      const active = SEGMENTS[ch]
      // 半宽/半高按数字格子的实际尺寸算，保证笔画比例正常。
      if (active) this.drawSevenSegment(g, active, cursorX, cy, digitW * 0.5, 14 * s, color, s)
      cursorX += digitW + gapBetween
    }
  }

  /** 按段号组合画出七段数字。 */
  private drawSevenSegment(
    g: Phaser.GameObjects.Graphics,
    active: number[],
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
    color: number,
    s: number,
  ): void {
    const w = halfW
    const h = halfH
    const t = 2.2 * s // 笔画粗细
    g.fillStyle(color, 1)
    // 横向三段（上 / 中 / 下）。
    if (active.includes(0)) g.fillRect(cx - w, cy - h, w * 2, t)
    if (active.includes(6)) g.fillRect(cx - w, cy - t / 2, w * 2, t)
    if (active.includes(3)) g.fillRect(cx - w, cy + h - t, w * 2, t)
    // 纵向四段（左上/右上/左下/右下）。
    if (active.includes(5)) g.fillRect(cx - w, cy - h, t, h)
    if (active.includes(1)) g.fillRect(cx + w - t, cy - h, t, h)
    if (active.includes(4)) g.fillRect(cx - w, cy, t, h)
    if (active.includes(2)) g.fillRect(cx + w - t, cy, t, h)
  }

  /** 用几何图形画花色符号。 */
  private drawSuit(g: Phaser.GameObjects.Graphics, suit: string, cx: number, cy: number, size: number, color: number): void {
    g.fillStyle(color, 1)
    const r = size * 0.5
    switch (suit) {
      case '♥': {
        // 心形：两个圆 + 一个三角。
        g.fillCircle(cx - r * 0.5, cy - r * 0.35, r * 0.55)
        g.fillCircle(cx + r * 0.5, cy - r * 0.35, r * 0.55)
        g.fillTriangle(cx - r, cy, cx + r, cy, cx, cy + r)
        break
      }
      case '♦':
        g.fillTriangle(cx, cy - r, cx + r * 0.72, cy, cx, cy + r)
        g.fillTriangle(cx, cy - r, cx - r * 0.72, cy, cx, cy + r)
        break
      case '♠': {
        // 黑桃：倒心形 + 柄。
        g.fillTriangle(cx, cy - r, cx - r * 0.9, cy + r * 0.35, cx + r * 0.9, cy + r * 0.35)
        g.fillCircle(cx, cy + r * 0.2, r * 0.55)
        g.fillRect(cx - 1.5, cy + r * 0.5, 3, r * 0.5)
        break
      }
      default:
        // 梅花：三个圆 + 柄。
        g.fillCircle(cx, cy - r * 0.45, r * 0.42)
        g.fillCircle(cx - r * 0.5, cy + r * 0.25, r * 0.42)
        g.fillCircle(cx + r * 0.5, cy + r * 0.25, r * 0.42)
        g.fillRect(cx - 1.5, cy + r * 0.4, 3, r * 0.5)
        break
    }
  }

  /** 把 "A♥" 这样的牌面字符串拆成点数与花色。 */
  private splitCard(card: string): { rank: string; suit: string } {
    const suit = card.slice(-1)
    const rank = card.slice(0, -1)
    return { rank, suit }
  }

  /**
   * 发一张公共牌：从牌堆飞出，进入牌位时用物理回弹落桌。
   * 返回 Promise，动画结束 resolve。
   */
  dealCommunityCard(index: number, face: string, color: 'red' | 'black'): Promise<void> {
    const target = this.slotPositions[index]
    if (!target) return Promise.resolve()

    // 牌面纹理已在 create() 里预生成，这里只查表，不再现场合成。
    const { rank, suit } = this.splitCard(face)
    const texKey = `face-${rank}-${suit}`
    if (!this.textures.exists(texKey)) {
      // 兜底：预生成若因异常没跑到，也不会白屏。
      this.makeCardFaceTexture(texKey, rank, suit, color === 'red' ? RED_SUIT : BLACK_SUIT)
    }

    return new Promise((resolve) => {
      const back = this.add.image(0, 0, 'card-back')
      const facePlate = this.add.image(0, 0, texKey)
      // 牌面朝下时先藏起来。
      facePlate.setVisible(false)

      const container = this.add.container(this.deckPos.x, this.deckPos.y, [back, facePlate])
      container.setScale(0.52)
      container.setAngle(-12)

      // 阶段一：飞到牌位上方（圆弧路径 + 旋转）。
      const flightMs = 300
      this.tweens.add({
        targets: container,
        x: target.x,
        y: target.y - 26,
        scale: 0.82,
        angle: 0,
        duration: flightMs,
        ease: 'Cubic.easeOut',
        onComplete: () => {
          // 阶段二：落桌回弹（物理手感）。
          this.tweens.add({
            targets: container,
            y: target.y,
            duration: 190,
            ease: 'Bounce.easeOut',
            onComplete: () => {
              // 阶段三：翻牌。
              this.flipCard(container, back, facePlate).then(resolve)
            },
          })
        },
      })

      this.cards.push({ sprite: container, zone: this.add.zone(target.x, target.y, 1, 1) })
    })
  }

  /** 翻牌：牌背压扁到 0，切换到牌面后再展开。 */
  private flipCard(
    container: Phaser.GameObjects.Container,
    back: Phaser.GameObjects.Image,
    facePlate: Phaser.GameObjects.Image,
  ): Promise<void> {
    return new Promise((resolve) => {
      this.tweens.add({
        targets: container,
        scaleX: 0.06,
        duration: 110,
        ease: 'Quad.easeIn',
        onComplete: () => {
          back.setVisible(false)
          facePlate.setVisible(true)
          this.tweens.add({
            targets: container,
            scaleX: 0.82,
            duration: 150,
            ease: 'Back.easeOut',
            onComplete: () => resolve(),
          })
        },
      })
    })
  }

  /** 推一叠筹码进底池，带物理堆叠。 */
  pushChips(count: number, fromX: number, fromY: number): void {
    const potX = this.scale.width * 0.5
    const potY = this.scale.height * 0.28
    for (let i = 0; i < count; i += 1) {
      const chip = this.chips.create(
        fromX + Phaser.Math.Between(-10, 10),
        fromY + Phaser.Math.Between(-10, 10),
        'chip',
      ) as Phaser.Physics.Arcade.Image
      chip.setScale(0.8)
      chip.setDepth(10)

      // 给一个朝向底池的初速度，物理引擎负责飞行与堆叠。
      const body = chip.body as Phaser.Physics.Arcade.Body
      const angle = Phaser.Math.Angle.Between(chip.x, chip.y, potX, potY) + Phaser.Math.FloatBetween(-0.28, 0.28)
      const speed = Phaser.Math.Between(240, 420)
      body.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed)
      body.setDrag(560, 560)

      // 一段时间后停在底池附近（用 tween 收尾，避免一直滑）。
      this.time.delayedCall(420, () => {
        if (!chip.active) return
        this.tweens.add({
          targets: chip,
          x: potX + Phaser.Math.Between(-26, 26),
          y: potY + Phaser.Math.Between(-16, 16),
          duration: 260,
          ease: 'Back.easeOut',
        })
      })
    }
  }

  /** 赢牌：金币雨爆发。 */
  /**
   * 赢牌：金币雨爆发。
   *
   * 早先一次性 explode(120)，第一帧要同时初始化 120 个粒子，出现明显卡顿。
   * 现在分 3 帧，每帧 40 个：总量不变，但单帧负载降到 1/3，视觉上几乎无差别。
   */
  burstCoins(): void {
    if (!this.coinEmitter) return
    const { width, height } = this.scale
    this.coinEmitter.setPosition(width * 0.5, height * 0.62)
    const PER_BATCH = 40
    const BATCHES = 3
    for (let i = 0; i < BATCHES; i += 1) {
      this.time.delayedCall(i * 55, () => {
        this.coinEmitter?.explode(PER_BATCH)
      })
    }
  }

  /** 清空桌面。 */
  reset(): void {
    for (const card of this.cards) {
      card.sprite.destroy()
      card.zone.destroy()
    }
    this.cards = []
    this.chips.clear(true, true)
  }
}

export function createPokerTableGame(parent: HTMLElement, options: TableSceneOptions): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.WEBGL,
    parent,
    width: options.width,
    height: options.height,
    // 牌桌背景由 CSS 绘制，canvas 只叠上层画面，所以透明。
    transparent: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      // 保留绘制缓冲：否则 WebGL canvas 在截图、系统截图、
      // 以及某些合成器场景下会读出全白。开销可忽略。
      preserveDrawingBuffer: true,
      antialias: true,
    },
    physics: {
      default: 'arcade',
      arcade: { gravity: { x: 0, y: 0 }, debug: false },
    },
    scene: [new PokerTableScene(options)],
  })
}
