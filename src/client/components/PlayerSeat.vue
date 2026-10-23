<script setup lang="ts">
import { computed } from 'vue'
import type { SeatPublic } from '../../shared/protocol.ts'
import PlayingCard from './PlayingCard.vue'

const props = withDefaults(
  defineProps<{
    seat: SeatPublic
    /** 是否为本人座位（决定是否显示「你」标记与角标位置）。 */
    isHero?: boolean
    /** 是否正在行动（光环 + YOUR TURN + 进度条三重提示）。 */
    isActing?: boolean
    /** 本手牌赢家（叠加金色标记，不是唯一提示手段）。 */
    /** 本手赢得的筹码（0 表示没赢；>0 时座位显示王冠与金额）。 */
    winAmount?: number
    isWinner?: boolean
    /** 剩余时间比例 0–1；仅行动中需要。 */
    remainingRatio?: number
    /** 剩余秒数；仅行动中需要。 */
    remainingSeconds?: number
    /** 每轮行动总秒数，用于进度条的无障碍范围。 */
    turnSeconds?: number
  }>(),
  {
    isHero: false,
    isActing: false,
    isWinner: false,
    winAmount: 0,
    remainingRatio: 1,
    remainingSeconds: 0,
    turnSeconds: 20,
  },
)

/**
 * 手牌张数：本人座位不画牌（正面背面都不画），其余玩家按 holeCardCount 画背面。
 * 本人底牌只在底部操作区显示：那里牌更大、不会被桌沿或筹码挡住，
 * 也避免同一份底牌在屏幕上出现两次。
 */
const cardCount = computed(() => (props.isHero ? 0 : props.seat.holeCardCount))

const statusText = computed(() => {
  // 「已离座」优先于弃牌/全下：座位还占着、筹码还留着，但人已经离开牌桌
  //（第 6 项需求）。别人必须能一眼看出这个座位只是被保留。
  if (props.seat.away) return '已离座'
  if (!props.seat.connected) return '已断线'
  if (props.seat.folded) return '已弃牌'
  if (props.seat.allIn) return '全下'
  if (props.isHero) return '你'
  return ''
})


const roleText = computed(() => {
  if (props.seat.isDealer) return '庄家位'
  if (props.seat.isSmallBlind) return '小盲'
  if (props.seat.isBigBlind) return '大盲'
  return ''
})

/**
 * 庄家 / 盲位角标（D、SB、BB）。
 * 位置从「桌面上的庄家按钮」搬到座位面板内：桌面按钮会压住底牌背面或底池
 * （实测 740×360 压住底池 6.9×22px），面板内角标则永远只占面板自己的空间。
 * 双人桌时同一座位可能既是庄家又是小盲，所以是一组角标。
 * 头像圆与首字头像已删除：左侧这一块改成纯粹的「牌局角色」槽位，
 * 没有角色时整块不渲染也不占位（昵称与筹码因此拿到更多宽度）。
 */
const roleBadges = computed(() => {
  const badges: { key: string; label: string; tone: 'dealer' | 'blind' | 'bot' }[] = []
  if (props.seat.isDealer) badges.push({ key: 'dealer', label: 'D', tone: 'dealer' })
  if (props.seat.isSmallBlind) badges.push({ key: 'sb', label: 'SB', tone: 'blind' })
  if (props.seat.isBigBlind) badges.push({ key: 'bb', label: 'BB', tone: 'blind' })
  // 机器人标记：一眼看出这个位置不是真人，避免误以为有人在跟你打。
  // 机器人徽章用单个 B：座位面板很窄，'BOT' 三个字符会把昵称挤成「老…」。
  if (props.seat.isBot) badges.push({ key: 'bot', label: 'B', tone: 'bot' })
  return badges
})

/**
 * 动作标签：把「刚做了什么 + 多少」写在座位面板上。
 * 这是牌局里判断对手范围与决定加注的主要依据，所以：
 *   - 有小盲/大盲时显示「小盲 10 / 大盲 20」（盲注就是他们的本轮投入）；
 *   - 有具体动作时显示「跟注 20 / 加注到 120 / 下注 60 / 全下 500」；
 *   - 已弃牌优先显示「弃牌」。
 * 金额取 committedStreet（本轮投入），全下时取 committedHand（整手投入）。
 */
