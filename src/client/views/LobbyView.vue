<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import { NICKNAME_MAX, ROOM_NAME_MAX, TABLE_RULES } from '../../shared/poker.ts'
import { SessionError, connectRoom, createRoom as apiCreateRoom, joinRoom as apiJoinRoom } from '../net/session.ts'
import { useRoomStore } from '../stores/room.ts'

/**
 * 大厅：创建房间 / 通过邀请链接加入（规格书 §3.2 第 1 条）。
 *
 * 第 3 阶段已接入真实服务端：凭证由 HTTP 接口下发（含重连凭证），
 * 随后建立同端口 WebSocket 订阅；本地不做任何「假成功」。
 */
const router = useRouter()
const room = useRoomStore()

/** 服务器同时开放的桌数上限与当前占用（服务端全局最多 3 桌）。 */
const roomLimit = ref<{ open: number; max: number } | null>(null)

onMounted(async () => {
  try {
    const health = (await (await fetch('/api/health')).json()) as { rooms: number; maxRooms: number }
    roomLimit.value = { open: health.rooms, max: health.maxRooms }
  } catch {
    roomLimit.value = null
  }
})

const roomLimitText = computed(() => {
  if (!roomLimit.value) return ''
  return `当前开放 ${String(roomLimit.value.open)}/${String(roomLimit.value.max)} 桌`
})

const roomLimitReached = computed(() => Boolean(roomLimit.value && roomLimit.value.open >= roomLimit.value.max))

const nickname = ref(room.nickname)
const roomName = ref('')
const joinCode = ref('')
const maxSeats = ref(6)
const error = ref('')
const busy = ref(false)

const seatOptions = computed(() =>
  Array.from({ length: TABLE_RULES.maxSeats - TABLE_RULES.minSeats + 1 }, (_, index) => {
    const value = TABLE_RULES.minSeats + index
    return { label: `${String(value)} 人桌`, value }
  }),
)

