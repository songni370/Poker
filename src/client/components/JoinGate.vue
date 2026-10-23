<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import Password from 'primevue/password'
import Message from 'primevue/message'
import InputText from 'primevue/inputtext'
import { NICKNAME_MAX, ROOM_PASSWORD_DIGITS } from '../../shared/poker.ts'
import type { RoomInfoResponse } from '../../shared/protocol.ts'

/**
 * 邀请链接落地页：还没加入这个房间时，先填昵称与房间密码进桌。
 *
 * 纯展示 + 事件上抛：房间信息、表单状态、提交中标记都由父组件持有，
 * 这里只负责渲染与把输入同步回去（v-model 双向）。
 */
const props = defineProps<{
  /** 路由里的房间号（用于标题与预检）。 */
  roomId: string
  /** 是否已有凭证（有凭证说明已进桌，不该再显示这个页面）。 */
  hasCredentials: boolean
  /** 是否已有牌局状态（开发模式 mock / 重连时跳过这个页面）。 */
  state: unknown
  /** 房间公开信息（预检结果），可能还在加载。 */
  info: RoomInfoResponse | null
  /** 预检失败的原因。 */
  infoError: string
  /** 提交后的错误提示。 */
  error: string
  /** 是否正在提交。 */
  submitting: boolean
  /** 昵称（双向）。 */
  nickname: string
  /** 房间密码（双向）。 */
  password: string
}>()

const emit = defineEmits<{
  (event: 'submit'): void
  (event: 'back'): void
  (event: 'update:nickname', value: string): void
  (event: 'update:password', value: string): void
}>()

const nicknameModel = computed({
  get: () => props.nickname,
  set: (value: string) => emit('update:nickname', value),
})

const passwordModel = computed({
  get: () => props.password,
  set: (value: string) => emit('update:password', value),
})
</script>

<template>
  <main v-if="!hasCredentials && !state" id="main" class="join-gate">
      <!-- 扑克花色浮雕背景与环境聚光氛围 -->
      <div class="join-backdrop" aria-hidden="true">
        <div class="join-ambient-glow" />
        <div class="join-card-suits">
          <span>♠</span>
          <span>♥</span>
          <span>♦</span>
          <span>♣</span>
        </div>
      </div>

      <div class="join-container">
        <section class="join-card" aria-labelledby="join-gate-title">
          <header class="join-header">
            <div class="badge-tag">
              <span class="badge-icon">♠</span>
              <span>私人牌局 · 邀请制</span>
              <span class="badge-icon">♣</span>
            </div>
            <h1 id="join-gate-title" class="join-title">
              {{ info ? `加入「${info.roomName}」` : '加入这桌牌局' }}
            </h1>
            <p class="join-subtitle">
              朋友邀请你入局切磋，填入昵称与密码即可进桌
            </p>
          </header>

          <!-- 房间对局核心参数卡片 -->
          <div v-if="info" class="room-meta-card">
            <div class="meta-grid">
              <div class="meta-item">
                <span class="meta-item-label">房间号</span>
                <span class="meta-item-val num">#{{ info.roomId }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-item-label">盲注级别</span>
                <span class="meta-item-val num text-gold">{{ info.smallBlind }}/{{ info.bigBlind }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-item-label">当前入座</span>
                <span class="meta-item-val num">{{ info.seated }}/{{ info.maxSeats }} 人</span>
              </div>
              <div class="meta-item">
                <span class="meta-item-label">牌桌状态</span>
                <span class="meta-item-val meta-status">
                  <span class="status-dot" :class="{ 'is-waiting': info.status !== 'playing' }" />
                  <span>{{ info.status === 'playing' ? '对局中' : '等待开局' }}</span>
                </span>
              </div>
            </div>
            <div class="meta-tip">
              <i class="pi pi-info-circle meta-tip-icon" aria-hidden="true" />
              <span>进桌后先以旁观身份观战，点击桌上任意空位即可买入落座参赛</span>
            </div>
          </div>

          <!-- 房间信息加载中骨架 -->
          <div v-else-if="!infoError" class="room-meta-loading">
            <i class="pi pi-spin pi-spinner loading-icon" aria-hidden="true" />
            <span>正在连接房间，读取对局信息…</span>
          </div>

          <!-- 房间信息获取错误提示 -->
          <div v-else class="join-info-error-box" role="alert">
            <i class="pi pi-exclamation-triangle join-info-error-icon" aria-hidden="true" />
            <div class="join-info-error-content">
              <p class="join-info-error-title">房间状态提示</p>
              <p class="join-info-error-desc">{{ infoError }}</p>
            </div>
          </div>

          <!-- 表单报错横条 -->
          <transition name="alert-slide">
            <Message v-if="error" severity="error" :closable="false" class="join-alert" role="alert">
              {{ error }}
            </Message>
          </transition>

          <!-- 昵称与密码输入 -->
          <div class="join-form">
            <label class="field" for="join-nickname">
              <span class="label">
                <span>你的昵称</span>
                <span class="label-sub">在桌内展示给其他牌友</span>
              </span>
              <InputText
                id="join-nickname"
                v-model="nicknameModel"
                :maxlength="NICKNAME_MAX"
                placeholder="例如：小满"
                autocomplete="nickname"
                fluid
                @keyup.enter="emit('submit')"
              />
            </label>

            <label class="field" for="invite-password">
              <span class="label">
                <span>房间密码</span>
                <span class="label-sub">{{ ROOM_PASSWORD_DIGITS }} 位数字</span>
              </span>
              <Password
                input-id="invite-password"
                v-model="passwordModel"
                placeholder="请输入 6 位数字"
                autocomplete="current-password"
                :feedback="false"
                toggle-mask
                :input-props="{ inputmode: 'numeric', maxlength: ROOM_PASSWORD_DIGITS, pattern: '[0-9]{6}' }"
                fluid
                @keyup.enter="emit('submit')"
              />
            </label>
          </div>

          <!-- 操作按钮区 -->
          <div class="join-actions">
            <Button
              class="submit-button join-submit-btn"
              :disabled="submitting || Boolean(infoError)"
              :loading="submitting"
              title="加入这个房间"
              @click="emit('submit')"
            >
              <i class="pi pi-sign-in" aria-hidden="true" />
              <span>进入牌桌</span>
            </Button>
            <Button
              text
              class="join-back-btn"
              title="回到大厅"
              @click="emit('back')"
            >
              <i class="pi pi-home" aria-hidden="true" />
              <span>回大厅</span>
            </Button>
          </div>

          <!-- 入桌须知 -->
          <div class="join-rules-box">
            <div class="rules-header">
              <i class="pi pi-shield rules-icon" aria-hidden="true" />
              <span>入桌须知</span>
            </div>
            <ul class="rules-list">
              <li>进桌后先以旁观身份观战，点击桌上任意空位即可买入落座。</li>
              <li>仅支持虚拟记分筹码，无任何充值提现或兑换，绿色对局。</li>
              <li>断线或刷新网页将保留座位与筹码，重新进入可自动恢复。</li>
            </ul>
          </div>
        </section>
      </div>
  </main>
</template>
