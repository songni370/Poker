<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import { ERROR_MESSAGES } from '../../shared/protocol.ts'
import type { ErrorCode } from '../../shared/protocol.ts'
import { useRoomStore } from '../stores/room.ts'

/**
 * 错误页（路由 /error 与未匹配路由兜底）。
 * 覆盖规格书 §3.2 第 5 条：链接过期、房间已满、被移出、版本不兼容。
 * 第 3 阶段接入点：HTTP / WebSocket 返回 ErrorResponse 时把 error 当作 code 传进来。
 */
const route = useRoute()
const router = useRouter()
const room = useRoomStore()

type ErrorKind = 'expired' | 'full' | 'kicked' | 'version' | 'closed' | 'unknown'

interface ErrorCopy {
  title: string
  what: string
  how: string
}

const COPY: Record<ErrorKind, ErrorCopy> = {
  expired: {
    title: '这个链接已经失效',
    what: '房间可能已经解散，或者链接在复制时被截断了。',
    how: '请向发链接的朋友确认最新地址，或在大厅用房间号重新加入。',
  },
  full: {
    title: '房间已经满员',
    what: '所有座位都被占用了，暂时进不去。',
    how: '等有人离座后再试一次，或请朋友开一张新桌。',
  },
  kicked: {
    title: '你已被移出房间',
    what: '主持人把你请出了这张牌桌，当前身份无法再进入。',
    how: '如果这是误会，请联系主持人重新发一条邀请链接给你。',
  },
  version: {
    title: '版本不兼容',
    what: '当前页面使用的协议版本与服务器不一致。',
    how: '刷新页面获取最新版本；如果仍然不行，请确认服务器已经更新。',
  },
  closed: {
    title: '房间已关闭',
    what: '主持人结束了这张牌桌，牌局记录已停止写入。',
    how: '回到大厅可以创建新房间，或加入其它牌局。',
  },
  unknown: {
    title: '无法打开这个页面',
    what: '地址可能拼写有误，或这个页面已经不存在。',
    how: '回到大厅重新创建或加入房间。',
  },
}

const CODE_KIND: Partial<Record<ErrorCode, ErrorKind>> = {
  room_not_found: 'expired',
  room_full: 'full',
  room_closed: 'closed',
  unauthorized: 'kicked',
  stale_version: 'version',
  bad_request: 'unknown',
}

const kind = computed<ErrorKind>(() => {
  const code = typeof route.query.code === 'string' ? (route.query.code as ErrorCode) : undefined
  if (code && CODE_KIND[code]) return CODE_KIND[code]
  const named = typeof route.query.kind === 'string' ? route.query.kind : ''
  if (named === 'expired' || named === 'full' || named === 'kicked' || named === 'version' || named === 'closed') {
    return named
  }
  return 'unknown'
})

const copy = computed<ErrorCopy>(() => COPY[kind.value])

/** 服务端给出的具体说明优先；文案始终来自同一份错误码字典。 */
const detail = computed(() => {
  if (typeof route.query.detail === 'string' && route.query.detail) return route.query.detail
  const code = typeof route.query.code === 'string' ? (route.query.code as ErrorCode) : undefined
  return code && ERROR_MESSAGES[code] ? ERROR_MESSAGES[code] : ''
})

/**
 * 仍持有该房间凭证时，允许原地重试一次。
 * 「被移出」不在其中：那时凭证已经被服务端作废并就地清掉，
 * 用旧身份再进去只会被再拒一次，不如直接请主持人重发邀请链接。
 */
const retryTarget = computed(() => {
  const id = room.roomId ?? (typeof route.query.roomId === 'string' ? route.query.roomId : null)
  if (!id) return null
  return kind.value === 'full' ? { name: 'table', params: { roomId: id } } : null
})

async function goLobby(): Promise<void> {
  await router.push({ name: 'lobby' })
}

async function retry(): Promise<void> {
  if (retryTarget.value) await router.push(retryTarget.value)
}
</script>

<template>
  <main id="main" class="error-view">
    <div class="panel">
      <p class="code">
        <i class="pi pi-exclamation-circle" aria-hidden="true" />
        <span>{{ detail || '请求未能完成' }}</span>
      </p>
      <h1>{{ copy.title }}</h1>
      <p class="what">{{ copy.what }}</p>
      <p class="how">{{ copy.how }}</p>

      <div class="actions">
        <Button :title="'回到大厅'" @click="goLobby">
          <i class="pi pi-home" aria-hidden="true" />
          <span>回到大厅</span>
        </Button>
        <Button v-if="retryTarget" outlined :title="'用当前身份重新进入房间'" @click="retry">
          <i class="pi pi-refresh" aria-hidden="true" />
          <span>再试一次</span>
        </Button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.error-view {
  flex: 1;
  display: grid;
  place-items: center;
  padding: var(--space-4) var(--space-2);
}

.panel {
  width: min(100%, 560px);
  display: grid;
  gap: var(--space-2);
}

.code {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--danger);
  font-size: 0.84rem;
}

h1 {
  margin: 0;
  font-size: clamp(1.5rem, 4vw, 2rem);
}

.what,
.how {
  margin: 0;
  line-height: 1.7;
}

.what {
  color: var(--text);
}

.how {
  color: var(--muted);
}

.actions {
  display: flex;
  gap: var(--space-1);
  flex-wrap: wrap;
  margin-top: var(--space-1);
}
</style>
