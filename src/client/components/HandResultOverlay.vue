<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import type { Card } from '../../shared/poker.ts'
import type { HandResultPublic, SeatPublic } from '../../shared/protocol.ts'
import { describeHand } from '../../engine/evaluate.ts'
import PlayingCard from './PlayingCard.vue'

const props = withDefaults(
  defineProps<{
    /** 本手结算结果（服务端 hand.settled 携带）。 */
    result: HandResultPublic
    /** 座位数组，用于把 playerId 映射成昵称。 */
    seats?: readonly (SeatPublic | null)[]
    /** 本人 playerId，用于高亮自己的收益与身份。 */
    heroPlayerId?: string | null
    /** 本人手牌（2 张底牌）。 */
    myCards?: readonly Card[]
    /** 是否显示。由父组件控制。 */
    visible?: boolean
    /** 服务端截止时间换算的剩余秒数；null 表示未启用自动开局。 */
    nextHandSeconds?: number | null
  }>(),
  { seats: () => [], heroPlayerId: null, myCards: () => [], visible: false, nextHandSeconds: null },
)

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'history'): void
}>()

function nicknameOf(playerId: string): string {
  const seat = props.seats.find((item) => item?.playerId === playerId)
  return seat?.nickname ?? '已离座玩家'
}

/** 赢家明细列表 */
const winnerRows = computed(() =>
  props.result.winners.map((winner) => ({
    ...winner,
    nickname: nicknameOf(winner.playerId),
    isHero: winner.playerId === props.heroPlayerId,
  })),
)

/** 本人本手净获胜筹码 */
const heroNet = computed(() => {
  return props.result.winners
    .filter((winner) => winner.playerId === props.heroPlayerId)
    .reduce((sum, winner) => sum + winner.amount, 0)
})

const heroWon = computed(() => heroNet.value > 0)

/** 本人有效底牌（优先用外部传入的 myCards，兜底从 revealed 中查找） */
const heroCards = computed<readonly Card[]>(() => {
  if (props.myCards && props.myCards.length > 0) return props.myCards
  const selfRev = props.result.revealed?.find((r) => r.playerId === props.heroPlayerId)
  return selfRev?.cards ?? []
})

/** 本人底牌 + 公共牌构成的最终牌型名称 */
const heroHandName = computed(() => {
  if (heroCards.value.length !== 2) return ''
  return describeHand([...heroCards.value, ...props.result.board])
})

/** 本人本局结算状态 */
const heroStatus = computed(() => {
  if (heroWon.value) return 'win'
  if (props.result.revealed?.some((r) => r.playerId === props.heroPlayerId)) return 'showdown'
  return 'fold'
})

/** 赢家昵称文案串 */
const winnerNamesText = computed(() => {
  const names = winnerRows.value.map((w) => (w.isHero ? '你' : w.nickname))
  if (names.length === 0) return '无人获胜'
  if (names.length === 1) return names[0]
  return names.join('、') + '（平分）'
})

/** 战报大标题 */
const headlineText = computed(() => {
  if (heroWon.value) return `恭喜获胜！赢得 +${String(heroNet.value)} 筹码`
  if (!props.result.showdown) return `全员弃牌，${winnerNamesText.value} 获胜`
  return `${winnerNamesText.value} 赢得底池`
})

/** 战报副标题说明 */
const bannerSubText = computed(() => {
  if (heroWon.value) {
    return heroHandName.value
      ? `凭借 ${heroHandName.value} 斩获底池`
      : '成功拿下本局底池！'
  }
  if (!props.result.showdown) {
    return '其他玩家均已弃牌，底牌无需公开直接获胜。'
  }
  return `摊牌比牌结算完成，总底池共 ${String(props.result.potTotal)} 筹码。`
})

/**
 * 坚持到最后、摊牌开牌的玩家明细列表。
 * 将赢家排在最前，其次是本人，然后是其他开牌玩家。
 */