const actionLabel = computed<string>(() => {
  const action = props.seat.lastAction
  if (props.seat.folded) return '弃牌'
  /*
   * 动作标签只写「做了什么」，**不重复金额**：
   * 本轮下注的数额已经由桌面上的浮动筹码（PokerTable 的 .bet）显示了，
   * 两处都写会让人一眼看到两个一样的数字。
   * 加注这类需要知道目标额的动作由浮动筹码 + 底部操作区的数字共同表达。
   */
  switch (action) {
    case 'raise':
      return '加注'
    case 'bet':
      return '下注'
    case 'call':
      return '跟注'
    case 'check':
      return '过牌'
    default:
      // 没有动作时退回盲注说明（盲注本身就是本轮投入，金额由浮动筹码表达）
      if (props.seat.isSmallBlind) return '小盲'
      if (props.seat.isBigBlind) return '大盲'
      return ''
  }
})

/**
 * 根据文本长度选一档缩字号（昵称、筹码、动作标签共用）。
 *
 * 之前是三处手写的 `length >= 5 && length < 8` 判断，改文案时容易漏改。
 * 这里按字符数分三档，CSS 侧统一用 `.fit-2 / .fit-3` 控制字号与字距。
 */
function fitClass(text: string): string {
  const length = Array.from(text).length
  if (length >= 8) return 'fit-3'
  if (length >= 5) return 'fit-2'
  return 'fit-1'
}

/** 屏幕阅读器摘要：昵称、筹码、当前状态，一次读完。 */
const spoken = computed(() => {
  const parts = [`座位 ${String(props.seat.seat + 1)}`, props.seat.nickname, `筹码 ${String(props.seat.stack)}`]
  if (roleText.value) parts.push(roleText.value)
  if (props.seat.committedStreet > 0) parts.push(`本轮下注 ${String(props.seat.committedStreet)}`)
  if (statusText.value) parts.push(statusText.value)
  if (props.isActing) parts.push('正在行动')
  return parts.join('，')
})

/** 黄铜徽章上的首字：取昵称第一个字符（中文取字、英文取首字母大写）。 */
const initial = computed(() => {
  const first = Array.from(props.seat.nickname ?? '')[0] ?? '?'
  return first.toUpperCase()
})

const percent = computed(() => Math.round(Math.min(1, Math.max(0, props.remainingRatio)) * 100))
</script>

