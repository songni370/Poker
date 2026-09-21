<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { NICKNAME_MAX, TABLE_RULES } from '../../shared/poker.ts'
import {
  SessionError,
  connectRoom,
  disconnectRoom,
  fetchRoomInfo,
  forgetCredentials,
  joinRoom as apiJoinRoom,
  loadCredentials,
  nextRequestId,
  sendCommand,
  useSessionStore,
} from '../net/session.ts'
import { useGameStore } from '../stores/game.ts'
import { useRoomStore } from '../stores/room.ts'

/**
 * 房间等待区（路由 /room/:roomId）。
 *
 * 座位、准备与开局全部以服务端快照为准：本页只发送 seat.take / room.ready / game.start，
 * 收到 hand.started（phase 不再是 waiting）后自动进入牌桌。
 */
const props = defineProps<{ roomId: string }>()

const router = useRouter()
const room = useRoomStore()
const game = useGameStore()
const session = useSessionStore()

const joinName = ref('')
const localError = ref('')
const joinBusy = ref(false)

const error = computed(() => session.lastError?.message ?? localError.value)
const notice = computed(() => (session.lastError ? '' : session.notice))

const maxSeats = computed(() => game.state?.maxSeats ?? room.credentials?.maxSeats ?? 6)
const seatIndexes = computed(() => Array.from({ length: maxSeats.value }, (_, index) => index))

/** 座位占用情况来自服务端公共状态（下标即座位号）。 */
const seated = computed<Record<number, string>>(() => {
  const result: Record<number, string> = {}
  game.seats.forEach((seat, index) => {
    if (seat) result[index] = seat.nickname
  })
  return result
})
const mySeat = computed(() => game.self?.seat ?? null)
const myReady = computed(() => (mySeat.value === null ? false : (game.seats[mySeat.value]?.ready ?? false)))
const occupiedCount = computed(() => game.seats.filter(Boolean).length)
const canStart = computed(
  () =>
    room.isHost &&
    mySeat.value !== null &&
    occupiedCount.value >= TABLE_RULES.minSeats &&
    (game.state?.phase ?? 'waiting') === 'waiting',
)

function seatLabel(index: number): string {
  const name = seated.value[index]
  if (name) return `${String(index + 1)} 号座位，${name}${index === mySeat.value ? '（你）' : ''}`
  return `${String(index + 1)} 号座位，空位，可入座`
}

function takeSeat(index: number): void {
  localError.value = ''
  if (!room.hasCredentials) {
    localError.value = '请先填写昵称加入房间，再选择座位。'
    return
  }
  if (seated.value[index]) {
    localError.value = '该座位已被占用，请换一个空位。'
    return
  }
  if (!sendCommand({ type: 'seat.take', requestId: nextRequestId(), seat: index })) {
    localError.value = '还未连接到服务器，请稍候再试。'
  }
}

function leaveSeat(): void {
  localError.value = ''
  if (!sendCommand({ type: 'seat.leave', requestId: nextRequestId() })) {
    localError.value = '还未连接到服务器，请稍候再试。'
  }
}

function toggleReady(): void {
  localError.value = ''
  if (!sendCommand({ type: 'room.ready', requestId: nextRequestId(), ready: !myReady.value })) {
    localError.value = '还未连接到服务器，请稍候再试。'
  }
}

function startHand(): void {
  localError.value = ''
  if (!sendCommand({ type: 'game.start', requestId: nextRequestId() })) {
    localError.value = '还未连接到服务器，请稍候再试。'
  }
}

async function copyInvite(): Promise<void> {
  localError.value = ''
  try {
    await navigator.clipboard.writeText(room.inviteUrl)
    session.setNotice('邀请链接已复制，发给朋友即可。')
  } catch {
    localError.value = `复制失败，请手动复制：${room.inviteUrl}`
  }
}

async function fillIdentity(): Promise<void> {
  localError.value = ''
  session.clearError()
  const name = joinName.value.trim()
  if (!name) {
    localError.value = '请填写昵称。'
    return
  }
  if (name.length > NICKNAME_MAX) {
    localError.value = `昵称最多 ${String(NICKNAME_MAX)} 个字符。`
    return
  }
  joinBusy.value = true
  try {
    const credentials = await apiJoinRoom(props.roomId, { nickname: name })
    room.setCredentials(credentials)
    connectRoom(credentials)
  } catch (cause) {
    localError.value = cause instanceof SessionError ? cause.message : '加入失败，请稍后重试。'
  } finally {
    joinBusy.value = false
  }
}

