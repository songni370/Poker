/**
 * 音色合成：全部用 Web Audio 现场生成，不引入任何音频素材。
 *
 * 设计原则：
 * - 短：单个音效几乎都不超过 0.35s，扑克是高频重复场景，长了会糊。
 * - 软：主输出 0.5、单个音效峰值 0.02～0.12，避免在耳机里刺耳。
 * - 有层次：高频金属噪（筹码）、低频短促（推筹码）、带滤波的噪声（发牌）。
 */

import { getContext, getMaster } from './engine.ts'

/** 创建一段白噪声缓冲；duration 控长，避免每次重算。 */
function noiseBuffer(ctx: AudioContext, duration: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration))
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1
  return buffer
}

/**
 * 筹码碰撞：两个略微失谐的高频正弦 + 一小段噪声瞬态。
 * toneHz 由金额换算（小注偏高、大注偏低），让“下注越大声音越沉”。
 */
export function chip(toneHz = 2400, gain = 1): void {
  const ctx = getContext()
  const master = getMaster()
  if (!ctx || !master) return
  const t0 = ctx.currentTime
  const out = ctx.createGain()
  out.gain.value = 0.075 * gain
  out.connect(master)

  // 两个失谐正弦，模拟金属片的非谐波感。
  for (const [freq, level] of [
    [toneHz, 1],
    [toneHz * 1.47, 0.55],
  ] as const) {
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, t0)
    env.gain.setValueAtTime(0, t0)
    env.gain.linearRampToValueAtTime(level, t0 + 0.004)
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13)
    osc.connect(env).connect(out)
    osc.start(t0)
    osc.stop(t0 + 0.16)
  }

  // 瞬态噪声：筹码落桌的“嗒”。
  const noise = ctx.createBufferSource()
  noise.buffer = noiseBuffer(ctx, 0.06)
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = 3600
  band.Q.value = 1.2
  const nEnv = ctx.createGain()
  nEnv.gain.setValueAtTime(0.5, t0)
  nEnv.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05)
  noise.connect(band).connect(nEnv).connect(out)
  noise.start(t0)
}

/** 一串筹码：推注时用 2～4 颗渐弱的小筹码表示金额大小。 */
export function chips(count: number): void {
  const ctx = getContext()
  if (!ctx) return
  const n = Math.max(1, Math.min(4, count))
  for (let i = 0; i < n; i += 1) {
    // 用 AudioContext 时间轴排程会有竞态，这里用极短递增的伪随机间隔排在同一帧之后。
    const delay = i * 55 + Math.random() * 20
    setTimeout(() => chip(2600 + Math.random() * 400, 0.85 - i * 0.15), delay)
  }
}

/** 发牌：一段经过带通滤波的噪声，像纸牌擦过桌面。 */
export function deal(): void {
  const ctx = getContext()
  const master = getMaster()
  if (!ctx || !master) return
  const t0 = ctx.currentTime
  const out = ctx.createGain()
  out.gain.value = 0.06
  out.connect(master)

  const noise = ctx.createBufferSource()
  noise.buffer = noiseBuffer(ctx, 0.18)
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.setValueAtTime(1800, t0)
  band.frequency.exponentialRampToValueAtTime(5200, t0 + 0.14)
  band.Q.value = 0.9
  const env = ctx.createGain()
  env.gain.setValueAtTime(0, t0)
  env.gain.linearRampToValueAtTime(1, t0 + 0.02)
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16)
  noise.connect(band).connect(env).connect(out)
  noise.start(t0)
}

/** 过牌敲桌：两下低频、干爽的敲击。 */
export function knock(): void {
  const ctx = getContext()
  const master = getMaster()
  if (!ctx || !master) return
  const t0 = ctx.currentTime
  for (const offset of [0, 0.11]) {
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(190, t0 + offset)
    osc.frequency.exponentialRampToValueAtTime(95, t0 + offset + 0.09)
    env.gain.setValueAtTime(0, t0 + offset)
    env.gain.linearRampToValueAtTime(0.09, t0 + offset + 0.005)
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.12)
    osc.connect(env).connect(master)
    osc.start(t0 + offset)
    osc.stop(t0 + offset + 0.14)
  }
}

/** 弃牌：一声轻、短的“沙”，暗示牌被丢掉。 */
export function fold(): void {
  const ctx = getContext()
  const master = getMaster()
  if (!ctx || !master) return
  const t0 = ctx.currentTime
  const noise = ctx.createBufferSource()
  noise.buffer = noiseBuffer(ctx, 0.12)
  const low = ctx.createBiquadFilter()
  low.type = 'lowpass'
  low.frequency.value = 900
  const env = ctx.createGain()
  env.gain.setValueAtTime(0.05, t0)
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1)
  noise.connect(low).connect(env).connect(master)
  noise.start(t0)
}

/** 轮到你行动：两声上行，但不刺耳（正弦 + 平滑包络）。 */
export function yourTurn(): void {
  tone(660, 0, 120, 0.05)
  tone(880, 0.13, 140, 0.05)
}

/** 赢下底池：三音上行琶音，比普通提示更明确。 */
export function win(): void {
  tone(523, 0, 110, 0.06)
  tone(659, 0.10, 110, 0.06)
  tone(784, 0.20, 220, 0.07)
}

/** 通用轻提示（聊天、结算）。 */
export function ping(): void {
  tone(520, 0, 110, 0.04)
}

/** 思考时间告急：一声短促、偏高但音量很小的滴。 */
export function tick(): void {
  tone(1050, 0, 45, 0.022)
}

/** 在音效总线上排一个正弦短音。 */
function tone(frequency: number, startAt: number, durationMs: number, gain: number): void {
  const ctx = getContext()
  const master = getMaster()
  if (!ctx || !master) return
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = frequency
  const at = ctx.currentTime + startAt
  env.gain.setValueAtTime(0, at)
  env.gain.linearRampToValueAtTime(gain, at + 0.01)
  env.gain.exponentialRampToValueAtTime(0.0001, at + durationMs / 1000)
  osc.connect(env).connect(master)
  osc.start(at)
  osc.stop(at + durationMs / 1000 + 0.02)
}
