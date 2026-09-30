<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Password from 'primevue/password'
import { NICKNAME_MAX, ROOM_ID_DIGITS, ROOM_NAME_MAX, ROOM_PASSWORD_DIGITS, TABLE_RULES } from '../../shared/poker.ts'
import { SessionError, connectRoom, createRoom as apiCreateRoom, joinRoom as apiJoinRoom } from '../net/session.ts'
import { useRoomStore } from '../stores/room.ts'

/**
 * 大厅：加入房间 / 创建房间
 *
 * 默认展示「加入房间」，支持通过 Segmented Tab 切换到「创建房间」。
 * 保持端到端测试与底层凭证服务完全兼容。
 */
const router = useRouter()
const route = useRoute()
const room = useRoomStore()

/** 当前激活的操作面板：默认进入展示「加入房间」 */
const activeTab = ref<'join' | 'create'>('join')

/** 服务器同时开放的桌数上限与当前占用（服务端全局最多 3 桌）。 */
const roomLimit = ref<{ open: number; max: number } | null>(null)

onMounted(async () => {
  // 支持通过 URL 参数 ?tab=create 直接打开创建面板
  if (route.query.tab === 'create') {
    activeTab.value = 'create'
  }

  try {
    const health = (await (await fetch('/api/health')).json()) as { rooms: number; maxRooms: number }
    roomLimit.value = { open: health.rooms, max: health.maxRooms }
  } catch {
    roomLimit.value = null
  }
})

const roomLimitReached = computed(() => Boolean(roomLimit.value && roomLimit.value.open >= roomLimit.value.max))

const nickname = ref(room.nickname)
const roomName = ref('')
const createPassword = ref('')
const joinCode = ref('')
const joinPassword = ref('')
/** 房间号输入框：校验失败时把焦点放回。 */
const codeField = ref<{ $el?: HTMLInputElement } | null>(null)

/**
 * 初始筹码 = 玩家上桌最低要买入多少（默认 2000）；买入上限 = 一次最多带多少上桌（默认 5000）。
 * 固定 9 人桌。
 */
const minBuyIn = ref(TABLE_RULES.startingStack)
const buyInMax = ref(TABLE_RULES.maxBuyInDefault)
const smallBlind = ref(TABLE_RULES.smallBlind)
const bigBlind = ref(TABLE_RULES.bigBlind)
const turnSeconds = ref(TABLE_RULES.turnSeconds)
const nextHandSeconds = ref(TABLE_RULES.nextHandSeconds)
const buyInFloor = computed(() => Math.max(TABLE_RULES.minBuyInFloor, 10 * Number(bigBlind.value)))
const error = ref('')
const busy = ref(false)

function switchTab(tab: 'join' | 'create') {
  activeTab.value = tab
  error.value = ''
}

function problem(): string | null {
  const name = nickname.value.trim()
  if (!name) return '请先填写昵称，其他玩家会看到这个名字。'
  if (name.length > NICKNAME_MAX) return `昵称最多 ${String(NICKNAME_MAX)} 个字符。`
  if (activeTab.value === 'create') {
    if (roomName.value.trim().length > ROOM_NAME_MAX) return `房间名最多 ${String(ROOM_NAME_MAX)} 个字符。`
    const small = Number(smallBlind.value)
    const big = Number(bigBlind.value)
    if (!Number.isInteger(small) || small < 1 || small >= TABLE_RULES.maxBigBlind) {
      return `小盲需为 1–${String(TABLE_RULES.maxBigBlind - 1)} 的整数。`
    }
    if (!Number.isInteger(big) || big <= small || big > TABLE_RULES.maxBigBlind) {
      return `大盲需高于小盲，且不超过 ${String(TABLE_RULES.maxBigBlind)}。`
    }
    if (!Number.isInteger(turnSeconds.value) || turnSeconds.value < TABLE_RULES.minTurnSeconds ||
      turnSeconds.value > TABLE_RULES.maxTurnSeconds) {
      return `每次行动时间需为 ${String(TABLE_RULES.minTurnSeconds)}–${String(TABLE_RULES.maxTurnSeconds)} 秒。`
    }
    if (!Number.isInteger(nextHandSeconds.value) || nextHandSeconds.value < 0 ||
      nextHandSeconds.value > TABLE_RULES.maxNextHandSeconds) {
      return `下一手间隔需为 0–${String(TABLE_RULES.maxNextHandSeconds)} 秒（0 表示手动开局）。`
    }
    const min = Number(minBuyIn.value)
    const max = Number(buyInMax.value)
    const range = `${String(TABLE_RULES.minBuyInFloor)}–${String(TABLE_RULES.maxBuyInLimit)}`
    if (!Number.isFinite(min) || min < TABLE_RULES.minBuyInFloor || min > TABLE_RULES.maxBuyInLimit) {
      return `初始筹码需在 ${range} 之间。`
    }
    if (!Number.isFinite(max) || max < TABLE_RULES.minBuyInFloor || max > TABLE_RULES.maxBuyInLimit) {
      return `买入上限需在 ${range} 之间。`
    }
    if (min < buyInFloor.value) return `最低买入至少为 10 个大盲（${String(buyInFloor.value)}）。`
    if (max < buyInFloor.value) return `买入上限至少为 10 个大盲（${String(buyInFloor.value)}）。`
    if (max < min) return '买入上限不能低于初始筹码。'
  }
  return null
}

