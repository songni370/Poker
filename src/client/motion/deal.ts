/**
 * 发牌动画：牌从牌堆中心沿弧线飞到目标位置。
 *
 * 实现方式用 requestAnimationFrame 直接改 transform，而不是 CSS keyframes，
 * 因为弧线路径需要逐帧算坐标（CSS 插值只能做直线或固定路径）。
 *
 * 性能要点：
 * - 只改 transform 与 opacity / filter，不碰 layout 属性，保证走合成层。
 * - 每张牌一个独立 rAF 循环，牌数少（最多 5 + 2×人数 ≈ 20 张），开销可忽略。
 */

import { DURATION, arcPoint, easeInOutCubic } from './timing.ts'

export interface Point {
  x: number
  y: number
}

export interface FlightOptions {
  /** 起点的屏幕坐标。 */
  from: Point
  /** 终点的屏幕坐标。 */
  to: Point
  /** 飞行时长，默认 DURATION.dealFly。 */
  duration?: number
  /** 弧线弯曲程度。 */
  arc?: number
  /** 起始旋转角度（度）。 */
  fromRotate?: number
  /** 结束旋转角度（度）。 */
  toRotate?: number
  /** 起始缩放。 */
  fromScale?: number
}

/**
 * 让一个元素从 from 飞到 to，返回 Promise（动画结束 resolve）。
 * 调用方负责保证元素已进入布局（否则 getBoundingClientRect 拿不到位置）。
 *
 * 性能关键：每帧只写 transform 与 opacity。
 * 绝不能在这里逐帧改 filter / box-shadow —— 那会让合成层失效、
 * 每帧重新栅格化整张牌，是掉帧的头号原因（阴影交给 CSS 静态控制）。
 */
export function flyTo(element: HTMLElement, options: FlightOptions): Promise<void> {
  const { from, to, duration = DURATION.dealFly, arc = 0.22, fromRotate = -18, toRotate = 0, fromScale = 0.72 } = options

  // 提前声明合成层，避免第一帧才提升导致抖动。
  element.style.willChange = 'transform, opacity'

  return new Promise((resolve) => {
    const start = performance.now()

    const frame = (now: number): void => {
      const elapsed = now - start
      const raw = Math.min(1, elapsed / duration)
      const t = easeInOutCubic(raw)
      const point = arcPoint(from, to, t, arc)

      // 飞行过程中带一点缩放与旋转，落位时归零。
      const scale = fromScale + (1 - fromScale) * t
      const rotate = fromRotate + (toRotate - fromRotate) * t

      element.style.transform = `translate3d(${String(point.x)}px, ${String(point.y)}px, 0) rotate(${String(rotate)}deg) scale(${String(scale)})`
      // opacity 单独一档，避免和 transform 抢同一帧的样式解析。
      element.style.opacity = raw < 0.12 ? String(raw / 0.12) : '1'

      if (raw < 1) {
        requestAnimationFrame(frame)
      } else {
        // 清掉内联样式，交还 CSS 控制，避免污染后续状态。
        element.style.transform = ''
        element.style.opacity = ''
        element.style.willChange = ''
        resolve()
      }
    }

    requestAnimationFrame(frame)
  })
}

/** 等待指定毫秒。 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 元素的中心点（相对视口）。
 * 用于计算飞行起点 / 终点：牌要"从牌堆飞到这里"，必须知道真实屏幕坐标。
 */
export function centerOf(element: Element | null): Point | null {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/**
 * 相对位移：目标中心减去元素当前中心。
 * flyTo 第 i 帧的 translate 是相对自身原始位置的偏移，所以起点需要换算成差值。
 */
export function offsetBetween(from: Point, to: Point): Point {
  return { x: from.x - to.x, y: from.y - to.y }
}