async function leaveRoom(): Promise<void> {
  disconnectRoom()
  forgetCredentials(props.roomId)
  room.clear()
  await router.push({ name: 'lobby' })
}

onMounted(async () => {
  const credentials = room.credentials?.roomId === props.roomId ? room.credentials : loadCredentials(props.roomId)
  if (credentials) {
    room.setCredentials(credentials)
    connectRoom(credentials)
    return
  }
  // 没有本地身份：先预检房间，再把昵称表单交给访客。
  try {
    await fetchRoomInfo(props.roomId)
  } catch (cause) {
    await router.push({
      name: 'error',
      query: { kind: 'room', code: cause instanceof SessionError ? cause.code : 'room_not_found' },
    })
  }
})

// 牌局真的开打（进入某条街）才进牌桌；等待中与两手之间的结算态都不弹走用户。
watch(
  () => game.state?.phase,
  (phase) => {
    if (phase === 'preflop' || phase === 'flop' || phase === 'turn' || phase === 'river') {
      void router.push({ name: 'table', params: { roomId: props.roomId } })
    }
  },
)
</script>

<template>
  <main id="main" class="waiting">
    <header class="bar">
      <h1 class="bar-title">{{ room.credentials?.roomName || '等待开局' }}</h1>
      <span class="stat">
        <span>盲注</span>
        <b class="num">{{ TABLE_RULES.smallBlind }}/{{ TABLE_RULES.bigBlind }}</b>
      </span>
      <span class="stat">
        <span>已入座</span>
        <b class="num">{{ occupiedCount }}/{{ maxSeats }}</b>
      </span>
      <span class="bar-spacer" />
      <Button size="small" outlined :title="'复制邀请链接给朋友'" @click="copyInvite">
        <i class="pi pi-link" aria-hidden="true" />
        <span>复制邀请链接</span>
      </Button>
      <Button size="small" text :title="'退出房间并清除本地身份'" @click="leaveRoom">
        <i class="pi pi-sign-out" aria-hidden="true" />
        <span>退出</span>
      </Button>
    </header>

    <div class="page">
      <Message v-if="error" severity="error" :closable="false" role="alert">{{ error }}</Message>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>

      <!-- 邀请链接落地但本地没有身份：先补昵称，不泄露房间细节。 -->
      <section v-if="!room.hasCredentials" class="panel" aria-labelledby="identity-title">
        <h2 id="identity-title" class="panel-title">加入这桌牌局</h2>
        <p class="hint">房间号 {{ roomId }}。填写昵称后即可选择座位。</p>
        <label class="field" for="join-name">
          <span class="label">你的昵称</span>
          <InputText id="join-name" v-model="joinName" :maxlength="NICKNAME_MAX" placeholder="例如：小满" fluid />
        </label>
        <Button :title="'确认昵称并继续'" @click="fillIdentity">
          <i class="pi pi-check" aria-hidden="true" />
          <span>加入房间</span>
        </Button>
      </section>

      <template v-else>
        <section class="panel" aria-labelledby="seats-title">
          <h2 id="seats-title" class="panel-title">座位</h2>
          <p class="hint">选一个空位坐下；人齐后由主持人开局。</p>

          <ul class="seats">
            <li v-for="index in seatIndexes" :key="index">
              <button
                type="button"
                class="seat"
                :class="{ 'is-taken': Boolean(seated[index]), 'is-mine': mySeat === index }"
                :aria-label="seatLabel(index)"
                :aria-pressed="mySeat === index"
                @click="takeSeat(index)"
              >
                <span class="seat-no num">{{ index + 1 }}</span>
                <span class="seat-name">{{ seated[index] ?? '空位' }}</span>
                <span v-if="index === mySeat" class="badge" aria-hidden="true">你</span>
                <span v-else-if="seated[index]" class="badge badge--ready" aria-hidden="true">已就座</span>
              </button>
            </li>
          </ul>

          <div class="actions">
            <Button v-if="mySeat === null" disabled :title="'请先在上方选择一个空位'">
              <i class="pi pi-user-plus" aria-hidden="true" />
              <span>请先选择座位</span>
            </Button>
            <template v-else>
              <Button :title="myReady ? '取消准备状态' : '标记为已准备'" @click="toggleReady">
                <i :class="myReady ? 'pi pi-times' : 'pi pi-check'" aria-hidden="true" />
                <span>{{ myReady ? '取消准备' : '我准备好了' }}</span>
              </Button>
              <Button outlined :title="'离开座位，回到旁观状态'" @click="leaveSeat">
                <i class="pi pi-sign-out" aria-hidden="true" />
                <span>离座</span>
              </Button>
            </template>

            <Button
              v-if="room.isHost"
                    :disabled="!canStart"
              :title="canStart ? '开始第一手牌' : `至少需要 ${String(TABLE_RULES.minSeats)} 人入座并且你在座位上`"
              @click="startHand"
            >
              <i class="pi pi-play" aria-hidden="true" />
              <span>开始牌局</span>
            </Button>
            <p v-if="!room.isHost" class="hint">只有主持人可以开局。</p>
          </div>
        </section>

        <section class="panel" aria-labelledby="rules-title">
          <h2 id="rules-title" class="panel-title">本桌规则</h2>
          <dl class="rules">
            <div><dt>游戏</dt><dd>无限注德州扑克，52 张牌，无大小王</dd></div>
            <div><dt>人数</dt><dd>{{ TABLE_RULES.minSeats }}–{{ TABLE_RULES.maxSeats }} 人</dd></div>
            <div><dt>盲注</dt><dd class="num">{{ TABLE_RULES.smallBlind }}/{{ TABLE_RULES.bigBlind }}</dd></div>
            <div><dt>起始筹码</dt><dd class="num">{{ TABLE_RULES.startingStack }}</dd></div>
            <div><dt>行动时间</dt><dd>每人 {{ TABLE_RULES.turnSeconds }} 秒，超时自动过牌或弃牌</dd></div>
            <div><dt>断线</dt><dd>座位保留，回到页面自动重连并恢复牌局</dd></div>
            <div><dt>筹码性质</dt><dd>虚拟分数，不可充值、不可兑换、不可转让</dd></div>
          </dl>
        </section>
      </template>
    </div>
  </main>
