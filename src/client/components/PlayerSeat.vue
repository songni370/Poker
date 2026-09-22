<script setup lang="ts">
import { computed } from 'vue'
import { ACTION_NAMES } from '../../shared/poker.ts'
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

const lastActionText = computed(() => (props.seat.lastAction ? ACTION_NAMES[props.seat.lastAction] : ''))

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
  const badges: { key: string; label: string; tone: 'dealer' | 'blind' }[] = []
  if (props.seat.isDealer) badges.push({ key: 'dealer', label: 'D', tone: 'dealer' })
  if (props.seat.isSmallBlind) badges.push({ key: 'sb', label: 'SB', tone: 'blind' })
  if (props.seat.isBigBlind) badges.push({ key: 'bb', label: 'BB', tone: 'blind' })
  return badges
})

/** 屏幕阅读器摘要：昵称、筹码、当前状态，一次读完。 */
const spoken = computed(() => {
  const parts = [`座位 ${String(props.seat.seat + 1)}`, props.seat.nickname, `筹码 ${String(props.seat.stack)}`]
  if (roleText.value) parts.push(roleText.value)
  if (props.seat.committedStreet > 0) parts.push(`本轮下注 ${String(props.seat.committedStreet)}`)
  if (statusText.value) parts.push(statusText.value)
  if (props.isActing) parts.push('正在行动')
  return parts.join('，')
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
    <!-- 底牌：本人正面，其他人按手牌张数画背面。 -->
    <div v-if="cardCount > 0" class="cards">
      <PlayingCard
        v-for="index in cardCount"
        :key="`back-${String(index)}`"
        size="sm"
        hidden
        :dimmed="seat.folded"
      />
    </div>

    <div class="panel">
      <!--
        面板左侧 = 座位号 + 牌局角色槽位（庄家 / 小盲 / 大盲），都横排在一行里。
        第 4 项需求：座位号从「昵称上方单独一行」搬到左侧同行——面板因此从两行收到一行，
        牌桌上每个座位卡片矮 13px，小屏的公共牌区就多 13px。
        两者都只是视觉，完整说法在座位 aria-label 里（「座位 3」「庄家位」…）；
        没有角色时只留座位号，不会出现空槽位。
      -->
      <span class="seat-no num" aria-hidden="true">{{ seat.seat + 1 }}</span>
      <!-- 视觉分隔：座位号是徽标、昵称是文本，紧挨着会读成「3小明」。读屏不受影响（两者都在 aria-label 里）。 -->
      <span class="seat-sep" aria-hidden="true">·</span>

      <span v-if="roleBadges.length > 0" class="roles" aria-hidden="true">
        <span v-for="badge in roleBadges" :key="badge.key" class="role-badge" :class="`role-badge--${badge.tone}`">
          {{ badge.label }}
        </span>
      </span>

      <span class="meta">
        <span class="name">
          {{ seat.nickname }}
          <span v-if="isHero" class="tag tag--hero">你</span>
        </span>
        <span class="stack num">{{ seat.stack }}</span>
      </span>

      <span v-if="!seat.connected" class="flag flag--off" aria-hidden="true">
        <i class="pi pi-wifi" />
      </span>
      <span v-else-if="seat.allIn" class="flag flag--allin" aria-hidden="true">ALL IN</span>

      <!-- 本轮下注：小屏（矮屏横屏 / 竖屏）专用的面板角标。
           那些尺寸里桌子中央挤不下浮动的下注筹码（要么压住自己的筹码数字，要么压住公共牌），
           改成写在座位面板右下角；无障碍读法在 aria-label 里（见 spoken）。 -->
      <span v-if="seat.committedStreet > 0" class="panel-bet num" aria-hidden="true">
        {{ seat.committedStreet }}
      </span>
    </div>

    <!-- 状态行：文本形式（不仅靠颜色）。
         is-action-only 只说明「上一手做了什么」，矮屏/竖屏可以让位给公共牌；
         已弃牌、全下、断线、轮到你这些状态永远不会被隐藏。 -->
    <p
      v-if="isActing || statusText || lastActionText"
      class="status"
      :class="{ 'is-action-only': !isActing && !statusText && Boolean(lastActionText) }"
    >
      <span v-if="isActing" class="turn">YOUR TURN</span>
      <span v-else-if="statusText" class="state">{{ statusText }}</span>
      <span v-else-if="lastActionText" class="state">{{ lastActionText }}</span>
    </p>

    <!-- 倒计时进度条：仅在轮到该玩家时出现。 -->
    <div
      v-if="isActing"
      class="timer"
      role="progressbar"
      :aria-valuenow="remainingSeconds"
      aria-valuemin="0"
      :aria-valuemax="turnSeconds"
      :aria-label="`行动倒计时，剩余 ${String(remainingSeconds)} 秒`"
    >
      <span class="timer-fill" :style="{ transform: `scaleX(${String(percent / 100)})` }" />
    </div>
  </article>
</template>

<style scoped>
.seat {
  display: grid;
  justify-items: center;
  gap: 4px;
  width: var(--seat-w, 144px);
  transition: opacity 0.2s ease-out;
}

.cards {
  display: flex;
  gap: 3px;
}

.panel {
  position: relative;
  display: flex;
  align-items: center;
  /* 6px：头像没了以后，左侧角色槽位与昵称之间不需要原来 8px 的呼吸位。 */
  gap: 6px;
  width: 100%;
  /* min-width: 0 是必需的：窄屏（贴边座位 64px）下面板的 min-content 由角色胶囊 + 昵称决定，
     不放开的话面板会顶出座位宽度（实测多出 5.6px），把两侧的净空吃掉。 */
  min-width: 0;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
}

.is-hero .panel {
  border-color: var(--gold-soft);
}

.is-folded {
  opacity: 0.55;
}

.is-out .panel {
  border-style: dashed;
  border-color: var(--danger);
}

/* 离座保留的座位：虚线描边 + 状态文案「已离座」，与「断线」区分开颜色。 */
.is-away .panel {
  border-style: dashed;
  border-color: var(--gold-soft);
  background: color-mix(in srgb, var(--bg-elevated) 70%, transparent);
}

.is-winner .panel {
  border-color: var(--gold);
}

/*
 * 昵称 + 筹码：占据角色槽位以外的全部宽度，并且可以收缩到比内容更窄
 * （min-width: 0 才能让里面的 .name 触发省略号，而不是把面板撑宽）。
 */
.meta {
  display: grid;
  flex: 1 1 auto;
  gap: 1px;
  min-width: 0;
}

.name {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.82rem;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag {
  flex: none;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 0.62rem;
  line-height: 1.5;
}

.tag--hero {
  background: var(--gold-dim);
  color: var(--gold);
}

.stack {
  font-size: 0.78rem;
  color: var(--muted);
  /* 筹码是数字，宁可整段省略也不要把面板顶宽。 */
  overflow: hidden;
  text-overflow: ellipsis;
}

.flag {
  margin-left: auto;
  font-size: 0.6rem;
  letter-spacing: 0.06em;
}

.flag--off {
  color: var(--danger);
}

.flag--allin {
  color: var(--gold);
  font-weight: 700;
}

/*
 * 座位号：面板最左侧的小徽标（第 4 项需求）。
 * 它与角色胶囊横排在同一行，面板因此只有一行高；数字用等宽字形，1 与 9 不会挤动版式。
 */
.seat-no {
  flex: none;
  min-width: 15px;
  padding: 0 3px;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--muted);
  font-size: 0.58rem;
  line-height: 1.5;
  text-align: center;
}

/* 座位号与昵称之间的间隔符：只是个视觉锚点，不参与无障碍。 */
.seat-sep {
  flex: none;
  color: color-mix(in srgb, var(--muted) 60%, transparent);
  font-size: 0.7rem;
  line-height: 1;
}

/*
 * 牌局角色槽位：座位号右侧的一列胶囊，是面板内唯一的「非本人信息」元素。
 * 双人桌同一座位可能同时是庄家与小盲（D + SB），所以是一组而不是一个；
 * 面板高度由昵称+筹码（约 33px）决定，两个胶囊横排约 13px，不会把面板撑高。
 */
.roles {
  display: flex;
  flex: none;
  align-items: center;
  gap: 3px;
}

.role-badge {
  min-width: 13px;
  padding: 0 3px;
  border-radius: 5px;
  font-size: 0.56rem;
  font-weight: 700;
  line-height: 1.5;
  text-align: center;
}

.role-badge--dealer {
  background: var(--gold);
  color: var(--bg);
}

.role-badge--blind {
  background: color-mix(in srgb, var(--action) 82%, black);
  color: #ffffff;
}

/*
 * 本人座位不重复显示「YOUR TURN + 进度条」：底部操作区已经有更大的同一套提示
 *（文本 + 秒数 + 整条进度条），环上这块省下来给别人面板留净空——
 * 单挑（2 人桌）时本人的下注筹码正好落在这一行上（实测压住 YOUR TURN 约 14×41px）。
 * 头像光环与 aria-label 里的「正在行动」仍在，颜色不是唯一提示。
 */
.is-hero .status,
.is-hero .timer {
  display: none;
}

/* 本轮下注角标：默认隐藏（桌面用桌面中央的下注筹码），只在矮屏与竖屏由各自规则打开。 */
.panel-bet {
  display: none;
  position: absolute;
  right: 3px;
  bottom: 1px;
  color: var(--gold);
  font-size: 0.62rem;
  line-height: 1.4;
}

.status {
  margin: 0;
  font-size: 0.68rem;
  line-height: 1.3;
  text-align: center;
  color: var(--muted);
}

.turn {
  color: var(--gold);
  font-weight: 700;
  letter-spacing: 0.08em;
}

.state {
  color: var(--muted);
}

.timer {
  position: relative;
  width: 100%;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.35);
}

.timer-fill {
  display: block;
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background: var(--gold);
}

/* 横向空间不足时压缩座位宽度，保证 9 人桌不横向溢出。 */
@media (max-width: 1100px) {
  .seat {
    width: 124px;
  }
}

/* 竖屏窄屏：座位收窄到桌面内，避免横向溢出。 */
@media (max-width: 560px) and (orientation: portrait) {
  .seat {
    /* 走变量：牌桌会给「贴边座位」单独设一个更窄的 --seat-w（见 PokerTable 竖屏规则）。 */
    width: var(--seat-w, 108px);
  }

  .name {
    font-size: 0.74rem;
  }

  /*
   * 竖屏最窄的座位（贴边位）只有 64px：昵称与筹码要留得下，
   * 角色胶囊就竖排成一列并收到最小尺寸（约 11px 宽），省出来的一列全给昵称。
   */
  .roles {
    flex-direction: column;
    gap: 2px;
  }

  .role-badge {
    min-width: 0;
    padding: 0 2px;
    font-size: 0.5rem;
    line-height: 1.4;
  }

  /* 贴边座位只有 64px：间隔符让位给昵称。 */
  .seat-sep {
    display: none;
  }

  /*
   * 竖屏只有 ~358px 宽、9 个座位环成一圈：座位面板每高 10px，公共牌就被吃掉 10px。
   * 这里只保留「角色 + 昵称 + 筹码」，面板从 ~105px 收到 ~47px，公共牌区不再被压住：
   *   - 底牌：本人底牌在下方操作区有大图；他人只画背面，弃牌/全下的状态由面板淡化与 ALL IN 标记给出；
   *   - 「上一手动作」文本：下注筹码本身就在桌上显示金额；
   *   - 行动提示：本人由底部 YOUR TURN + 进度条给出，他人由操作区的「等待 X 行动」给出；
   *   - 已弃牌 / 全下 / 已断线 / 轮到你的文本状态一律保留（不靠颜色区分）。
   */
  .seat .cards,
  .seat .status.is-action-only {
    display: none;
  }

  /* 本轮下注改由面板角标给出（桌面中央浮动的下注筹码在竖屏会压住公共牌或筹码数字）。 */
  .panel-bet {
    display: inline-flex;
  }
}
</style>