const contendersList = computed(() => {
  const revList = props.result.revealed || []
  const list = revList.map((rev) => {
    const wins = winnerRows.value.filter((w) => w.playerId === rev.playerId)
    const winAmount = wins.reduce((sum, w) => sum + w.amount, 0)
    const isWinner = winAmount > 0
    const isHero = rev.playerId === props.heroPlayerId
    return {
      playerId: rev.playerId,
      nickname: nicknameOf(rev.playerId),
      cards: rev.cards,
      handName: rev.handName,
      isWinner,
      winAmount,
      isHero,
    }
  })

  // 排序：获胜者优先，本人次之
  return list.sort((a, b) => {
    if (a.isWinner && !b.isWinner) return -1
    if (!a.isWinner && b.isWinner) return 1
    if (a.isHero && !b.isHero) return -1
    if (!a.isHero && b.isHero) return 1
    return 0
  })
})
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :draggable="false"
    :block-scroll="true"
    class="vip-dialog result-dialog result-skin"
    :style="{ width: 'min(94vw, 560px)' }"
    @update:visible="(value: boolean) => !value && emit('close')"
  >
    <template #header>
      <div class="result-header">
        <div class="result-header-title">
          <span class="result-title-tag num">#{{ result.handNo }}</span>
          <h3 class="result-title-text">战局结算战报</h3>
        </div>
        <div class="result-header-pot">
          <span class="pot-label">总底池</span>
          <b class="pot-value num">{{ result.potTotal }}</b>
        </div>
      </div>
    </template>

    <div class="result-body thin-scroll">
      <!-- 1. 战报主横幅：胜负结论与赢家概览 -->
      <div class="result-banner" :class="heroWon ? 'banner-win' : 'banner-neutral'">
        <div class="banner-icon-box">
          <span class="banner-emoji">{{ heroWon ? '🏆' : (result.showdown ? '⚔️' : '🎯') }}</span>
        </div>
        <div class="banner-content">
          <h4 class="banner-title">{{ headlineText }}</h4>
          <p class="banner-desc">{{ bannerSubText }}</p>
        </div>
      </div>

      <!-- 2. 已开公共牌区域 -->
      <section class="result-section">
        <div class="section-title-row">
          <span class="section-title">🎴 公共牌</span>
          <span class="section-badge num">{{ result.board.length }} 张</span>
        </div>
        <div class="board-card-box">
          <div v-if="result.board.length > 0" class="cards-flex">
            <PlayingCard
              v-for="card in result.board"
              :key="card"
              size="sm"
              upright
              :card="card"
              class="result-playing-card"
            />
          </div>
          <span v-else class="board-empty-hint">翻牌前结束，未发出公共牌</span>
        </div>
      </section>

      <!-- 3. 玩家自己的手牌（无论胜负或弃牌，只要入座有手牌即展示） -->
      <section v-if="heroCards.length > 0" class="result-section hero-hand-section">
        <div class="section-title-row">
          <div class="hero-title-group">
            <span class="section-title">👤 你的手牌</span>
            <span v-if="heroWon" class="hero-status-chip chip-win">胜出 +{{ heroNet }}</span>
            <span v-else-if="heroStatus === 'showdown'" class="hero-status-chip chip-showdown">跟注到底</span>
            <span v-else class="hero-status-chip chip-fold">已弃牌</span>
          </div>
          <span v-if="heroHandName" class="hero-hand-type">{{ heroHandName }}</span>
        </div>
        <div class="hero-cards-box">
          <div class="cards-flex">
            <PlayingCard
              v-for="card in heroCards"
              :key="card"
              size="sm"
              upright
              :card="card"
              :class="['result-playing-card', { 'hero-win-card': heroWon }]"
            />
          </div>
          <div class="hero-eval-tip">
            <span class="eval-label">最终成牌：</span>
            <b class="eval-name">{{ heroHandName || '翻牌前底牌' }}</b>
          </div>
        </div>
      </section>

      <!-- 4. 谁赢了与坚持到最后开牌的玩家明细 -->
      <!-- 情况 A：进入摊牌比牌，展示所有坚持到最后开牌的玩家 -->
      <section v-if="result.showdown && contendersList.length > 0" class="result-section">
        <div class="section-title-row">
          <span class="section-title">⚔️ 摊牌开牌玩家（{{ contendersList.length }} 人亮牌对决）</span>
        </div>
        <div class="contenders-list">
          <div
            v-for="p in contendersList"
            :key="p.playerId"
            class="contender-row"
            :class="{ 'is-winner': p.isWinner, 'is-hero': p.isHero }"
          >
            <div class="contender-info">
              <div class="contender-name-row">
                <span v-if="p.isWinner" class="crown-badge">🏆 赢家</span>
                <span class="contender-nickname" :class="{ 'is-hero-nick': p.isHero }">
                  {{ p.isHero ? '你 (本人)' : p.nickname }}
                </span>
                <span v-if="p.isWinner" class="contender-award num">
                  +{{ p.winAmount }}
                </span>
              </div>
              <div class="contender-hand-name" :class="{ 'badge-gold-text': p.isWinner }">
                牌型：{{ p.handName }}
              </div>
            </div>

            <!-- 开牌额外展示该玩家翻开的 2 张手牌 -->
            <div class="contender-cards-flex">
              <PlayingCard
                v-for="c in p.cards"
                :key="c"
                size="sm"
                upright
                :card="c"
                :class="['result-playing-card', { 'winner-card-border': p.isWinner }]"
              />
            </div>
          </div>
        </div>
      </section>

      <!-- 情况 B：对手弃牌，未进入摊牌（展示谁赢了） -->
      <section v-else class="result-section">
        <div class="section-title-row">
          <span class="section-title">🏆 底池归属（其余玩家弃牌）</span>
        </div>
        <div class="uncontested-box">
          <div v-for="w in winnerRows" :key="w.playerId" class="uncontested-row">
            <span class="crown-icon">🏆</span>
            <span class="uncontested-winner-name" :class="{ 'is-hero-nick': w.isHero }">
              {{ w.isHero ? '你 (本人)' : w.nickname }}
            </span>
            <span class="uncontested-win-chip num">+{{ w.amount }}</span>
            <span class="uncontested-note">（其他玩家弃牌，底牌无需公开获胜）</span>
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <div class="result-footer">
        <span v-if="nextHandSeconds !== null" class="result-next-hand">
          <i class="pi pi-clock" aria-hidden="true" />
          下一手 {{ nextHandSeconds > 0 ? `${String(nextHandSeconds)} 秒后自动开始` : '即将开始' }}
        </span>
        <Button text class="history-quick-btn" :title="'查看手牌历史'" @click="emit('history')">
          <i class="pi pi-history" aria-hidden="true" />
          <span>手牌历史</span>
        </Button>
        <Button severity="primary" class="confirm-btn" :title="'继续牌局'" @click="emit('close')">
          <i class="pi pi-check" aria-hidden="true" />
          <span>知道了</span>
        </Button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
