/**
 * 循环 BGM：用合成器现场生成的氛围铺底，不用音频文件。
 *
 * 风格取向：爵士/氛围感的小调九和弦进行，低音量、无鼓点、无强旋律，
 * 目的是"有氛围但不抢注意力"。德州扑克的 BGM 一响就吵是最常见的失败，
 * 所以这里刻意做三件事：
 * 1. 只用 pad（慢起慢落的长音），不用节拍。
 * 2. 每小节换和弦，靠轻微的声部移动制造"时间里在发生什么"的感觉。
 * 3. 整体压在 -32dB 左右，明显在音效之下。
 *
 * 调度方式：用 setInterval 每小节排下一小节的和弦，
 * 而不是一次性排完整段——曲子长度由和弦表循环长度决定，内存恒定。
 */

import { getContext, getMaster, now } from './engine.ts'

/** BGM 相对主音量的额外衰减（主音量 0.5 之上再压这个值）。 */
export const BGM_VOLUME = 0.075
/** 每小节时长（秒）：52 BPM 的 4/4 一拍约 1.15s。 */
const BAR_SECONDS = 4.6
/**
 * 和弦进行（频率 Hz）。选的是 A 小调附近的爵士和声：
 * Am9 → Fmaj7 → Dm9 → E7sus4，循环起来松弛、不上扬，适合长时间听。
 */
const PROGRESSION: readonly (readonly number[])[] = [
  [110.0, 164.81, 196.0, 261.63], // Am9 铺底
  [87.31, 130.81, 174.61, 220.0], // Fmaj7
  [73.42, 146.83, 174.61, 220.0], // Dm9
  [82.41, 123.47, 164.81, 196.0], // E7sus4
]

let bgmGain: GainNode | null = null
let timer: ReturnType<typeof setInterval> | null = null
let barIndex = 0
let playing = false

/** 当前是否正在播放 BGM。 */
export function isBgmPlaying(): boolean {
  return playing
}

/** 排一个小节的 pad：每个和弦音一条振荡器，慢起慢落，互相交叠成铺底。 */
function scheduleBar(gain: GainNode, tones: readonly number[], startAt: number): void {
  const ctx = getContext()
  if (!ctx) return
  const barEnd = startAt + BAR_SECONDS + 0.9

  tones.forEach((freq, i) => {
    for (const detune of [-4, 4]) {
      const osc = ctx.createOscillator()
      const env = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.detune.value = detune
      // 每小节只让部分声部换音，制造轻微的声部游走而不是整块和弦一起跳。
      const level = 0.055 / (1 + i * 0.35)
      const attackEnd = startAt + 1.6
      env.gain.setValueAtTime(0, startAt)
      env.gain.linearRampToValueAtTime(level, attackEnd)
      env.gain.setValueAtTime(level, barEnd - 1.4)
      env.gain.linearRampToValueAtTime(0, barEnd)
      osc.connect(env).connect(gain)
      osc.start(startAt)
      osc.stop(barEnd + 0.05)
    }
  })
}

/** 开始 BGM；需要先 unlock()，否则上下文不存在直接返回。 */
export function startBgm(): void {
  const ctx = getContext()
  const master = getMaster()
  if (!ctx || !master || playing) return

  if (!bgmGain) {
    bgmGain = ctx.createGain()
    bgmGain.gain.value = BGM_VOLUME
    // 低通滤掉高频泛音，pad 更"糊"更不刺耳。
    const low = ctx.createBiquadFilter()
    low.type = 'lowpass'
    low.frequency.value = 900
    bgmGain.connect(low).connect(master)
  } else {
    bgmGain.gain.setTargetAtTime(BGM_VOLUME, ctx.currentTime, 0.4)
  }

  playing = true
  barIndex = 0
  const gain = bgmGain
  // 立刻排第一小节，之后每小节提前排一次（留 0.6s 余量避免边界空档）。
  scheduleBar(gain, PROGRESSION[0]!, ctx.currentTime + 0.1)
  barIndex = 1
  timer = setInterval(() => {
    const audio = getContext()
    if (!audio || !bgmGain) return
    // 提前 0.6s 排下一小节，落在它该开始的时间点上。
    scheduleBar(bgmGain, PROGRESSION[barIndex % PROGRESSION.length]!, audio.currentTime + 0.6)
    barIndex += 1
  }, Math.round((BAR_SECONDS - 0.6) * 1000))
}

/** 停止 BGM：淡出后清掉定时器，再补一句真正的静音。 */
export function stopBgm(): void {
  const ctx = getContext()
  playing = false
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  if (!bgmGain || !ctx) return
  // 只把总增益推到 0：已经排程的振荡器会自然衰减结束，不需要逐个掐断。
  bgmGain.gain.setTargetAtTime(0, ctx.currentTime, 0.25)
}

/** 供进度/调试观察：BGM 已经过了多少个小节。 */
export function currentBar(): number {
  return barIndex
}

/** 时间基准（测试与排程用）。 */
export { now }