function describe(cause: unknown): string {
  if (cause instanceof SessionError) return cause.message
  return '无法连接服务器，请确认服务已启动后重试。'
}

async function createRoom(): Promise<void> {
  error.value = ''
  const invalid = problem()
  if (invalid) {
    error.value = invalid
    return
  }
  if (!new RegExp(`^\\d{${ROOM_PASSWORD_DIGITS}}$`).test(createPassword.value)) {
    error.value = `房间密码必须是 ${String(ROOM_PASSWORD_DIGITS)} 位数字。`
    return
  }
  busy.value = true
  try {
    const credentials = await apiCreateRoom({
      nickname: nickname.value.trim(),
      password: createPassword.value,
      roomName: roomName.value.trim() || undefined,
      minBuyIn: Number(minBuyIn.value),
      buyInMax: Number(buyInMax.value),
      smallBlind: Number(smallBlind.value),
      bigBlind: Number(bigBlind.value),
      turnSeconds: Number(turnSeconds.value),
      nextHandSeconds: Number(nextHandSeconds.value),
    })
    room.setCredentials(credentials)
    connectRoom(credentials)
    await router.push({ name: 'table', params: { roomId: credentials.roomId } })
  } catch (cause) {
    error.value = describe(cause)
  } finally {
    busy.value = false
  }
}