/* ═══════ 拟物风结算面板：皮革框 + 黄铜铭牌 + 内凹信息槽 ═══════ */
.p-dialog.result-skin {
  background:
    repeating-linear-gradient(115deg, rgba(255, 255, 255, 0.012) 0 3px, transparent 3px 9px),
    linear-gradient(180deg, #2a2118 0%, #1b150f 55%, #120e0a 100%);
  border: 1px solid #000;
  border-radius: 20px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    inset 0 -3px 8px rgba(0, 0, 0, 0.75),
    0 0 0 1.5px rgba(138, 106, 50, 0.7),
    0 24px 60px rgba(0, 0, 0, 0.8);
}

/* 内嵌缝线 */
.p-dialog.result-skin .p-dialog-content,
.p-dialog.result-skin .p-dialog-header,
.p-dialog.result-skin .p-dialog-footer {
  background: transparent;
  color: #f1e6d0;
}

.p-dialog.result-skin .p-dialog-header {
  padding: 14px 16px 10px;
  border-bottom: 1px dashed rgba(232, 204, 150, 0.22);
}

.p-dialog.result-skin .p-dialog-footer {
  padding: 10px 16px 14px;
  border-top: 1px dashed rgba(232, 204, 150, 0.22);
}

.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding-right: 8px;
}

