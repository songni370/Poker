/**
 * 下注/加注的额度换算（纯函数，无 Vue 依赖，便于单测）。
 *
 * 单独抽出来的原因：ActionBar 里的「快捷额度」必须严格夹在服务端给的合法区间内，
 * 而这件事只靠肉眼看界面验证不了。抽成纯函数后可以直接断言
 * 「理想值越界时按钮禁用、按钮上的数值一定落在 [min, max] 内」。
 *
 * 语义与协议保持一致：bet / raise 的 amount 是**目标总额**（不是增量），
 * 所以按底池比例算出来的额度要先补上跟注额，再加比例部分。
 */

/** 唯一的取整 + 边界函数：数字输入、滑块、快捷额度与提交动作共用，避免两套算法。 */
export function clampAmount(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max)
}

export interface BetSizingInput {
  /** 服务端 legalActions 里给的合法下注/加注区间。 */
  min: number
  max: number
  /** 底池总额（已含本轮所有人投入的筹码）。 */
  potTotal: number
  /** 跟注需要补的筹码；没有跟注动作时传 0。 */
  callAmount: number
  /** 下注还是加注：只影响禁用提示里的名词（最小下注 / 最小加注）。 */
  action: 'bet' | 'raise'
}

export interface QuickSize {
  key: string
  /** 按钮上的小标签：1/2、2/3、满池、超池（与 en 同源，供纯逻辑断言用）。 */
  label: string
  /** 按钮主文本（英文，官方叫法）：1/2 POT / 2/3 POT / POT / OVERBET。 */
  en: string
  /** 按钮辅助文本（中文小字）：半池 / 2/3 池 / 满池 / 超池。 */
  zh: string
  /** 无障碍与提示里用的完整说法。 */
  desc: string
  /** 实际写进输入框的值：永远落在 [min, max] 内，服务端不会拒。 */
  value: number
  /** 理想值越界 → 禁用，不允许「点了一个数、实际下了另一个数」。 */
  disabled: boolean
  /** 禁用原因（越界的哪一侧）；可用时为空串。 */
  reason: string
  /** 按钮 / 外层容器的 title。 */
  title: string
}

/**
 * 快捷额度档位：英文主文本 + 中文小字 + 相对「跟注后底池」的倍数（1 = 满池，1.5 = 超池）。
 * 与动作按钮（FOLD 弃牌 / CALL 跟注）共用一套「英文主 + 中文辅」的排版。
 */
const QUICK_LEVELS = [
  { key: 'half', label: '1/2', en: '1/2 POT', zh: '半池', desc: '1/2 底池', ratio: 0.5 },
  { key: 'twoThirds', label: '2/3', en: '2/3 POT', zh: '2/3 池', desc: '2/3 底池', ratio: 2 / 3 },
  { key: 'pot', label: 'POT', en: 'POT', zh: '满池', desc: '满池（等于底池）', ratio: 1 },
  { key: 'over', label: 'OVERBET', en: 'OVERBET', zh: '超池', desc: '超池（1.5 倍底池）', ratio: 1.5 },
] as const

/**
 * 四个快捷档位。底池取「跟注之后」的总额（与引擎的最小加注口径一致），
 * 理想值超出 [min, max] 时把按钮禁用并在 title 里说清差在哪——
 * 悄悄夹到边界会让按钮写的「超池」和实际下的注对不上，等于骗用户点一下。
 */
export function quickSizes(input: BetSizingInput): QuickSize[] {
  const noun = input.action === 'bet' ? '下注' : '加注'
  const potAfterCall = input.potTotal + input.callAmount
  return QUICK_LEVELS.map((level) => {
    const ideal = Math.round(input.callAmount + potAfterCall * level.ratio)
    const value = clampAmount(ideal, input.min, input.max)
    const base = {
      key: level.key,
      label: level.label,
      en: level.en,
      zh: level.zh,
      desc: level.desc,
      value,
    }
    if (ideal < input.min) {
      const reason = `低于最小${noun} ${String(input.min)}`
      return { ...base, disabled: true, reason, title: `${level.desc} = ${String(ideal)}，${reason}，已禁用` }
    }
    if (ideal > input.max) {
      const reason = `超过上限 ${String(input.max)}`
      return { ...base, disabled: true, reason, title: `${level.desc} = ${String(ideal)}，${reason}，已禁用` }
    }
    return { ...base, disabled: false, reason: '', title: `${level.desc} = ${String(value)}` }
  })
}
