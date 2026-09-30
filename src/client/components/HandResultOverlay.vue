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
    class="vip-dialog result-dialog"
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
  gap: 8px;
}

.result-title-tag {
  font-size: 0.95rem;
  font-weight: 800;
  color: #ffd875;
  background: rgba(255, 216, 117, 0.14);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(255, 216, 117, 0.3);
}

.result-title-text {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
  color: #f1f5f9;
  letter-spacing: 0.02em;
}

.result-header-pot {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.pot-label {
  font-size: 0.78rem;
  color: var(--muted);
}

.pot-value {
  font-size: 1.15rem;
  font-weight: 800;
  color: #ffd875;
}

.result-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: min(72vh, 600px);
  overflow-y: auto;
  padding-right: 4px;
}

/* 战报胜负横幅 */
.result-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.banner-win {
  background: linear-gradient(135deg, rgba(212, 177, 106, 0.22) 0%, rgba(180, 138, 56, 0.12) 100%);
  border-color: rgba(212, 177, 106, 0.45);
  box-shadow: 0 4px 18px rgba(212, 177, 106, 0.12);
}

.banner-icon-box {
  width: 40px;
  height: 40px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.banner-emoji {
  font-size: 1.4rem;
}

.banner-content {
  flex: 1;
}

.banner-title {
  margin: 0 0 2px;
  font-size: 1.05rem;
  font-weight: 700;
  color: #ffd875;
}

.banner-neutral .banner-title {
  color: #e2e8f0;
}

.banner-desc {
  margin: 0;
  font-size: 0.8rem;
  color: var(--muted);
  line-height: 1.35;
}

/* 模块区域卡片 */
.result-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #111722;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-md);
  padding: 10px 14px;
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.section-title {
  font-size: 0.85rem;
  font-weight: 700;
  color: #94a3b8;
  letter-spacing: 0.02em;
}

.section-badge {
  font-size: 0.72rem;
  font-weight: 700;
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 6px;
  border-radius: 999px;
}

/* 卡牌横排容器 */
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
  font-size: 0.8rem;
  color: var(--muted);
  font-style: italic;
}

/* 你的底牌专区 */
.hero-hand-section {
  background: #16202e;
  border-color: rgba(96, 165, 250, 0.3);
}

.hero-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hero-status-chip {
  font-size: 0.72rem;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 999px;
}

.chip-win {
  background: rgba(212, 177, 106, 0.25);
  color: #ffd875;
  border: 1px solid rgba(212, 177, 106, 0.4);
}

.chip-showdown {
  background: rgba(96, 165, 250, 0.2);
  color: #93c5fd;
  border: 1px solid rgba(96, 165, 250, 0.35);
}

.chip-fold {
  background: rgba(148, 163, 184, 0.14);
  color: #94a3b8;
}

.hero-hand-type {
  font-size: 0.84rem;
  font-weight: 700;
  color: #ffd875;
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
  font-size: 0.72rem;
  color: var(--muted);
}

.eval-name {
  font-size: 0.92rem;
  font-weight: 700;
  color: #60a5fa;
}

.hero-win-card {
  box-shadow: 0 0 10px rgba(212, 177, 106, 0.35) !important;
}

/* 摊牌开牌玩家列表 */
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
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-sm);
  transition: all 0.2s ease;
}

.contender-row.is-winner {
  background: rgba(212, 177, 106, 0.09);
  border-color: rgba(212, 177, 106, 0.4);
  box-shadow: 0 2px 10px rgba(212, 177, 106, 0.08);
}

.contender-row.is-hero {
  border-left: 3px solid #60a5fa;
}

.contender-row.is-hero.is-winner {
  border-left: 3px solid #ffd875;
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
  font-size: 0.72rem;
  font-weight: 800;
  color: #ffd875;
  background: rgba(212, 177, 106, 0.2);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(212, 177, 106, 0.35);
}

.contender-nickname {
  font-size: 0.88rem;
  font-weight: 600;
  color: #e2e8f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.contender-nickname.is-hero-nick {
  color: #93c5fd;
  font-weight: 700;
}

.contender-award {
  font-size: 0.88rem;
  font-weight: 800;
  color: #ffd875;
}

.contender-hand-name {
  font-size: 0.78rem;
  color: var(--muted);
}

.badge-gold-text {
  color: #fcd34d !important;
  font-weight: 600;
}

.contender-cards-flex {
  display: flex;
  align-items: center;
  gap: 4px;
}

.winner-card-border {
  box-shadow: 0 0 8px rgba(212, 177, 106, 0.4) !important;
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
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--radius-sm);
}

.crown-icon {
  font-size: 1.1rem;
}

.uncontested-winner-name {
  font-size: 0.92rem;
  font-weight: 700;
  color: #ffd875;
}

.uncontested-winner-name.is-hero-nick {
  color: #60a5fa;
}

.uncontested-win-chip {
  font-size: 0.95rem;
  font-weight: 800;
  color: #34d399;
}

.uncontested-note {
  font-size: 0.75rem;
  color: var(--muted);
}

/* Footer 操作栏 */
.result-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  width: 100%;
  gap: 12px;
}

.result-next-hand { flex-basis: 100%; color: #ffd875; font-size: 0.8rem; text-align: center; }
.result-next-hand i { margin-right: 4px; }

.history-quick-btn {
  color: var(--muted) !important;
  font-size: 0.88rem !important;
}

.history-quick-btn:hover {
  color: #ffd875 !important;
}

.confirm-btn {
  min-width: 110px;
  background: linear-gradient(135deg, #d4b16a 0%, #b48a38 100%) !important;
  border-color: #d4b16a !important;
  color: #0f141b !important;
  font-weight: 700 !important;
}

.confirm-btn:hover {
  filter: brightness(1.1);
}
</style>