.result-header-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 黄铜手数徽章 */
.result-title-tag {
  font-size: 0.92rem;
  font-weight: 800;
  color: #2a1c08;
  padding: 2px 9px;
  border-radius: 8px;
  background: linear-gradient(180deg, #f4dc9e 0%, #c39a4f 100%);
  border: 1px solid #7c5c22;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75), 0 2px 5px rgba(0, 0, 0, 0.55);
}

.result-title-text {
  margin: 0;
  font-size: 1.08rem;
  font-weight: 700;
  color: #f6ecd8;
  letter-spacing: 0.02em;
  text-shadow: 0 1px 0 #000;
}

.result-header-pot {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.pot-label {
  font-size: 0.76rem;
  color: #a08f74;
}

.pot-value {
  font-family: var(--font-display);
  font-size: 1.25rem;
  font-weight: 800;
  color: #ffdf9a;
  text-shadow: 0 1px 0 #000, 0 0 12px rgba(255, 190, 90, 0.3);
}

.result-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: min(72vh, 600px);
  overflow-y: auto;
  padding-right: 4px;
}

/* 胜负横幅：赢=香槟金压印，其余=内凹深槽 */
.result-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.8);
  background: linear-gradient(180deg, #241c13 0%, #130e09 100%);
  box-shadow:
    inset 0 2px 6px rgba(0, 0, 0, 0.85),
    0 1px 0 rgba(255, 255, 255, 0.06);
}

