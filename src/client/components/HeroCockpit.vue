<script setup lang="ts">
import Button from 'primevue/button'
import ActionBar from './ActionBar.vue'
import PlayingCard from './PlayingCard.vue'
import type { Card } from '../../shared/poker.ts'
import type { LegalAction } from '../../shared/protocol.ts'

/**
 * 牌桌底部「玩家座舱」（Hero Cockpit）。
 *
 * 三种形态互斥：
 *   1. 在座——底牌 + 牌型 + 筹码 + 开局/席位操作，右翼是操作区（ActionBar）；
 *   2. 离座托管——筹码与座位被锁定，可一键坐回；
 *   3. 贵宾观战——未入座，显示空位情况与快速入座。
 *
 * 纯展示 + 事件上抛：所有状态由 `game` store 与父组件算好后传入，
 * 动作（下注/开局/离座/坐回/入座）一律 emit 给父组件发命令。
 */
defineProps<{
  /** 当前是否在座（未离座）。 */
  seated: boolean
  /** 已离座但座位保留。 */
  away: boolean
  /** 本人筹码。 */
  stack: number
  /** 本人本轮已投入（用于「本轮 N」提示）。 */
  committedStreet: number
  /** 本人底牌翻面后的展示牌（翻牌动画用）。 */
  displayHeroCards: readonly Card[]
  /** 本人底牌（数据源）。 */
  myCards: readonly Card[]
  /** 这一手是否在进行（决定底牌是否翻面）。 */
  handActive: boolean
  /** 本人是否已弃牌。 */
  folded: boolean
  /** 当前牌型名（如「一对 A」），无牌型时为空。 */
  handName: string | null
  /** 待入账筹码（本手结束后可用）。 */
  pendingBuyIn: number
  /** 操作区需要的状态。 */
  legalActions: readonly LegalAction[]
  potTotal: number
  currentBet: number
  isMyTurn: boolean
  remainingSeconds: number
  turnSeconds: number
  remainingRatio: number
  turnDeadlineAt: number | null
  clockOffsetMs: number
  blockedReason: string
  online: boolean
  canStartHand: boolean
  hasPlayedHand: boolean
  /** 座位概况（观战态用）。 */
  occupiedCount: number
  maxSeats: number
  emptyCount: number
  isTableFull: boolean
  firstAvailableSeat: number | null
  canSitDown: boolean
  /** 房主是否需要「开始/下一手」按钮（由操作区内部判断）。 */
  isHost: boolean
  /** 是否可重新买入（在座 + 已连接）。 */
  canRebuy: boolean
  /** 是否还能加机器人（房主 + 未开局 + 还有空位）。 */
  canAddBot: boolean
}>()

const emit = defineEmits<{
  (event: 'action', payload: { action: LegalAction['action']; amount?: number }): void
  (event: 'start'): void
  (event: 'leave'): void
  (event: 'exit'): void
  (event: 'rebuy'): void
  (event: 'resit'): void
  (event: 'sit', seat: number): void
  (event: 'addBot'): void
}>()
</script>

