import { RANKS, SUITS, type Card } from '../shared/poker.ts'

/** 均匀分布于 [0, 1) 的随机源；生产注入密码学安全实现，测试注入确定性种子。 */
export type Rng = () => number

export function createDeck(): Card[] {
  const deck: Card[] = []
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(`${rank}${suit}`)
  }
  return deck
}

/** Fisher–Yates，无偏洗牌；不改动入参数组。 */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/** 生产环境随机源：系统级密码学安全随机数。 */
export function cryptoRng(): Rng {
  return () => {
    const buffer = new Uint32Array(1)
    crypto.getRandomValues(buffer)
    return buffer[0]! / 2 ** 32
  }
}

/** 确定性随机源（mulberry32），仅用于测试复现。 */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