<template>
  <article
    class="seat"
    :class="{
      'is-acting': isActing,
      'is-folded': seat.folded,
      'is-out': !seat.connected,
      'is-allin': seat.allIn,
      'is-winner': isWinner,
      'is-hero': isHero,
      'is-away': seat.away,
    }"
    :aria-label="spoken"
  >
    <!-- 底牌：本人正面在底部操作区看大图，其他人按手牌张数画背面 -->
    <div v-if="cardCount > 0" class="cards">
      <PlayingCard
        v-for="index in cardCount"
        :key="`back-${String(index)}`"
        size="sm"
        hidden
        :dimmed="seat.folded"
      />
    </div>

    <!-- 紧凑自适应玩家卡片（轻巧双行结构，彻底告别臃肿厚重，尺寸随屏幕流式缩放） -->
    <div class="panel" :data-initial="initial">
      <!-- 第一行：座位号 + 完整昵称（含自己标） + 右侧角色徽标（D/SB/BB） -->
      <div class="seat-row seat-row--top">
        <div class="seat-identity">
          <span class="seat-no num" aria-hidden="true">{{ seat.seat + 1 }}</span>
          <span
            class="name"
            :class="fitClass(seat.nickname)"
            :title="seat.nickname"
          >
            {{ seat.nickname }}
          </span>
          <span v-if="isHero" class="tag tag--hero">你</span>
        </div>
        <div v-if="roleBadges.length > 0" class="roles" aria-hidden="true">
          <span
            v-for="badge in roleBadges"
            :key="badge.key"
            class="role-badge"
            :class="`role-badge--${badge.tone}`"
          >
            {{ badge.label }}
          </span>
        </div>
      </div>

      <!-- 第二行：筹码金额（等宽鲜艳、100% 完整无截断） + 右侧状态标（ALL IN / 离座 / 弃牌 / 断线） -->
      <div class="seat-row seat-row--bottom">
        <span
          class="stack num"
          :class="fitClass(String(seat.stack))"
          :title="`筹码：${seat.stack}`"
        >
          {{ seat.stack }}
        </span>
        <div class="seat-flags">
          <span v-if="!seat.connected" class="flag flag--off" aria-hidden="true" title="已断线">
            <i class="pi pi-wifi" />
          </span>
          <span v-else-if="seat.allIn" class="flag flag--allin" aria-hidden="true">ALL IN</span>
          <span v-else-if="seat.away" class="flag flag--away" aria-hidden="true">已离座</span>
          <span v-else-if="seat.folded" class="flag flag--folded" aria-hidden="true">已弃牌</span>
        </div>
      </div>

      <!--
        本轮下注**不在这里画**：桌面上的浮动筹码（PokerTable 的 .bet）已经显示了同样的金额。
        两处同时显示会重复（一个在卡右下角、一个朝桌心），这里只保留桌面那一处。
        无效信息不删干净：`spoken` 摘要里仍会读出「本轮下注 N」，读屏用户不缺信息。
      -->
    </div>

    <!--
      本手赢家：王冠 + 赢得金额 + 金币闪光。
      从「结算弹窗」改成「画在牌桌上」后，谁赢了、赢多少一眼就能看到，
      也不打断玩家继续操作（不用先关弹窗才能开下一手）。
    -->
    <div v-if="winAmount > 0" class="win-badge" :aria-label="`赢得 ${winAmount} 筹码`">
      <span class="win-crown" aria-hidden="true">👑</span>
      <span class="win-amount num">+{{ winAmount }}</span>
      <span class="win-coins" aria-hidden="true">
        <i v-for="coin in 5" :key="coin" :class="`win-coin win-coin--${coin}`" />
      </span>
    </div>

    <!-- 倒计时进度条与时间一体化胶囊：轮到该玩家行动时出现 -->
    <div
      v-if="isActing"
      class="seat-timer-capsule"
      :class="{ 'is-urgent': remainingSeconds <= 5 }"
      role="progressbar"
      :aria-valuenow="remainingSeconds"
      aria-valuemin="0"
      :aria-valuemax="turnSeconds"
      :aria-label="`行动倒计时，剩余 ${String(remainingSeconds)} 秒`"
    >
      <span class="seat-timer-fill" :style="{ transform: `scaleX(${String(percent / 100)})` }" />
      <span class="seat-timer-label num">
        <i class="pi pi-clock seat-timer-icon" aria-hidden="true" />
        <span>{{ isHero ? '轮到你' : '思考中' }} {{ remainingSeconds }}s</span>
      </span>
    </div>

    <!-- 动作标签：刚做了什么、多少（弃牌/跟注 20/加注到 120/全下 500） -->
    <p
      v-else-if="actionLabel"
      class="action-label"
      :class="[`action-label--${seat.lastAction ?? 'blind'}`, fitClass(actionLabel)]"
    >
      {{ actionLabel }}
    </p>
  </article>
</template>

