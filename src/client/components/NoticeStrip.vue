<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

/**
 * 顶栏与牌桌之间的细通知条。
 *
 * 为什么需要：
 *   牌桌中央原来有一个「浮动提示气泡」，只显示**最后一条**事件，而且永远不清空——
 *   别人重新连接、某人超时、上一手怎么结算的，看过一眼就再也找不回来了。
 *   这里把服务端下发的 notice 收集成一条极窄的信息带，自动消失，不抢桌面空间。
 *
 * 数据来源：`session.notice`（服务端每个状态事件都可以带 notice）。
 * 实测覆盖的事件：`xxx 已重新连接` / `xxx 加入了房间` / `xxx 断线（座位保留至本局结束）` /
 * `xxx 掉线超过宽限期，座位已释放` / `xxx 已离座（座位为你保留）` / `xxx 退出了房间` /
 * `xxx 已被主持人移出房间` / `第 N 手牌开始` / `第 N 手结算：赢家 +筹码（牌型）` /
 * `xxx 超时，系统自动过牌|弃牌`。
 *
 * 设计取舍（都是「不占位置」这一条的延伸）：
 *   - 高度：单行 24px；最多同时显示 2 条（两行 52px 已是上限），再多就丢掉最旧的；
 *   - 自动消失：每条 8 秒后淡出，不需要用户操作；
 *   - 时间戳：每条只在**广播后 8 秒内**才入队。断线重连拿到的快照里也带 notice，
 *     那是历史回放，不该在刚进桌时弹一堆已过期的消息；
 *   - 无障碍：这里刻意**不加** aria-live——牌桌上已经有一个 `sr-only` 的播报区，
 *     两处同时播报会把同一件事念两遍。可见文本 + 可聚焦的关闭按钮已足够。
 */
const props = withDefaults(
  defineProps<{
    /** 服务端最新下发的通知文本；空串表示没有新通知。 */
    notice?: string
    /** 自己的昵称：用来过滤「自己已重新连接」这类对自己没有意义的消息。 */
    myNickname?: string
    /**
     * 当前牌局状态版本号（`GameStatePublic.version`）。
     * 用它区分「历史回放」与「真实事件」：进桌/刷新时快照里带的 notice 与当时的版本号配对，
     * 只有**版本号已经变化**的 notice 才是进桌之后新发生的事（见下方 watch）。
     */
    version?: number
    /** 每条通知的存活时间（毫秒）。 */
    ttlMs?: number
    /** 最多同时显示几条。 */
    max?: number
  }>(),
  { notice: '', myNickname: '', version: 0, ttlMs: 8000, max: 2 },
)

interface StripNotice {
  key: number
  text: string
  tone: 'info' | 'warn' | 'settle'
  timer: ReturnType<typeof setTimeout>
}

const notices = ref<StripNotice[]>([])
let seq = 0

/** 按文案给一个很轻的色调：结算用金色、断线/超时这类需要留意的用橙色，其余中性。 */
function toneOf(text: string): StripNotice['tone'] {
  if (/结算|赢得|平分/.test(text)) return 'settle'
  if (/断线|掉线|超时|移出/.test(text)) return 'warn'
  return 'info'
}

/** 每条通知对应一个 emoji 图标（纯装饰，读屏只读文本）。 */
function iconOf(notice: StripNotice): string {
  if (notice.tone === 'settle') return '🏆'
  if (notice.tone === 'warn') return '⚠️'
  if (/重新连接|恢复了/.test(notice.text)) return '🔌'
  if (/加入了房间/.test(notice.text)) return '👋'
  if (/离座|退出了房间/.test(notice.text)) return '🚪'
  if (/第 \d+ 手牌开始/.test(notice.text)) return '🃏'
  return 'ℹ️'
}

function dismiss(key: number): void {
  const found = notices.value.find((item) => item.key === key)
  if (found) clearTimeout(found.timer)
  notices.value = notices.value.filter((item) => item.key !== key)
}

/**
 * 昵称还没到位时的暂存队列。
 * 进桌瞬间 `game.mySeat` 还是 null（自己尚未落座），此时到达的
 * `自己 已重新连接` 无法与「别人的重新连接」区分——先存 2 秒，
 * 等自己在座位表里出现后再复查一遍；超时仍未到位就照常播报（宁可多报，不可漏报）。
 */
let pending: { text: string; timer: ReturnType<typeof setTimeout> } | null = null

function push(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  // 同一条文本已经在屏幕上就不再重复（例如自己连续两次收到同一句系统提示）。
  if (notices.value.some((item) => item.text === trimmed)) return
  const item: StripNotice = {
    key: (seq += 1),
    text: trimmed,
    tone: toneOf(trimmed),
    timer: setTimeout(() => dismiss(item.key), props.ttlMs),
  }
  // 超出上限就立刻丢掉最旧的一条（连同它的定时器）。
  const next = [...notices.value, item]
  while (next.length > props.max) {
    const dropped = next.shift()
    if (dropped) clearTimeout(dropped.timer)
  }
  notices.value = next
}

/**
 * 初始值取进桌时的 notice 并直接标记为「已看过」。
 * `session.notice` 是跨视图保留的 ref：进桌时它可能已经带着上一条（包括「自己已重新连接」），
 * 若从空串起步，第一个真实事件会与它一起挤进通知条
 *（实测：进桌瞬间同时显示「房主 已重新连接」与「房主 买入 5000 入座 1 号位」）。
 */