async function joinRoom(): Promise<void> {
  error.value = ''
  const invalid = problem()
  if (invalid) {
    error.value = invalid
    return
  }
  const code = joinCode.value.trim()
  if (code.length !== ROOM_ID_DIGITS || !/^\d+$/.test(code)) {
    error.value = `房间号是 ${String(ROOM_ID_DIGITS)} 位数字（例如 482913），也可以直接打开朋友发来的邀请链接。`
    codeField.value?.$el?.focus()
    return
  }
  if (!new RegExp(`^\\d{${ROOM_PASSWORD_DIGITS}}$`).test(joinPassword.value)) {
    error.value = `请输入 ${String(ROOM_PASSWORD_DIGITS)} 位数字房间密码。`
    return
  }
  busy.value = true
  try {
    const credentials = await apiJoinRoom(code, { nickname: nickname.value.trim(), password: joinPassword.value })
    room.setCredentials(credentials)
    connectRoom(credentials)
    await router.push({ name: 'table', params: { roomId: credentials.roomId } })
  } catch (cause) {
    error.value = describe(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main id="main" class="lobby">
    <!-- 背景氛围微光与扑克浮印装饰 -->
    <div class="lobby-backdrop" aria-hidden="true">
      <div class="ambient-glow" />
      <div class="ambient-card-suits">
        <span class="suit">♠</span>
        <span class="suit">♥</span>
        <span class="suit">♣</span>
        <span class="suit">♦</span>
      </div>
    </div>

    <div class="page-container">
      <!-- 顶部 Hero 区域 -->
      <header class="hero">
        <div class="badge-tag">
          <span class="badge-icon">♠</span>
          <span>私人牌局 · 邀请制</span>
          <span class="badge-icon">♣</span>
        </div>
        <h1 class="hero-title">开一桌德州</h1>
        <p class="hero-lede">
          仅支持虚拟记分筹码，无任何充值提现，绿色对局
        </p>
      </header>

      <!-- 核心操作卡片 -->
      <div class="main-card">
        <!-- 切换组件 (Segmented Control / TabList) -->
        <div class="tab-control-wrap">
          <div class="tab-control" role="tablist" aria-label="房间操作选项">
            <button id="tab-join" type="button" role="tab" class="tab-btn"
              :class="{ 'is-active': activeTab === 'join' }" :aria-selected="activeTab === 'join'"
              aria-controls="panel-join" @click="switchTab('join')">
              <i class="pi pi-sign-in tab-icon" aria-hidden="true" />
              <span class="tab-label">加入房间</span>
            </button>
            <button id="tab-create" type="button" role="tab" class="tab-btn"
              :class="{ 'is-active': activeTab === 'create' }" :aria-selected="activeTab === 'create'"
              aria-controls="panel-create" @click="switchTab('create')">
              <i class="pi pi-plus tab-icon" aria-hidden="true" />
              <span class="tab-label">创建房间</span>
            </button>
          </div>
        </div>

        <!-- 错误提示横条 -->
        <transition name="alert-slide">
          <Message v-if="error" severity="error" :closable="false" class="alert-message" role="alert">
            {{ error }}
          </Message>
        </transition>

        <!-- 共享昵称输入区（所有模式均需） -->
        <div class="field nickname-field">
          <label class="label" for="nickname">
            <span>你的昵称</span>
            <span class="label-sub">在桌内展示给其他牌友</span>
          </label>
          <div class="input-wrap">
            <InputText id="nickname" v-model="nickname" :maxlength="NICKNAME_MAX" placeholder="例如：小满"
              autocomplete="nickname" fluid />
          </div>
        </div>

        <!-- 面板 1：加入房间（默认展示） -->
        <section v-show="activeTab === 'join'" id="panel-join" class="tab-panel anim-fade" role="tabpanel"
          aria-labelledby="tab-join">

          <div class="field-grid">
            <label class="field" for="join-code">
              <span class="label">房间号</span>
              <InputText id="join-code" ref="codeField" v-model="joinCode" :maxlength="ROOM_ID_DIGITS"
                placeholder="例如：482913" inputmode="numeric" autocomplete="off" spellcheck="false" fluid />
            </label>

            <label class="field" for="join-room-password">
              <span class="label">房间密码</span>
              <Password input-id="join-room-password" v-model="joinPassword" placeholder="6 位数字密码"
                autocomplete="current-password" :feedback="false" toggle-mask
                :input-props="{ inputmode: 'numeric', maxlength: ROOM_PASSWORD_DIGITS, pattern: '[0-9]{6}' }" fluid />
            </label>
          </div>

          <Button class="submit-button join-btn" :disabled="busy" title="加入这个房间" @click="joinRoom">
            <i class="pi pi-sign-in" aria-hidden="true" />
            <span>进入牌桌</span>
          </Button>

          <!-- 房间对局规则提示 -->
          <div class="rules-box">
            <div class="rules-header">
              <i class="pi pi-info-circle rules-icon" aria-hidden="true" />
              <span>入桌须知</span>
            </div>
            <ul class="rules-list">
              <li>行动时间由房主设定；超时系统将自动过牌或弃牌。</li>
              <li>断线或关闭网页后座位保留，重新进入自动恢复。</li>
              <li>绝不泄露任何玩家未公开的私有底牌，纯随机公正发牌。</li>
            </ul>
          </div>
        </section>

        <!-- 面板 2：创建房间 -->
        <section v-show="activeTab === 'create'" id="panel-create" class="tab-panel anim-fade" role="tabpanel"
          aria-labelledby="tab-create">

          <div class="field-grid">
            <label class="field" for="room-name">
              <span class="label">房间名称（可选）</span>
              <InputText id="room-name" v-model="roomName" :maxlength="ROOM_NAME_MAX" placeholder="例如：周五夜局" fluid />
            </label>

            <label class="field" for="create-room-password">
              <span class="label">房间密码（{{ ROOM_PASSWORD_DIGITS }} 位数字）</span>
              <Password input-id="create-room-password" v-model="createPassword" placeholder="请设置 6 位数字密码"
                autocomplete="new-password" :feedback="false" toggle-mask
                :input-props="{ inputmode: 'numeric', maxlength: ROOM_PASSWORD_DIGITS, pattern: '[0-9]{6}' }" fluid />
            </label>
          </div>

          <div class="field-grid">
            <label class="field" for="small-blind">
              <span class="label">小盲</span>
              <InputNumber input-id="small-blind" name="smallBlind" v-model="smallBlind" :min="1"
                :max="TABLE_RULES.maxBigBlind - 1" :step="1" :use-grouping="false" fluid />
            </label>
            <label class="field" for="big-blind">
              <span class="label">大盲</span>
              <InputNumber input-id="big-blind" name="bigBlind" v-model="bigBlind" :min="2"
                :max="TABLE_RULES.maxBigBlind" :step="1" :use-grouping="false" fluid />
            </label>
          </div>

          <div class="field-grid buyin-grid">
            <label class="field" for="min-buy-in">
              <span class="label">初始筹码（最低买入）</span>
              <InputNumber input-id="min-buy-in" v-model="minBuyIn" :min="buyInFloor" :max="TABLE_RULES.maxBuyInLimit"
                :step="smallBlind || 1" :use-grouping="false" fluid />
            </label>

            <label class="field" for="buy-in-max">
              <span class="label">买入上限</span>
              <InputNumber input-id="buy-in-max" v-model="buyInMax" :min="buyInFloor" :max="TABLE_RULES.maxBuyInLimit"
                :step="smallBlind || 1" :use-grouping="false" fluid />
            </label>
          </div>

          <div class="field-grid">
            <label class="field" for="turn-seconds">
              <span class="label">玩家思考时间（秒）</span>
              <InputNumber input-id="turn-seconds" v-model="turnSeconds" :min="TABLE_RULES.minTurnSeconds"
                :max="TABLE_RULES.maxTurnSeconds" :step="1" :use-grouping="false" fluid />
            </label>
            <label class="field" for="next-hand-seconds">
              <span class="label">下一手自动开始间隔（秒）</span>
              <InputNumber input-id="next-hand-seconds" v-model="nextHandSeconds" :min="0"
                :max="TABLE_RULES.maxNextHandSeconds" :step="1" :use-grouping="false" fluid />
            </label>
          </div>
          <p class="hint buyin-hint">下一手间隔填 0 时，由房主手动开局；人数不足时不会自动发牌。</p>

          <p class="hint buyin-hint">
            玩家落座时在 {{ minBuyIn || TABLE_RULES.startingStack }}–{{ buyInMax || TABLE_RULES.maxBuyInDefault }}
            之间自主选择带入筹码（至少 10 个大盲，按小盲 {{ smallBlind || TABLE_RULES.smallBlind }} 取整）。
          </p>

          <Button class="submit-button create-btn" :disabled="busy || roomLimitReached"
            :title="roomLimitReached ? '服务器桌数已达上限' : '创建房间并进入等待区'" @click="createRoom">
            <i class="pi pi-plus" aria-hidden="true" />
            <span>创建牌桌</span>
          </Button>
        </section>
      </div>

    </div>
  </main>
</template>

<style scoped>
.lobby {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: var(--space-4) var(--space-2) var(--space-5);
  min-height: 100%;
  overflow-x: hidden;
}

/* 背景氛围与扑克花色浮雕 */
.lobby-backdrop {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
}

.ambient-glow {
  position: absolute;
  top: -150px;
  left: 50%;
  transform: translateX(-50%);
  width: 900px;
  height: 520px;
  background: radial-gradient(ellipse 65% 50% at 50% 30%, rgba(22, 75, 64, 0.42) 0%, rgba(16, 21, 27, 0) 70%);
  filter: blur(48px);
}

.ambient-card-suits {
  position: absolute;
  top: 40px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: clamp(60px, 18vw, 220px);
  opacity: 0.045;
  font-size: clamp(4rem, 10vw, 8rem);
  user-select: none;
  color: var(--gold);
}

/* 主内容容器 */
.page-container {
  position: relative;
  z-index: 1;
  width: min(100%, 540px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  animation: rise-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
}

/* 顶部 Hero 区域 */
.hero {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
}

.badge-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 14px;
  font-size: 0.8rem;
  letter-spacing: 0.16em;
  color: var(--gold);
  background: rgba(212, 177, 106, 0.08);
  border: 1px solid var(--gold-soft);
  border-radius: 999px;
  backdrop-filter: blur(8px);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
}

.badge-icon {
  font-size: 0.75rem;
  opacity: 0.85;
}

.hero-title {
  margin: 4px 0 0;
  font-size: clamp(2.1rem, 6vw, 2.75rem);
  font-weight: 700;
  color: #ffffff;
  background: linear-gradient(180deg, #ffffff 30%, #e2e8f0 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  letter-spacing: -0.02em;
  filter: drop-shadow(0 2px 12px rgba(0, 0, 0, 0.35));
}

.hero-lede {
  margin: 0;
  max-width: 46ch;
  color: var(--muted);
  font-size: 0.88rem;
  line-height: 1.6;
}

/* 核心磨砂玻璃卡片 */
.main-card {
  position: relative;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  padding: clamp(20px, 4vw, 32px);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* Segmented Control 切换组件 */
.tab-control-wrap {
  margin-bottom: var(--space-1);
}

.tab-control {
  position: relative;
  display: flex;
  background: rgba(13, 18, 24, 0.88);
  padding: 4px;
  border-radius: var(--radius-md);
  border: 1px solid rgba(255, 255, 255, 0.07);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.3);
}

.tab-btn {
  flex: 1;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  padding: 0 16px;
  user-select: none;
}

.tab-btn:hover:not(.is-active) {
  color: var(--text);
  background: rgba(255, 255, 255, 0.04);
}

.tab-btn.is-active {
  color: #ffffff;
  background: linear-gradient(180deg, #243240 0%, #1a2530 100%);
  border: 1px solid rgba(212, 177, 106, 0.35);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.tab-icon {
  font-size: 0.9rem;
  color: var(--gold);
}

.tab-btn.is-active .tab-icon {
  color: #ffd875;
}

/* 错误告警 */
.alert-message {
  margin: 0 0 var(--space-1);
  border-radius: var(--radius-sm);
}

.alert-slide-enter-active,
.alert-slide-leave-active {
  transition: all 0.22s ease-out;
}

.alert-slide-enter-from,
.alert-slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* 表单字段样式 */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.nickname-field {
  padding-bottom: 18px;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.12);
  margin-bottom: 8px;
}

.label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 0.84rem;
  font-weight: 500;
  color: var(--muted);
}

.label-sub {
  font-size: 0.76rem;
  color: #6f7d88;
}

.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}

@media (max-width: 480px) {
  .field-grid {
    grid-template-columns: 1fr;
  }
}

.tab-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.panel-desc {
  margin-bottom: -4px;
}

.panel-hint {
  margin: 0;
  font-size: 0.82rem;
  color: #8c9ba5;
  line-height: 1.5;
}

/* 操作提交按钮 */
.submit-button {
  width: 100%;
  min-height: 48px;
  margin-top: 6px;
  font-size: 1rem;
  letter-spacing: 0.02em;
  border-radius: var(--radius-md);
  box-shadow: 0 6px 20px rgba(48, 132, 218, 0.28);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.submit-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 24px rgba(48, 132, 218, 0.38);
}

.submit-button:active:not(:disabled) {
  transform: translateY(0);
}

.create-btn {
  background: linear-gradient(135deg, #1b7a63 0%, #135d4b 100%) !important;
  border-color: #279e81 !important;
  box-shadow: 0 6px 20px rgba(23, 108, 83, 0.35) !important;
}

.create-btn:hover:not(:disabled) {
  box-shadow: 0 8px 26px rgba(23, 108, 83, 0.45) !important;
}

.buyin-hint {
  font-size: 0.78rem;
  color: #7d8c97;
  margin-top: -6px;
}

/* 入桌须知规则框 */
.rules-box {
  background: rgba(13, 18, 24, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rules-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--gold);
}

.rules-icon {
  font-size: 0.85rem;
}

.rules-list {
  margin: 0;
  padding-left: 1.1em;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.78rem;
  line-height: 1.6;
  color: var(--muted);
}

@media (max-width: 520px) {
  .lobby {
    padding-top: var(--space-2);
  }
}
</style>
