<script setup lang="ts">
import { computed } from 'vue'
import PlayingCard from './PlayingCard.vue'
import { buildHistoryRows, type HistoryRow } from './history-model.ts'
import type { HandResultPublic } from '../../shared/protocol.ts'

/**
 * 牌桌 HUD「手牌历史」：最近若干手的结算战报。
 *
 * 展示型组件——历史模型由 `buildHistoryRows` 纯函数生成（排序、本人高亮、摊牌明细），
 * 展开状态与外部点击收起由父组件（useHudPanels）管。
 */
const props = defineProps<{
  /** 服务端下发的历史（旧 → 新）；展示时反转为最新在最前。 */
  history: readonly HandResultPublic[]
  /** 座位快照，用于把 playerId 还原成昵称。 */
  seats: readonly ({ playerId: string; nickname: string } | null)[]
  /** 当前玩家 id（决定「你」与本人高亮）。 */
  heroPlayerId: string | null
  /** 当前是否展开。 */
  open: boolean
}>()

const emit = defineEmits<{ (event: 'toggle'): void; (event: 'close'): void }>()

/** 昵称以当前座位快照为准；已离座玩家退化为占位文案。 */
function nicknameOf(playerId: string): string {
  return props.seats.find((seat) => seat?.playerId === playerId)?.nickname ?? '已离座玩家'
}

const rows = computed<HistoryRow[]>(() =>
  buildHistoryRows(props.history, {
    heroPlayerId: props.heroPlayerId,
    nicknameOf,
  }),
)

const historyCount = computed(() => props.history.length)
</script>

<template>
  <aside class="hud-anchor hud-history-anchor" aria-label="牌局手牌历史">
    <button
      type="button"
      class="hud-capsule-btn hud-history-pill"
      :class="{ 'is-active': open }"
      :title="open ? '收起历史' : '展开历史'"
      :aria-expanded="open"
      @click="emit('toggle')"
    >
      <i class="pi pi-history hud-capsule-icon" aria-hidden="true" />
      <span class="hud-capsule-label">手牌历史</span>
      <span v-if="historyCount > 0" class="hud-capsule-badge num">{{ historyCount }}</span>
      <i :class="open ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" class="hud-capsule-arrow" aria-hidden="true" />
    </button>

    <Transition name="hud-popover-right">
      <div v-show="open" class="hud-popover hud-history-popover">
        <header class="hud-popover-header">
          <div class="hud-popover-title">
            <i class="pi pi-history" aria-hidden="true" />
            <span>手牌历史</span>
            <span v-if="historyCount > 0" class="hud-popover-badge num">{{ historyCount }}</span>
          </div>
          <button
            type="button"
            class="hud-popover-close-btn"
            title="收起历史"
            aria-label="收起历史"
            @click="emit('close')"
          >
            <i class="pi pi-times" aria-hidden="true" />
          </button>
        </header>

        <div class="hud-history-body">
          <div class="hud-history-list thin-scroll">
            <div v-if="rows.length === 0" class="history-empty">
              <i class="pi pi-folder-open history-empty-icon" aria-hidden="true" />
              <p>暂无已结算的手牌记录</p>
            </div>

            <article
              v-for="entry in rows"
              :key="entry.entry.handId || entry.handNo"
              class="history-card"
              :class="{ 'is-hero-won': entry.heroWon, 'is-hero-showdown': entry.heroShowdown && !entry.heroWon }"
            >
              <!-- 卡片顶栏：局号、状态勋章、总底池 -->
              <header class="history-card-header">
                <div class="history-header-left">
                  <span class="history-hand-tag num">#{{ entry.handNo }}</span>
                  <span v-if="entry.heroWon" class="history-result-badge badge-win">
                    <i class="pi pi-trophy" aria-hidden="true" />
                    <span>你赢得 +{{ entry.heroWonAmount }}</span>
                  </span>
                  <span v-else-if="entry.heroShowdown" class="history-result-badge badge-showdown">
                    跟注到底
                  </span>
                  <span v-else-if="entry.showdown" class="history-result-badge badge-neutral">
                    摊牌对决
                  </span>
                  <span v-else class="history-result-badge badge-fold">
                    弃牌结算
                  </span>
                </div>
                <div class="history-header-right">
                  <span class="history-pot-label">总底池</span>
                  <b class="history-pot-value num">{{ entry.potTotal }}</b>
                </div>
              </header>

              <!-- 公共牌区域（真实卡牌组件渲染） -->
              <div class="history-board-row">
                <span class="history-section-title">公共牌</span>
                <div v-if="entry.board.length > 0" class="history-cards-line">
                  <PlayingCard
                    v-for="card in entry.board"
                    :key="card"
                    size="sm"
                    upright
                    :card="card"
                    class="history-card-item"
                  />
                </div>
                <span v-else class="history-empty-board">翻牌前弃牌（无公共牌）</span>
              </div>

              <!-- 摊牌明细（若有人跟到底开牌） -->
              <div v-if="entry.showdown && entry.revealedPlayers.length > 0" class="history-showdown-section">
                <div class="history-section-header">
                  <span class="history-section-title">摊牌开牌（{{ entry.revealedPlayers.length }} 人亮牌比牌）</span>
                </div>
                <div class="history-revealed-list">
                  <div
                    v-for="p in entry.revealedPlayers"
                    :key="p.playerId"
                    class="history-revealed-row"
                    :class="{ 'is-hero': p.isHero, 'is-winner': p.isWinner }"
                  >
                    <!-- 玩家身份与牌型 -->
                    <div class="revealed-player-info">
                      <div class="revealed-player-name-row">
                        <span v-if="p.isWinner" class="revealed-crown" title="获胜者">🏆</span>
                        <span class="revealed-nickname" :class="{ 'hero-name': p.isHero }">
                          {{ p.isHero ? '你' : p.nickname }}
                        </span>
                        <span v-if="p.isWinner" class="revealed-win-num num">
                          +{{ p.winAmount }}
                        </span>
                      </div>
                      <div class="revealed-hand-badge" :class="{ 'badge-winner': p.isWinner }">
                        {{ p.handName }}
                      </div>
                    </div>

                    <!-- 玩家亮出的 2 张底牌（物理卡牌） -->
                    <div class="revealed-cards-box">
                      <PlayingCard
                        v-for="c in p.cards"
                        :key="c"
                        size="sm"
                        upright
                        :card="c"
                        :class="['revealed-card', { 'winner-card': p.isWinner }]"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <!-- 未摊牌获胜展示（对手全弃牌） -->
              <div v-else class="history-uncontested-section">
                <div v-for="w in entry.winners" :key="w.playerId" class="history-uncontested-winner">
                  <span class="uncontested-crown">🏆</span>
                  <span class="uncontested-name" :class="{ 'hero-name': w.isHero }">
                    {{ w.isHero ? '你' : w.nickname }}
                  </span>
                  <span class="uncontested-text">拿下底池</span>
                  <b class="uncontested-amount num">+{{ w.amount }}</b>
                  <span class="uncontested-note">（其他玩家弃牌，底牌未公开）</span>
                </div>
              </div>
            </article>
          </div>
        </div>
      </div>
    </Transition>
  </aside>
</template>
