<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { NICKNAME_MAX, ROOM_ID_DIGITS, ROOM_NAME_MAX, TABLE_RULES } from '../../shared/poker.ts'
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
/** 房间号输入框（PrimeVue InputText）：校验失败时把焦点放回去。 */
const codeField = ref<{ $el?: HTMLInputElement } | null>(null)
/**
 * 初始筹码 = 玩家上桌最低要买入多少（默认 2000）；买入上限 = 一次最多带多少上桌（默认 5000）。
 * 座位数不再让房主选：本产品固定 9 人桌（服务端也只认 9）。
 */
const minBuyIn = ref(TABLE_RULES.startingStack)
const buyInMax = ref(TABLE_RULES.maxBuyInDefault)
const error = ref('')
const busy = ref(false)

function problem(): string | null {
  const name = nickname.value.trim()
  if (!name) return '请先填写昵称，其他玩家会看到这个名字。'
  if (name.length > NICKNAME_MAX) return `昵称最多 ${String(NICKNAME_MAX)} 个字符。`
  if (roomName.value.trim().length > ROOM_NAME_MAX) return `房间名最多 ${String(ROOM_NAME_MAX)} 个字符。`
  const min = Number(minBuyIn.value)
  const max = Number(buyInMax.value)
  const range = `${String(TABLE_RULES.minBuyInFloor)}–${String(TABLE_RULES.maxBuyInLimit)}`
  if (!Number.isFinite(min) || min < TABLE_RULES.minBuyInFloor || min > TABLE_RULES.maxBuyInLimit) {
    return `初始筹码需在 ${range} 之间。`
  }
  if (!Number.isFinite(max) || max < TABLE_RULES.minBuyInFloor || max > TABLE_RULES.maxBuyInLimit) {
    return `买入上限需在 ${range} 之间。`
  }
  if (max < min) return '买入上限不能低于初始筹码。'
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
      minBuyIn: Number(minBuyIn.value),
      buyInMax: Number(buyInMax.value),
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
  // 房间号是纯数字：位数不对或夹了字母就直接说清楚，不用白跑一趟服务端。
  if (code.length !== ROOM_ID_DIGITS || !/^\d+$/.test(code)) {
    error.value = `房间号是 ${String(ROOM_ID_DIGITS)} 位数字（例如 482913），也可以直接打开朋友发来的邀请链接。`
    // 报错后把焦点放回输入框：不用再点一次，直接重打（界面规范：错误要落在出错的字段上）。
    codeField.value?.$el?.focus()
    return
  }
  busy.value = true
  try {
    const credentials = await apiJoinRoom(code, { nickname: nickname.value.trim() })
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
    <div class="page">
      <header class="hero">
        <p class="mark">私人牌局 · 邀请制</p>
        <h1>开一桌德州</h1>
        <p class="lede">
          {{ TABLE_RULES.maxSeats }} 人桌、盲注 {{ TABLE_RULES.smallBlind }}/{{ TABLE_RULES.bigBlind }}，
          初始筹码与买入上限由主持人设定（默认 {{ TABLE_RULES.startingStack }} /
          {{ TABLE_RULES.maxBuyInDefault }}）。筹码是虚拟分数，不可充值、不可兑换、不可转让。
        </p>
      </header>

      <Message v-if="error" severity="error" :closable="false" class="alert" role="alert">
        {{ error }}
      </Message>

      <div class="grid">
        <section class="panel" aria-labelledby="create-title">
          <h2 id="create-title" class="panel-title">创建房间</h2>
          <p class="hint">你是主持人：进桌后先选座位买入，人齐后由你开局。</p>

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

          <label class="field" for="min-buy-in">
            <span class="label">初始筹码</span>
            <InputNumber
              input-id="min-buy-in"
              v-model="minBuyIn"
              :min="TABLE_RULES.minBuyInFloor"
              :max="TABLE_RULES.maxBuyInLimit"
              :step="TABLE_RULES.smallBlind"
              :use-grouping="false"
              fluid
            />
          </label>

          <label class="field" for="buy-in-max">
            <span class="label">买入上限</span>
            <InputNumber
              input-id="buy-in-max"
              v-model="buyInMax"
              :min="TABLE_RULES.minBuyInFloor"
              :max="TABLE_RULES.maxBuyInLimit"
              :step="TABLE_RULES.smallBlind"
              :use-grouping="false"
              fluid
            />
          </label>
          <p class="hint">
            玩家落座时在 {{ minBuyIn || TABLE_RULES.startingStack }}–{{ buyInMax || TABLE_RULES.maxBuyInDefault }}
            之间选买入额（步进 {{ TABLE_RULES.smallBlind }} 筹码）。
          </p>

          <p v-if="roomLimitText" class="hint" role="status">
            {{ roomLimitText }}<template v-if="roomLimitReached">，已满：等其中一桌结束或关闭后再开新桌</template>
          </p>

          <Button
            :disabled="busy"
            :title="roomLimitReached ? '服务器桌数已达上限' : '创建房间并进入等待区'"
            @click="createRoom"
          >
            <i class="pi pi-plus" aria-hidden="true" />
            <span>创建牌桌</span>
          </Button>
        </section>

        <section class="panel" aria-labelledby="join-title">
          <h2 id="join-title" class="panel-title">加入房间</h2>
          <p class="hint">收到邀请链接就直接打开；也可以在这里输入 {{ ROOM_ID_DIGITS }} 位房间号。</p>

          <label class="field" for="join-code">
            <span class="label">房间号</span>
            <InputText
              id="join-code"
              ref="codeField"
              v-model="joinCode"
              :maxlength="ROOM_ID_DIGITS"
              placeholder="例如：482913"
              inputmode="numeric"
              autocomplete="off"
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