function problem(): string | null {
  const name = nickname.value.trim()
  if (!name) return '请先填写昵称，其他玩家会看到这个名字。'
  if (name.length > NICKNAME_MAX) return `昵称最多 ${String(NICKNAME_MAX)} 个字符。`
  if (roomName.value.trim().length > ROOM_NAME_MAX) return `房间名最多 ${String(ROOM_NAME_MAX)} 个字符。`
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
  busy.value = true
  try {
    const credentials = await apiCreateRoom({
      nickname: nickname.value.trim(),
      roomName: roomName.value.trim() || undefined,
      maxSeats: maxSeats.value,
    })
    room.setCredentials(credentials)
    connectRoom(credentials)
    await router.push({ name: 'room', params: { roomId: credentials.roomId } })
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
  if (!code) {
    error.value = '请填写邀请链接里的房间号，或直接打开朋友发来的邀请链接。'
    return
  }
  busy.value = true
  try {
    const credentials = await apiJoinRoom(code, { nickname: nickname.value.trim() })
    room.setCredentials(credentials)
    connectRoom(credentials)
    await router.push({ name: 'room', params: { roomId: credentials.roomId } })
  } catch (cause) {
    error.value = describe(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main id="main" class="lobby">
    <div class="page">
      <header class="hero">
        <p class="mark">私人牌局 · 邀请制</p>
        <h1>开一桌德州</h1>
        <p class="lede">
          2–9 人、盲注 {{ TABLE_RULES.smallBlind }}/{{ TABLE_RULES.bigBlind }}、起始筹码
          {{ TABLE_RULES.startingStack }}。筹码是虚拟分数，不可充值、不可兑换、不可转让。
        </p>
      </header>

      <Message v-if="error" severity="error" :closable="false" class="alert" role="alert">
        {{ error }}
      </Message>

      <div class="grid">
        <section class="panel" aria-labelledby="create-title">
          <h2 id="create-title" class="panel-title">创建房间</h2>
          <p class="hint">你是主持人，人齐后由你开局。</p>

          <label class="field" for="nickname">
            <span class="label">你的昵称</span>
            <InputText
              id="nickname"
              v-model="nickname"
              :maxlength="NICKNAME_MAX"
              placeholder="例如：小满"
              autocomplete="nickname"
              fluid
            />
          </label>

          <label class="field" for="room-name">
            <span class="label">房间名（可选）</span>
            <InputText
              id="room-name"
              v-model="roomName"
              :maxlength="ROOM_NAME_MAX"
              placeholder="例如：周五夜局"
              fluid
            />
          </label>

          <label class="field" for="max-seats">
            <span class="label">座位数</span>
            <Select
              v-model="maxSeats"
              input-id="max-seats"
              :options="seatOptions"
              option-label="label"
              option-value="value"
              fluid
            />
          </label>

          <p v-if="roomLimitText" class="hint" role="status">
            {{ roomLimitText }}<template v-if="roomLimitReached">，已满：等其中一桌结束或关闭后再开新桌</template>
          </p>

          <Button
            :disabled="busy"
            :title="roomLimitReached ? '服务器桌数已达上限' : '创建房间并进入等待区'"
            @click="createRoom"
          >
            <i class="pi pi-plus" aria-hidden="true" />
            <span>创建并进入等待区</span>
          </Button>
        </section>

        <section class="panel" aria-labelledby="join-title">
          <h2 id="join-title" class="panel-title">加入房间</h2>
          <p class="hint">收到邀请链接就直接打开；也可以在这里输入房间号。</p>

          <label class="field" for="join-code">
            <span class="label">房间号</span>
            <InputText
              id="join-code"
              v-model="joinCode"
              maxlength="32"
              placeholder="例如：7K2QF9"
              autocapitalize="characters"
              spellcheck="false"
              fluid
            />
          </label>

          <Button :disabled="busy" :title="'加入这个房间'" @click="joinRoom">
            <i class="pi pi-sign-in" aria-hidden="true" />
            <span>加入房间</span>
          </Button>

          <ul class="rules">
            <li>每轮行动 {{ TABLE_RULES.turnSeconds }} 秒，超时按规则自动过牌或弃牌。</li>
            <li>断线后座位保留，回到页面会自动重连并恢复牌局。</li>
            <li>看不到其他玩家未公开的底牌。</li>
          </ul>
        </section>
      </div>

      <p class="foot hint">
        第 1 阶段说明：当前界面使用本地模拟数据演示，创建/加入不会真正连接服务器；第 3 阶段接入联机后此提示会移除。
      </p>
    </div>
  </main>
</template>

<style scoped>
.lobby {
  flex: 1;
  padding: var(--space-4) var(--space-2) var(--space-5);
}

.page {
  width: min(100%, 960px);
  margin: 0 auto;
  display: grid;
  gap: var(--space-3);
}

.mark {
  margin: 0 0 var(--space-1);
  font-size: 0.8rem;
  letter-spacing: 0.16em;
  color: var(--gold);
}

h1 {
  margin: 0 0 var(--space-1);
  font-size: clamp(1.9rem, 5vw, 2.6rem);
}

.lede {
  margin: 0;
  max-width: 62ch;
  color: var(--muted);
  line-height: 1.65;
}

.alert {
  margin: 0;
}

.grid {
  display: grid;
  gap: var(--space-2);
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}

.panel {
  display: grid;
  gap: var(--space-2);
  align-content: start;
}

.field {
  display: grid;
  gap: 6px;
}

.label {
  font-size: 0.84rem;
  color: var(--muted);
}

.rules {
  margin: 0;
  padding-left: 1.1em;
  display: grid;
  gap: 4px;
  font-size: 0.82rem;
  line-height: 1.6;
  color: var(--muted);
}

.foot {
  margin: 0;
}

@media (max-width: 520px) {
  .lobby {
    padding-top: var(--space-3);
  }
}
</style>
