/**
 * 音效系统对外入口。
 *
 * 状态：`soundEnabled`（音效）与 `bgmEnabled`（背景音乐）分开存、分开控制，
 * 因为很多人想留音效但不想听 BGM。两个开关都持久化到 localStorage。
 *
 * 默认值（用户反馈「没有音效」的根因就是默认关闭）：
 * - 音效默认开启：首次访问没有 `poker.sound` 记录时为 true；
 *   用户手动关过（记录为 'off'）则尊重选择，不强制打开。
 * - 背景音乐默认关闭：避免一进房间就被音乐打扰。
 *
 * 播放约束：
 * - 必须由用户手势调用 `unlockAudio()` 后才能出声（浏览器策略）；
 *   牌桌页会在第一次 pointerdown / keydown 时自动解锁一次。
 * - 同一种音效在极短时间内重复触发会被限流，避免多人快速动作时糊成一团。
 */

import { ref, watch } from 'vue'
import { getContext, resumeIfNeeded, unlock } from './engine.ts'
import { isBgmPlaying, startBgm, stopBgm } from './bgm.ts'
import * as synth from './synth.ts'

const SOUND_KEY = 'poker.sound'
const BGM_KEY = 'poker.bgm'

/**
 * 音效开关的默认值策略（纯函数，便于单测）：
 * - 没有记录：首次访问，默认开启；
 * - 'on' / 'off'：尊重用户的显式选择。
 */
export function resolveSoundDefault(stored: string | null): boolean {
  return stored === null ? true : stored === 'on'
}

function readSoundEnabled(): boolean {
  try {
    return resolveSoundDefault(localStorage.getItem(SOUND_KEY))
  } catch {
    // 隐私模式等场景读不到 localStorage：默认开启，至少本次会话有声音。
    return true
  }
}

function readBgmEnabled(): boolean {
  try {
    return localStorage.getItem(BGM_KEY) === 'on'
  } catch {
    return false
  }
}

export const soundEnabled = ref(readSoundEnabled())
export const bgmEnabled = ref(readBgmEnabled())

function persist(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? 'on' : 'off')
  } catch {
    // 隐私模式忽略
  }
}

watch(soundEnabled, (value) => {
  persist(SOUND_KEY, value)
  if (value) unlock()
  else stopBgm()
  // 关掉全部声音时 BGM 理应一起停；单独关音效不影响 BGM 开关本身。
})

watch(bgmEnabled, (value) => {
  persist(BGM_KEY, value)
  if (value) {
    unlock()
    startBgm()
  } else {
    stopBgm()
  }
})

/**
 * 用户在按钮上点击时调用一次，解锁音频上下文（自动播放策略要求手势）。
 * 解锁后若 BGM 开关是开的，顺带把 BGM 拉起来。
 */
export function unlockAudio(): void {
  unlock()
  syncBgm()
}

/** 让 BGM 实际状态与开关对齐（解锁后、页面回前台时调用）。 */
export function syncBgm(): void {
  const shouldPlay = bgmEnabled.value && soundEnabled.value
  if (shouldPlay && !isBgmPlaying()) startBgm()
  if (!shouldPlay && isBgmPlaying()) stopBgm()
}

/** 页面重新可见时调用：iOS 挂起后需要恢复上下文并续上 BGM。 */
export function resumeAudio(): void {
  resumeIfNeeded()
  syncBgm()
}

/**
 * 音频上下文是否已经真正跑起来。
 * 用于首次手势解锁：某些手势（例如只按修饰键）不算用户激活，上下文仍会 suspended，
 * 此时调用方应保留监听，等下一个真正的手势再试一次。
 */
export function isAudioRunning(): boolean {
  return getContext()?.state === 'running'
}

/* ───────────────────────────── 限流 ───────────────────────────── */

/** 每种音效的最小触发间隔（毫秒），防止密集事件叠加成噪音。 */
const THROTTLE_MS: Record<string, number> = {
  chip: 45,
  deal: 120,
  knock: 180,
  fold: 150,
  tick: 900,
  yourTurn: 800,
  win: 600,
  ping: 250,
}

const lastPlayedAt = new Map<string, number>()

function allowed(name: string): boolean {
  if (!soundEnabled.value) return false
  const min = THROTTLE_MS[name] ?? 100
  const last = lastPlayedAt.get(name) ?? 0
  const at = Date.now()
  if (at - last < min) return false
  lastPlayedAt.set(name, at)
  return true
}

/* ───────────────────────────── 对局音效 ───────────────────────────── */

/** 公共牌 / 底牌发出。 */
export function playDeal(): void {
  if (allowed('deal')) synth.deal()
}

/** 下注、跟注、加注：金额越大，筹码越多、音调越低；all-in 级大注再多一声沉响。 */
export function playChips(amount: number): void {
  if (!allowed('chip')) return
  const huge = amount >= 1000
  const count = amount >= 400 ? 4 : amount >= 200 ? 3 : amount >= 80 ? 2 : 1
  // 大额下注用更低的音色，听感上"更重"。
  const baseHz = huge ? 2000 : amount >= 400 ? 2200 : amount >= 200 ? 2400 : 2700
  synth.chip(baseHz, huge ? 1.05 : 0.9)
  if (count > 1) setTimeout(() => synth.chips(count - 1), 40)
  // all-in / 超池级大注：补一声更低、更沉的落袋音，与普通加注区分开。
  if (huge) setTimeout(() => synth.chip(1500, 1.1), 130)
}

/** 过牌敲桌。 */
export function playCheck(): void {
  if (allowed('knock')) synth.knock()
}

/** 弃牌。 */
export function playFold(): void {
  if (allowed('fold')) synth.fold()
}

/** 轮到你行动。 */
export function playYourTurn(): void {
  if (allowed('yourTurn')) synth.yourTurn()
}

/** 赢下底池。 */
export function playWin(): void {
  if (allowed('win')) synth.win()
}

/** 通用轻提示（聊天、结算）。 */
export function playPing(): void {
  if (allowed('ping')) synth.ping()
}

/** 思考时间告急的滴答。 */
export function playTick(): void {
  if (allowed('tick')) synth.tick()
}

/** 仅供测试重置限流状态。 */
export function resetThrottle(): void {
  lastPlayedAt.clear()
}
