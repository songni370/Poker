/**
 * 音频引擎：AudioContext 生命周期、主音量、自动播放解锁。
 *
 * 浏览器策略：AudioContext 必须在用户手势里创建/恢复，否则一直是 suspended。
 * 因此引擎默认不主动建上下文，等 `unlock()` 被用户点击触发。
 */

let context: AudioContext | null = null
/** 主增益：所有音效与 BGM 都挂在这里，方便统一压限。 */
let masterGain: GainNode | null = null

export const MASTER_VOLUME = 0.5

/** 取得（必要时创建）音频上下文；除非已解锁过，否则返回 null。 */
export function getContext(): AudioContext | null {
  return context
}

/** 主输出节点：音效与 BGM 的最终汇合点。 */
export function getMaster(): GainNode | null {
  return masterGain
}

/**
 * 在用户手势里调用一次，创建并恢复上下文。
 * 重复调用是安全的：已解锁时只做一次 resume。
 */
export function unlock(): AudioContext | null {
  // Safari 早期版本只有 webkitAudioContext，优先用标准名，再退回前缀名。
  const legacy = (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : legacy
  if (!Ctor) return null

  if (!context) {
    context = new Ctor()
    masterGain = context.createGain()
    masterGain.gain.value = MASTER_VOLUME
    masterGain.connect(context.destination)
  }
  if (context.state === 'suspended') void context.resume()
  return context
}

/**
 * 页面从后台回到前台时调用：iOS Safari 会把上下文挂起，
 * 不恢复的话之后所有音效都会静默丢失。
 */
export function resumeIfNeeded(): void {
  if (context && context.state === 'suspended') void context.resume()
}

/** 当前时间轴上“现在”的时刻，供各合成器排程。 */
export function now(): number {
  return context?.currentTime ?? 0
}