<style scoped>
/* 整个座位容器：尺寸随屏幕流式自适应，彻底告别死板过大尺寸 */
.seat {
  display: grid;
  justify-items: center;
  gap: 2px;
  width: var(--seat-w, clamp(80px, 10vw, 122px));
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.cards {
  display: flex;
  gap: 2px;
  margin-bottom: -1px;
}

.cards :deep(.card--sm) {
  --cw: clamp(19px, 2.2vw, 24px);
}

/* 核心面板：拟物皮革铭牌——深棕渐变 + 顶部高光 + 底部内阴影 + 硬投影。 */
.panel {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  width: 100%;
  min-width: 0;
  padding: clamp(2px, 0.4vw, 4px) clamp(4px, 0.6vw, 7px);
  border-radius: clamp(5px, 0.6vw, 8px);
  border: 1px solid rgba(0, 0, 0, 0.8);
  background:
    repeating-linear-gradient(105deg, rgba(255, 255, 255, 0.015) 0 2px, transparent 2px 6px),
    linear-gradient(180deg, #2b231a 0%, #1b150f 60%, #120e0a 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    inset 0 -2px 4px rgba(0, 0, 0, 0.7),
    0 6px 14px rgba(0, 0, 0, 0.65);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  box-sizing: border-box;
}

/* 行首黄铜徽章：昵称首字，径向渐变模拟金属反光。
   竖屏座位面板只有 80–96px 宽，徽章会压住昵称与筹码，因此在 ≤560px 竖屏隐藏（见文末媒体查询）。 */
.panel::before {
  content: attr(data-initial);
  position: absolute;
  left: -12px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 0.58rem;
  font-weight: 800;
  color: #3a2a12;
  background: radial-gradient(circle at 32% 26%, #f6e2b4 0%, #d3b070 45%, #8c6c33 100%);
  border: 1px solid #6d5325;
  box-shadow:
    inset 0 -2px 3px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.7),
    0 1px 2px rgba(0, 0, 0, 0.6);
}

.is-acting .panel {
  border-color: #a5803c;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.3),
    0 0 0 1px rgba(255, 210, 130, 0.35),
    0 0 26px rgba(255, 190, 90, 0.28),
    0 6px 14px rgba(0, 0, 0, 0.7);
  animation: seat-glow 1.8s ease-in-out infinite;
}

.is-hero .panel {
  border-color: rgba(165, 128, 60, 0.9);
  background:
    repeating-linear-gradient(105deg, rgba(255, 255, 255, 0.02) 0 2px, transparent 2px 6px),
    linear-gradient(180deg, #3a2e21 0%, #241b12 60%, #150f0a 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.22),
    0 6px 16px rgba(0, 0, 0, 0.7);
}

.is-folded {
  opacity: 0.42;
  filter: saturate(0.45);
}

.is-out .panel {
  border-style: dashed;
  border-color: var(--danger);
}

.is-away .panel {
  border-style: dashed;
  border-color: var(--gold-soft);
  background: rgba(20, 26, 34, 0.75);
}

.is-winner .panel {
  border-color: #ffe394;
  box-shadow: 0 0 20px rgba(255, 227, 148, 0.75), inset 0 0 8px rgba(255, 227, 148, 0.4);
  animation: soft-pulse 1.3s ease-in-out infinite;
}

/* 行容器：左右对齐，利用率 100% */
.seat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-width: 0;
  gap: 3px;
  line-height: 1.15;
}

/* 身份区域（座位号 + 昵称 + 你） */
.seat-identity {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  flex: 1 1 auto;
}

.seat-no {
  flex: none;
  min-width: 12px;
  padding: 0 2px;
  border-radius: 2px;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg) 60%, transparent);
  color: var(--muted);
  font-size: clamp(0.50rem, 0.6vw, 0.58rem);
  line-height: 1.25;
  text-align: center;
  font-weight: 700;
}

