/**
 * 动效编排的时间常量与工具。
 *
 * 核心原则：动效总时长必须压在 700ms 以内，否则玩家会觉得"卡"。
 * 所有时长集中在这里，方便统一调速，也方便测试断言。
 */

/** 动效总预算：超过这个数就是"游戏感"变成"拖沓"的分界线。 */
export const MOTION_BUDGET_MS = 700

export const DURATION = {
  /** 牌从牌堆飞到位（弧线飞行）。 */
  dealFly: 280,
  /** 牌翻面。 */
  flip: 340,
  /** 筹码飞向底池。 */
  chipFly: 260,
  /** 筹码从底池飞向赢家。 */
  chipAward: 320,
  /** 底池数字滚动计数。 */
  potCount: 420,
  /** 赢牌金币雨总时长。 */
  confetti: 1400,
  /** 桌面轻微震动。 */
  tableShake: 180,
} as const

/** 错峰间隔：多张牌连续发出时，每张之间的间隔。 */
export const STAGGER = {
  /** 翻牌三张。 */
  flop: 70,
  /** 发给多个玩家的底牌。 */
  hole: 55,
}

/**
 * 二次贝塞尔弧线取点：模拟牌"抛"出去而不是直线滑过去。
 *
 * 纯直线飞行看起来很机械；加一个垂直方向的弧度，落点会带出"被发牌员甩出去"的感觉。
 * t 从 0（起点）到 1（终点），弧度大小由 arc 控制，正值向下方弯曲。
 */
export function arcPoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
  t: number,
  arc = 0.22,
): { x: number; y: number } {
  // 控制点取中点并沿垂直方向偏移，形成一条抛物线弧。
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  // 垂直方向单位向量的法线：让弧线向着"下"弯（牌被甩出去会先上扬再落下）。
  const control = {
    x: midX + (-dy / len) * len * arc,
    y: midY + (dx / len) * len * arc,
  }
  // 二阶贝塞尔公式。
  const inv = 1 - t
  return {
    x: inv * inv * from.x + 2 * inv * t * control.x + t * t * to.x,
    y: inv * inv * from.y + 2 * inv * t * control.y + t * t * to.y,
  }
}

/** 缓动：先快后慢，落点有"咬住"的干脆感。 */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/** 缓动：两端慢中间快，适合飞行。 */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** 缓动：带一点回弹，适合筹码落地。 */
export function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

/** 用户是否要求减少动效（系统级无障碍设置）。 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