const lastSeen = ref(props.notice)
/**
 * 进桌那一刻的「notice + 版本号」：这是服务端在 `room.snapshot` 里带过来的历史回放，
 * 例如三分钟前的「某某加入了房间」。只要版本号没动过，同一条就不弹。
 */
const mountNotice = props.notice
const mountVersion = props.version

/**
 * 自己触发的、对自己没有播报价值的消息：
 *   - `自己 已重新连接`：网络恢复时自己最清楚，别人看桌子也知道；
 *   - `自己 加入了房间`：刚进桌时的那一条。
 * 别人的同名事件照常播报（「客人 已重新连接」是有用的信息）。
 */
function isSelfNoise(text: string): boolean {
  const me = props.myNickname.trim()
  if (!me) return false
  if (text === `${me} 已重新连接` || text === `${me} 加入了房间`) return true
  // 自己刚落座的那条（「房主 买入 5000 入座 1 号位」）：桌面上已经能看到自己坐在那儿了，
  // 通知条再说一遍属于自我复述；别人的入座照常播报。
  return new RegExp(`^${escapeRegExp(me)} 买入 \\d+ 入座 \\d+ 号位$`).test(text)
}

/** 昵称可能含正则元字符；转义后再拼规则，避免「(小明)」这类昵称引发意外匹配。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function accept(value: string): void {
  if (isSelfNoise(value)) return
  if (!props.myNickname.trim()) {
    // 昵称未知：先挂起，等 watch(myNickname) 复查。
    if (pending) clearTimeout(pending.timer)
    pending = {
      text: value,
      timer: setTimeout(() => {
        const held = pending
        pending = null
        if (held) push(held.text)
      }, 2000),
    }
    return
  }
  push(value)
}

watch(
  () => props.notice,
  (value) => {
    if (!value || value === lastSeen.value) return
    lastSeen.value = value
    // 历史回放：文案与版本号都和进桌时一模一样，说明它来自快照而不是新事件。
    if (value === mountNotice && props.version === mountVersion) return
    accept(value)
  },
  { immediate: true },
)

// 自己刚落座/刚重连时昵称才到位：这时再复查暂存的那一条。
watch(
  () => props.myNickname,
  (nickname) => {
    if (!nickname.trim() || !pending) return
    const held = pending
    pending = null
    clearTimeout(held.timer)
    if (!isSelfNoise(held.text)) push(held.text)
  },
)

onBeforeUnmount(() => {
  for (const item of notices.value) clearTimeout(item.timer)
  if (pending) clearTimeout(pending.timer)
})
</script>

<template>
  <!-- 没有通知时整块不渲染，不占一点高度。 -->
  <div v-if="notices.length > 0" class="notice-strip">
    <TransitionGroup name="strip">
      <p v-for="item in notices" :key="item.key" class="strip-row" :class="`is-${item.tone}`">
        <span class="strip-icon" aria-hidden="true">{{ iconOf(item) }}</span>
        <span class="strip-text">{{ item.text }}</span>
        <button type="button" class="strip-close" :aria-label="`关闭通知：${item.text}`" title="关闭这条通知"
          @click="dismiss(item.key)">
          <i class="pi pi-times" aria-hidden="true" />
        </button>
      </p>
    </TransitionGroup>
  </div>
</template>

<style scoped>
/*
 * 细条：贴着顶栏下沿、居中在牌桌上方，宽度随文字收缩（不铺满整行）。
 * 高度预算：单行 24px，最多两条 52px —— 比顶栏（61px）还矮，是「不占位置」的硬约束。
 */
.notice-strip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  /* 左右留出与牌桌一致的内边距；纵向只有 2px，避免把牌桌往下推。 */
  padding: 2px var(--space-2) 0;
  pointer-events: none;
}

.strip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: min(92vw, 640px);
  margin: 0;
  padding: 2px 4px 2px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);
  color: var(--muted);
  font-size: 0.76rem;
  line-height: 1.4;
  /* 只有这条通知自己可点（关闭按钮）；外层容器不挡桌面点击。 */
  pointer-events: auto;
}

.strip-row.is-warn {
  border-color: color-mix(in srgb, var(--danger) 55%, var(--line));
  color: var(--text);
}

.strip-row.is-settle {
  border-color: var(--gold-soft);
  color: var(--text);
}

.strip-icon {
  flex: none;
  font-size: 0.72rem;
}

/* 长文本省略而不是换行：一行就是一行，绝不因为一句长通知把牌桌顶下去。 */
.strip-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.strip-close {
  flex: none;
  display: grid;
  place-items: center;
  /* 触控目标 24px：比常规按钮小，因为它只是「提前收起」，不等于关键操作。 */
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 0.62rem;
  cursor: pointer;
  transition: background-color 0.15s ease-out, color 0.15s ease-out;
}

.strip-close:hover {
  background: color-mix(in srgb, var(--text) 12%, transparent);
  color: var(--text);
}

/* 进出场只动 opacity + transform（合成层友好）；prefers-reduced-motion 由 theme.css 统一关闭。 */
.strip-enter-active,
.strip-leave-active {
  transition: opacity 0.18s ease-out, transform 0.18s ease-out;
}

.strip-enter-from,
.strip-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.strip-leave-active {
  position: absolute;
}

/* 竖屏：更窄的字号与高度，仍然只有一行。 */
@media (max-width: 560px) {
  .notice-strip {
    padding-inline: var(--space-1);
  }

  .strip-row {
    max-width: 96vw;
    padding: 0 2px 0 8px;
    font-size: 0.72rem;
    line-height: 1.35;
  }

  .strip-close {
    width: 22px;
    height: 22px;
  }
}
</style>