.name {
  color: var(--text);
  font-size: clamp(0.66rem, 0.8vw, 0.76rem);
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.01em;
  /*
   * 昵称过长（真实房间常见 6–8 个字）时：
   *   - 不换行、单行省略——换行会把面板撑高，在 9 人竖屏环里立刻压到邻座；
   *   - flex 收缩 + min-width:0 让省略号真正生效，而不是把右边的徽章挤变形。
   */
  min-width: 0;
  flex: 1 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 统一缩字号分档：fit-1 = 短文本，fit-2 = 中等，fit-3 = 长文本。
   昵称、筹码、动作标签共用同一套规则，改档位只需改这里。 */
.fit-2 {
  font-size: 0.92em;
  letter-spacing: -0.02em;
}

.fit-3 {
  font-size: 0.84em;
  letter-spacing: -0.03em;
}

.tag {
  flex: none;
  padding: 0 2px;
  white-space: nowrap;
  border-radius: 2px;
  font-size: clamp(0.48rem, 0.55vw, 0.54rem);
  line-height: 1.2;
}

.tag--hero {
  background: var(--gold-dim);
  color: var(--gold);
  font-weight: 700;
}

/* 角色徽标 */
.roles {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.role-badge {
  min-width: 11px;
  padding: 0 2px;
  border-radius: 2px;
  font-size: clamp(0.48rem, 0.56vw, 0.54rem);
  font-weight: 800;
  line-height: 1.25;
  text-align: center;
}

.role-badge--dealer {
  background: linear-gradient(135deg, #ffd875 0%, #cb9b51 100%);
  color: #0b0f14;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

.role-badge--bot {
  background: linear-gradient(180deg, #2f3944 0%, #1d242c 100%);
  color: #b8c8d6;
  border-color: rgba(150, 178, 200, 0.5);
}

.role-badge--blind {
  background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);
  color: #ffffff;
}

/* 筹码数字：暖金压印 + 等宽数字，100% 完整展示绝不截断 */
.stack {
  color: #ffd98a;
  font-size: clamp(0.70rem, 0.85vw, 0.80rem);
  font-weight: 800;
  white-space: nowrap;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  overflow: visible;
  line-height: 1.15;
  text-shadow: 0 1px 0 #000, 0 0 10px rgba(255, 190, 90, 0.25);
  flex: 1 1 auto;
  min-width: 0;
}

/* 状态标集 */
.seat-flags {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.flag {
  font-size: clamp(0.48rem, 0.56vw, 0.54rem);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: 0.02em;
  padding: 1px 3px;
  border-radius: 2px;
}

.flag--off {
  color: var(--danger);
}

.flag--allin {
  color: #0b0f14;
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
}

.flag--away {
  color: var(--gold-soft);
  border: 1px dashed var(--gold-soft);
}

.flag--folded {
  color: var(--muted);
  background: rgba(255, 255, 255, 0.1);
}

/* 本人座位不重复显示「行动倒计时」：底部操作区已有专属的大型倒计时舱 */
.is-hero .status,
.is-hero .seat-timer-capsule {
  display: none;
}

/* ───────────── 本手赢家：王冠 + 金额 + 金币 ───────────── */
.win-badge {
  position: absolute;
  left: 50%;
  top: -6px;
  transform: translate(-50%, -100%);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px 1px 4px;
  border-radius: 999px;
  background: linear-gradient(180deg, #3a2c15 0%, #241a0e 100%);
  border: 1px solid #c39a4f;
  box-shadow:
    inset 0 1px 0 rgba(255, 230, 170, 0.35),
    0 0 12px rgba(255, 200, 90, 0.45),
    0 2px 6px rgba(0, 0, 0, 0.7);
  white-space: nowrap;
  z-index: 7;
  pointer-events: none;
  animation: win-badge-pop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

.win-crown {
  font-size: 0.8rem;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8));
}

.win-amount {
  color: #ffe9ac;
  font-size: 0.68rem;
  font-weight: 800;
  text-shadow: 0 1px 0 #000, 0 0 8px rgba(255, 190, 90, 0.6);
}

/* 金币：从赢家座位向上飘散，纯 CSS 动画，不引入任何素材 */
.win-coins {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 0;
  height: 0;
}

.win-coin {
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #ffe9ac 0%, #f0c668 45%, #a8761f 100%);
  box-shadow: 0 0 4px rgba(255, 200, 90, 0.8);
  opacity: 0;
  animation: win-coin-rise 1.1s ease-out forwards;
}

.win-coin--1 { left: -14px; animation-delay: 0.05s; --drift: -10px; }
.win-coin--2 { left: -6px; animation-delay: 0.15s; --drift: -4px; }
.win-coin--3 { left: 0; animation-delay: 0s; --drift: 2px; }
.win-coin--4 { left: 6px; animation-delay: 0.2s; --drift: 8px; }
.win-coin--5 { left: 13px; animation-delay: 0.1s; --drift: 13px; }

@keyframes win-badge-pop {
  from { transform: translate(-50%, -60%) scale(0.6); opacity: 0; }
  to { transform: translate(-50%, -100%) scale(1); opacity: 1; }
}

@keyframes win-coin-rise {
  0% { transform: translate(0, 0) scale(0.6); opacity: 0; }
  25% { opacity: 1; }
  100% { transform: translate(var(--drift, 0), -26px) scale(1); opacity: 0; }
}

/* 动作标签：刚做了什么 + 多少；弃牌压暗，加注/全下提亮 */
.action-label {
  margin: 0;
  padding: 0 6px;
  border-radius: 999px;
  font-size: clamp(0.56rem, 0.66vw, 0.64rem);
  line-height: 1.35;
  font-weight: 700;
  white-space: nowrap;
  color: #ffdf9a;
  background: rgba(0, 0, 0, 0.42);
  border: 1px solid rgba(138, 106, 50, 0.5);
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.8);
}

.action-label--fold {
  color: #b9ad95;
  border-color: rgba(255, 255, 255, 0.08);
}

.action-label--check,
.action-label--call {
  color: #d9c9a6;
}

.action-label--raise,
.action-label--bet,
.action-label--all_in {
  color: #2a1c08;
  background: linear-gradient(180deg, #f4dc9e 0%, #c39a4f 100%);
  border-color: #7c5c22;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.5);
}

.status {
  margin: 0;
  font-size: clamp(0.58rem, 0.68vw, 0.66rem);
  line-height: 1.2;
  text-align: center;
  color: var(--muted);
}

.seat-timer-capsule {
  position: relative;
  width: 100%;
  max-width: var(--seat-w, 110px);
  height: clamp(14px, 1.8vw, 17px);
  border-radius: 999px;
  overflow: hidden;
  /* 内凹凹槽 + 黄铜细框：拟物金属仪表 */
  background: #0c0906;
  border: 1px solid rgba(165, 128, 60, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow:
    inset 0 2px 5px rgba(0, 0, 0, 0.9),
    0 1px 0 rgba(255, 255, 255, 0.08),
    0 3px 8px rgba(0, 0, 0, 0.55);
}

.seat-timer-capsule.is-urgent {
  border-color: rgba(239, 68, 68, 0.75);
  box-shadow:
    inset 0 2px 5px rgba(0, 0, 0, 0.9),
    0 0 10px rgba(239, 68, 68, 0.55);
}

.seat-timer-fill {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background: linear-gradient(180deg, #9af0a9 0%, #3fae57 70%, #2d8243 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45);
  transition: transform 0.15s linear;
}

.seat-timer-capsule.is-urgent .seat-timer-fill {
  background: linear-gradient(90deg, #dc2626 0%, #ef4444 100%);
}

.seat-timer-label {
  position: relative;
  z-index: 2;
  font-size: clamp(0.56rem, 0.66vw, 0.62rem);
  font-weight: 700;
  color: #ffffff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95);
  display: flex;
  align-items: center;
  gap: 2px;
  line-height: 1;
}

.seat-timer-icon {
  font-size: 0.58rem;
  color: #ffd875;
}

/* 竖屏窄屏自适应规则 */
@media (max-width: 560px) and (orientation: portrait) {
  .seat .cards,
  .seat .status.is-action-only {
    display: none;
  }

  /* 竖屏座位更矮：动作标签压到单行。 */
  .action-label {
    padding: 0 4px;
    font-size: 0.55rem;
  }
}

/* 竖屏窄座位：不画黄铜徽章，把宽度全部留给昵称与筹码。 */
@media (max-width: 560px) and (orientation: portrait) {
  .panel::before {
    display: none;
  }
}
</style>