<template>
  <footer class="hero">
    <!-- 1. 玩家在座状态（Hero Cockpit） -->
    <div v-if="seated && !away" class="hero-cards hero-cockpit">
      <!-- 左翼：玩家底牌展示与状态资产面板 -->
      <div class="cockpit-wing cockpit-wing--hero">
        <div class="cockpit-cards-group">
          <span class="hero-label sr-only">你的底牌</span>
          <div
            class="cards fan-cards"
            :title="handName ? `你的手牌（${handName}）` : handActive ? '你的底牌' : '等待发牌…'"
          >
            <div
              v-for="cardIdx in [0, 1]"
              :key="`hero-flipper-${cardIdx}`"
              class="hero-card-flipper"
              :class="[
                `fan-card--${cardIdx}`,
                {
                  'is-flipped': handActive && Boolean(displayHeroCards[cardIdx]),
                  'is-dim': Boolean(folded),
                },
              ]"
            >
              <div class="hero-card-inner">
                <!-- 背面（等待下一手发牌时朝向玩家） -->
                <div class="hero-card-face hero-card-face--back">
                  <PlayingCard size="lg" upright hidden />
                </div>
                <!-- 正面（新一手发牌后 3D 翻转朝向玩家） -->
                <div class="hero-card-face hero-card-face--front">
                  <PlayingCard
                    size="lg"
                    upright
                    :card="displayHeroCards[cardIdx] ?? myCards[cardIdx] ?? null"
                    :dimmed="Boolean(folded)"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="cockpit-meta-group">
          <div class="cockpit-badge-row">
            <!-- 当前牌型勋章 -->
            <div v-if="handName" class="hero-hand" :title="handName">
              <span class="hand-icon" aria-hidden="true">♦</span>
              <b class="hand-name">{{ handName }}</b>
            </div>

            <!-- 筹码资产胶囊：可用筹码 + 本人本轮已投入（判断跟注/加注的依据） -->
            <div class="hero-stack" :title="`可用筹码：${stack}`">
              <span class="stack-label">筹码</span>
              <b class="num stack-num">{{ stack }}</b>
              <span v-if="committedStreet > 0" class="hero-bet num" :title="`本轮已投入 ${committedStreet}`">
                本轮 <b>{{ committedStreet }}</b>
              </span>
              <span v-if="pendingBuyIn" class="muted">待入账 {{ pendingBuyIn }}</span>
              <Button
                v-if="seated || away"
                size="small"
                outlined
                class="rebuy-btn"
                :disabled="!canRebuy"
                :title="canRebuy ? '按本桌买入范围重新买入' : '连接后可以重新买入'"
                @click="emit('rebuy')"
              >
                <i class="pi pi-plus" aria-hidden="true" />
                <span>重新买入</span>
              </Button>
            </div>
          </div>

          <!-- 房主开局控制与席位操作 -->
          <div class="hero-seat-actions">
            <Button
              v-if="canStartHand"
              severity="success"
              class="hero-start-btn"
              :title="hasPlayedHand ? '开始下一手牌' : '开始第一手牌'"
              :aria-label="hasPlayedHand ? '开始下一手' : '开始牌局'"
              @click="emit('start')"
            >
              <i class="pi pi-play" aria-hidden="true" />
              <span>{{ hasPlayedHand ? '开始下一手' : '开始牌局' }}</span>
            </Button>
            <!--
              房主专属：加一个机器人陪练。一个人也能把整条流程跑通（下注/摊牌/结算）。
              本手进行中不可加，服务端会拒绝并给出提示。
            -->
            <Button
              v-if="isHost && canAddBot"
              size="small"
              class="sub-action-btn sub-action-btn--bot"
              data-testid="add-bot-btn"
              title="添加一个机器人陪练（单人也能测试完整流程）"
              aria-label="添加机器人"
              @click="emit('addBot')"
            >
              <i class="pi pi-android" aria-hidden="true" />
              <span class="sub-btn-text">加机器人</span>
            </Button>
            <Button size="small" class="sub-action-btn sub-action-btn--leave" :title="'离座（座位与筹码为你保留）'" @click="emit('leave')">
              <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="13" cy="4" r="1.8" />
                <line x1="7" y1="21" x2="10" y2="17" />
                <path d="M16 21l-2-4-3-3 1-6" />
                <path d="M6 12l2-3 4-1 3 3 3 1" />
              </svg>
              <span class="sub-btn-text">离座</span>
            </Button>
            <Button size="small" class="sub-action-btn sub-action-btn--exit" :title="'退出房间（释放座位）'" @click="emit('exit')">
              <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span class="sub-btn-text">退出房间</span>
            </Button>
          </div>
        </div>
      </div>

      <!-- 纵向微晶金线分隔器（宽屏展示） -->
      <div class="cockpit-divider" aria-hidden="true" />

      <!-- 右翼：战术行动与下注控制台（ActionBar 深度熔铸） -->
      <div class="cockpit-wing cockpit-wing--action">
        <ActionBar
          :legal-actions="legalActions"
          :pot-total="potTotal"
          :current-bet="currentBet"
          :my-stack="stack"
          :is-my-turn="isMyTurn"
          :remaining-seconds="remainingSeconds"
          :turn-seconds="turnSeconds"
          :remaining-ratio="remainingRatio"
          :turn-deadline-at="turnDeadlineAt"
          :clock-offset-ms="clockOffsetMs"
          :blocked-reason="blockedReason"
          :enabled="online"
          :can-start-hand="canStartHand"
          :has-played-hand="hasPlayedHand"
          :seated="seated"
          @action="(payload) => emit('action', payload)"
          @start="emit('start')"
          @leave="emit('leave')"
          @exit="emit('exit')"
        />
      </div>
    </div>

    <!-- 2. 离座中状态 -->
    <div v-else-if="seated && away" class="hero-spectator hero-spectator--away">
      <div class="spectator-card">
        <div class="spectator-info">
          <i class="pi pi-pause-circle spectator-icon" aria-hidden="true" />
          <div class="spectator-texts">
            <h3 class="spectator-title">你当前处于离座托管状态</h3>
            <span class="spectator-state">已离座</span>
            <p class="spectator-desc">
              你的位置与 <span class="num">{{ stack }}</span> 筹码已为你妥善锁定
            </p>
          </div>
        </div>
        <div class="spectator-actions">
          <Button severity="success" class="return-seat-btn" :title="'坐回牌桌继续行动'" @click="emit('resit')">
            <svg class="btn-action-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3" />
              <path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z" />
              <path d="M5 18v2" />
              <path d="M19 18v2" />
            </svg>
            <span>坐回牌桌</span>
          </Button>
          <Button severity="secondary" outlined :title="'退出房间'" @click="emit('exit')">
            <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>退出房间</span>
          </Button>
        </div>
      </div>
    </div>

    <!-- 3. 贵宾观战状态（未入座） -->
    <div v-else class="hero-spectator">
      <div class="spectator-card">
        <div class="spectator-info">
          <i class="pi pi-eye spectator-icon" aria-hidden="true" />
          <div class="spectator-texts">
            <div class="spectator-heading">
              <h3 class="spectator-title">贵宾观战席</h3>
              <span class="spectator-badge spectator-state">观战中</span>
              <span class="spectator-seats num">{{ occupiedCount }}/{{ maxSeats }}</span>
            </div>
            <p class="spectator-desc">
              <template v-if="canSitDown">
                <span class="spectator-copy-desktop">牌桌尚有 <b class="num empty-num">{{ emptyCount }}</b> 个空席（共 {{ maxSeats }} 席），轻触桌上空位或点击右侧快速入座</span>
                <span v-if="occupiedCount === 0" class="spectator-copy-mobile">还没有人入座。先选座，再邀请朋友开局。</span>
                <span v-else class="spectator-copy-mobile">还有 {{ emptyCount }} 个空位，点桌面空位或下方按钮入座。</span>
              </template>
              <template v-else-if="isTableFull">
                牌桌已满（{{ occupiedCount }}/{{ maxSeats }} 席），空位出现后即可入座。
              </template>
              <template v-else>
                正在读取牌桌状态，请稍候…
              </template>
            </p>
          </div>
        </div>
        <div class="spectator-actions">
          <Button
            v-if="canSitDown && firstAvailableSeat !== null"
            severity="help"
            class="quick-sit-btn"
            :title="'快速入座'"
            @click="emit('sit', firstAvailableSeat)"
          >
            <i class="pi pi-user-plus" aria-hidden="true" />
            <span>入座 {{ firstAvailableSeat + 1 }} 号席</span>
          </Button>
          <Button severity="secondary" outlined :title="'退出房间'" @click="emit('exit')">
            <svg class="btn-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>返回大厅</span>
          </Button>
        </div>
      </div>
    </div>
  </footer>
</template>