</template>

<style scoped>
.waiting {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.page {
  flex: 1;
  width: min(100%, 900px);
  margin: 0 auto;
  padding: var(--space-3) var(--space-2) var(--space-5);
  display: grid;
  gap: var(--space-2);
  align-content: start;
}

.notice {
  margin: 0;
  padding: 6px var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  color: var(--muted);
  font-size: 0.84rem;
}

.seats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-1);
  margin: 0 0 var(--space-2);
  padding: 0;
  list-style: none;
}

.seat {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  min-height: 48px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--text);
  font: inherit;
  cursor: pointer;
  transition: border-color 0.16s ease-out, background-color 0.16s ease-out;
}

.seat:hover {
  border-color: var(--gold-soft);
}

.seat.is-taken {
  border-style: dashed;
  cursor: not-allowed;
  color: var(--muted);
}

.seat.is-mine {
  border-style: solid;
  border-color: var(--gold);
  background: color-mix(in srgb, var(--gold) 12%, var(--bg));
}

.seat-no {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--felt-deep);
  font-size: 0.76rem;
}

.seat-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  white-space: nowrap;
  margin-left: auto;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--gold-dim);
  color: var(--gold);
  font-size: 0.66rem;
}

.badge--ready {
  background: transparent;
  color: var(--muted);
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.field {
  display: grid;
  gap: 6px;
  margin-bottom: var(--space-2);
}

.label {
  font-size: 0.84rem;
  color: var(--muted);
}

.rules {
  display: grid;
  gap: 6px;
  margin: 0;
}

.rules div {
  display: flex;
  gap: var(--space-1);
  font-size: 0.86rem;
}

.rules dt {
  min-width: 84px;
  color: var(--muted);
}

.rules dd {
  margin: 0;
}
</style>
