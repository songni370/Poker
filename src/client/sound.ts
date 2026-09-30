import { ref, watch } from 'vue'

/**
 * 提示音开关与极简合成器。
 *
 * 不引入任何音频素材（避免第三方资产与许可问题），用 Web Audio 现场合成两声短提示。
 * 浏览器要求音频必须由用户手势开启，因此默认关闭，由用户点按钮打开；
 * 开关状态存在 localStorage，刷新后保留。
 */
const STORAGE_KEY = 'poker.sound'

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

export const soundEnabled = ref(readStored())

watch(soundEnabled, (value) => {
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off')
  } catch {
    // 隐私模式忽略
  }
})

let context: AudioContext | null = null

function ensureContext(): AudioContext | null {
  if (!soundEnabled.value) return null
  if (typeof AudioContext === 'undefined') return null
  context ??= new AudioContext()
  if (context.state === 'suspended') void context.resume()
  return context
}

/** 用户在按钮上点击时调用一次，解锁音频上下文（自动播放策略要求手势）。 */
export function unlockAudio(): void {
  ensureContext()
}

function tone(frequency: number, startAt: number, durationMs: number, gain: number): void {
  const audio = ensureContext()
  if (!audio) return
  const oscillator = audio.createOscillator()
  const volume = audio.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.value = frequency
  volume.gain.setValueAtTime(0, audio.currentTime + startAt)
  volume.gain.linearRampToValueAtTime(gain, audio.currentTime + startAt + 0.01)
  volume.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + startAt + durationMs / 1000)
  oscillator.connect(volume).connect(audio.destination)
  oscillator.start(audio.currentTime + startAt)
  oscillator.stop(audio.currentTime + startAt + durationMs / 1000 + 0.02)
}

/** 轮到你行动：两声上行短音。 */
export function playYourTurn(): void {
  tone(660, 0, 120, 0.05)
  tone(880, 0.13, 140, 0.05)
}

/** 结算 / 新消息：单声轻提示。 */
export function playPing(): void {
  tone(520, 0, 110, 0.04)
}