.banner-win {
  background: linear-gradient(180deg, #3a2e1c 0%, #241a10 60%, #160f09 100%);
  border-color: #8a6a32;
  box-shadow:
    inset 0 1px 0 rgba(255, 230, 170, 0.25),
    inset 0 -2px 6px rgba(0, 0, 0, 0.7),
    0 4px 14px rgba(0, 0, 0, 0.55);
}

.banner-icon-box {
  width: 40px;
  height: 40px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: radial-gradient(circle at 32% 26%, #f6e2b4 0%, #d3b070 45%, #8c6c33 100%);
  border: 1px solid #6d5325;
  box-shadow:
    inset 0 -2px 3px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.7),
    0 2px 4px rgba(0, 0, 0, 0.6);
}

.banner-neutral .banner-icon-box {
  background: linear-gradient(180deg, #3b2f22 0%, #241b12 100%);
  border-color: rgba(0, 0, 0, 0.8);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 2px 4px rgba(0, 0, 0, 0.5);
}

.banner-emoji {
  font-size: 1.3rem;
  filter: drop-shadow(0 1px 0 rgba(0, 0, 0, 0.5));
}

.banner-content {
  flex: 1;
  min-width: 0;
}

.banner-title {
  margin: 0 0 2px;
  font-size: 1.04rem;
  font-weight: 800;
  color: #ffdf9a;
  text-shadow: 0 1px 0 #000;
}

.banner-neutral .banner-title {
  color: #f1e6d0;
}

.banner-desc {
  margin: 0;
  font-size: 0.78rem;
  color: #a08f74;
  line-height: 1.4;
}

/* 信息分区：内凹皮革槽 */
.result-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: linear-gradient(180deg, #1d1610 0%, #120d09 100%);
  border: 1px solid rgba(0, 0, 0, 0.8);
  border-radius: 12px;
  padding: 10px 14px;
  box-shadow:
    inset 0 2px 6px rgba(0, 0, 0, 0.8),
    0 1px 0 rgba(255, 255, 255, 0.05);
}

.hero-hand-section {
  border-color: #8a6a32;
  box-shadow:
    inset 0 1px 0 rgba(255, 230, 170, 0.18),
    inset 0 -2px 6px rgba(0, 0, 0, 0.7);
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.section-title {
  font-size: 0.82rem;
  font-weight: 700;
  color: #cbbd9f;
  letter-spacing: 0.04em;
}

.section-badge {
  font-size: 0.7rem;
  font-weight: 700;
  color: #e8cc96;
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(138, 106, 50, 0.6);
  padding: 1px 7px;
  border-radius: 999px;
}

.cards-flex {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.board-card-box {
  padding: 6px 0 2px;
}

.board-empty-hint {
  font-size: 0.78rem;
  color: #a08f74;
  font-style: italic;
}

.hero-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 状态胶囊：黄铜刻字 / 冷钢 / 灰皮 */
.hero-status-chip {
  font-size: 0.7rem;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid transparent;
}

.chip-win {
  color: #2a1c08;
  background: linear-gradient(180deg, #f4dc9e 0%, #c39a4f 100%);
  border-color: #7c5c22;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
}

.chip-showdown {
  color: #dbe7f3;
  background: linear-gradient(180deg, #3a4a5c 0%, #222d3a 100%);
  border-color: #16202b;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.chip-fold {
  color: #b9ad95;
  background: linear-gradient(180deg, #3b2f22 0%, #241b12 100%);
  border-color: rgba(0, 0, 0, 0.8);
}

.hero-hand-type {
  font-size: 0.82rem;
  font-weight: 800;
  color: #ffdf9a;
}

.hero-cards-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}

.hero-eval-tip {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.eval-label {
  font-size: 0.7rem;
  color: #a08f74;
}

.eval-name {
  font-size: 0.9rem;
  font-weight: 800;
  color: #e8cc96;
}

.hero-win-card {
  box-shadow: 0 0 10px rgba(255, 190, 90, 0.35) !important;
}

/* 摊牌玩家行：凸起的皮革小条 */
.contenders-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 2px;
}

.contender-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.8);
  background: linear-gradient(180deg, #2b231a 0%, #1b150f 60%, #120e0a 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    inset 0 -2px 4px rgba(0, 0, 0, 0.65),
    0 3px 8px rgba(0, 0, 0, 0.5);
}

.contender-row.is-winner {
  border-color: #8a6a32;
  box-shadow:
    inset 0 1px 0 rgba(255, 230, 170, 0.28),
    0 0 0 1px rgba(255, 210, 130, 0.3),
    0 0 18px rgba(255, 190, 90, 0.18),
    0 3px 8px rgba(0, 0, 0, 0.5);
}

.contender-row.is-hero {
  border-left: 3px solid #5b8bbf;
}

.contender-row.is-hero.is-winner {
  border-left: 3px solid #c39a4f;
}

.contender-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}

.contender-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.crown-badge {
  font-size: 0.7rem;
  font-weight: 800;
  color: #2a1c08;
  padding: 1px 7px;
  border-radius: 6px;
  background: linear-gradient(180deg, #f4dc9e 0%, #c39a4f 100%);
  border: 1px solid #7c5c22;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
}

.contender-nickname {
  font-size: 0.88rem;
  font-weight: 600;
  color: #f1e6d0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.contender-nickname.is-hero-nick {
  color: #cfe3ff;
  font-weight: 700;
}

.contender-award {
  font-size: 0.9rem;
  font-weight: 800;
  color: #ffdf9a;
  text-shadow: 0 1px 0 #000;
}

.contender-hand-name {
  font-size: 0.76rem;
  color: #a08f74;
}

.badge-gold-text {
  color: #ffdf9a !important;
  font-weight: 700;
}

.contender-cards-flex {
  display: flex;
  align-items: center;
  gap: 4px;
}

.winner-card-border {
  box-shadow: 0 0 8px rgba(255, 190, 90, 0.4) !important;
}

/* 未摊牌独赢 */
.uncontested-box {
  padding: 4px 0;
}

.uncontested-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-radius: 10px;
  background: linear-gradient(180deg, #241c13 0%, #130e09 100%);
  border: 1px solid rgba(0, 0, 0, 0.75);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.8);
}

.crown-icon {
  font-size: 1.05rem;
}

.uncontested-winner-name {
  font-size: 0.9rem;
  font-weight: 800;
  color: #ffdf9a;
}

.uncontested-winner-name.is-hero-nick {
  color: #cfe3ff;
}

.uncontested-win-chip {
  font-size: 0.92rem;
  font-weight: 800;
  color: #8fe0a8;
}

.uncontested-note {
  font-size: 0.74rem;
  color: #a08f74;
}

/* Footer */
.result-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  width: 100%;
  gap: 10px;
}

.result-next-hand {
  flex-basis: 100%;
  color: #e8cc96;
  font-size: 0.78rem;
  text-align: center;
}

.result-next-hand i {
  margin-right: 4px;
}

.history-quick-btn {
  color: #cbbd9f !important;
  font-size: 0.86rem !important;
}

.history-quick-btn:hover {
  color: #ffdf9a !important;
}

/* 主按钮：香槟金立体按键 */
.confirm-btn {
  min-width: 116px;
  height: 46px;
  border-radius: 12px !important;
  background: linear-gradient(180deg, #ffe9ac 0%, #f0c668 45%, #c9973f 100%) !important;
  border: 1px solid #7c5c22 !important;
  color: #35230a !important;
  font-weight: 800 !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.9),
    inset 0 -3px 5px rgba(150, 105, 30, 0.55),
    0 3px 0 #6a4d1a,
    0 8px 16px rgba(0, 0, 0, 0.55) !important;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.55);
}

.confirm-btn:hover {
  filter: brightness(1.05);
}
</style>
