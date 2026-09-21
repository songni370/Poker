import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  ClientCommand,
  CreateRoomRequest,
  ErrorCode,
  ErrorResponse,
  JoinRoomRequest,
  RoomCredentials,
  RoomInfoResponse,
  ServerMessage,
} from '../../shared/protocol.ts'
import { ERROR_MESSAGES } from '../../shared/protocol.ts'
import { useConnectionStore } from '../stores/connection.ts'
import { useGameStore } from '../stores/game.ts'
import { useRoomStore } from '../stores/room.ts'

const STORAGE_PREFIX = 'poker.credentials.'
const HEARTBEAT_MS = 15000
const MAX_BACKOFF_MS = 10000

export class SessionError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code] ?? '请求失败')
    this.name = 'SessionError'
    this.code = code
  }
}

/** 请求 ID：HTTP 明文部署下 crypto.randomUUID 可能不可用，需要退路。 */
export function nextRequestId(): string {
  const webCrypto = globalThis.crypto
  if (webCrypto && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID()
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/* ───────────────────────────── 凭证本地保存（刷新后可回桌） ───────────────────────────── */

export function saveCredentials(credentials: RoomCredentials): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + credentials.roomId, JSON.stringify(credentials))
  } catch {
    // 隐私模式下 localStorage 不可用：仅影响刷新恢复，不影响本局。
  }
}

export function loadCredentials(roomId: string): RoomCredentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + roomId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as RoomCredentials
    return parsed.roomId === roomId && parsed.playerId && parsed.reconnectToken ? parsed : null
  } catch {
    return null
  }
}

export function forgetCredentials(roomId: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + roomId)
  } catch {
    // 忽略
  }
}

/* ───────────────────────────── HTTP ───────────────────────────── */

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as T | ErrorResponse | null
  if (!response.ok) {
    const failure = payload as ErrorResponse | null
    throw new SessionError(failure?.error ?? 'internal', failure?.message)
  }
  return payload as T
}

export async function createRoom(body: CreateRoomRequest): Promise<RoomCredentials> {
  const credentials = await readJson<RoomCredentials>(
    await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  saveCredentials(credentials)
  return credentials
}

export async function joinRoom(roomId: string, body: JoinRoomRequest): Promise<RoomCredentials> {
  const credentials = await readJson<RoomCredentials>(
    await fetch(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  saveCredentials(credentials)
  return credentials
}

export async function fetchRoomInfo(roomId: string): Promise<RoomInfoResponse> {
  return readJson<RoomInfoResponse>(await fetch(`/api/rooms/${encodeURIComponent(roomId)}`))
}

/* ───────────────────────────── 会话状态（提示 / 错误） ───────────────────────────── */

export const useSessionStore = defineStore('session', () => {
  /** 最近一条系统提示（入座、超时、结算等）。 */
  const notice = ref('')
  /** 最近一次服务端错误，供界面提示；成功动作后清空。 */
  const lastError = ref<{ code: ErrorCode; message: string } | null>(null)
  /** 最近一次收到的服务端事件类型，便于调试与动效触发。 */
  const lastEventType = ref<string>('')

  function setNotice(value: string): void {
    notice.value = value
  }

  function setError(code: ErrorCode, message: string): void {
    lastError.value = { code, message }
  }

  function clearError(): void {
    lastError.value = null
  }

  return { notice, lastError, lastEventType, setNotice, setError, clearError }
})

/* ───────────────────────────── WebSocket 单例 ───────────────────────────── */

let socket: WebSocket | null = null
let activeCredentials: RoomCredentials | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let heartbeatSentAt = 0
let closing = false

/** 建立（或重连）到房间的 WebSocket；同一页面只维护一条连接。 */
export function connectRoom(credentials: RoomCredentials): void {
  activeCredentials = credentials
  reconnectAttempts = 0
  closing = false
  useRoomStore().setCredentials(credentials)
  openSocket()
}

export function disconnectRoom(): void {
  closing = true
  clearTimers()
  const current = socket
  socket = null
  current?.close(1000, 'client left')
  useConnectionStore().setStatus('idle')
  useGameStore().clear()
  activeCredentials = null
}

export function isConnected(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN
}

/** 发送客户端命令；未连接时返回 false，由调用方提示「连接中」。 */
export function sendCommand(command: ClientCommand): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(command))
  return true
}

export function sendAction(action: ClientCommand): boolean {
  return sendCommand(action)
}

function clearTimers(): void {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
  if (reconnectTimer !== null) clearTimeout(reconnectTimer)
  heartbeatTimer = null
  reconnectTimer = null
}

function openSocket(): void {
  const credentials = activeCredentials
  if (!credentials) return
  const connection = useConnectionStore()
  const session = useSessionStore()

  const previous = socket
  socket = null
  previous?.close()

  connection.setStatus(reconnectAttempts === 0 ? 'connecting' : 'reconnecting')

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${scheme}://${location.host}/ws`)
  socket = ws

  ws.addEventListener('open', () => {
    if (socket !== ws) return
    ws.send(
      JSON.stringify({
        type: 'room.join',
        requestId: nextRequestId(),
        roomId: credentials.roomId,
        playerId: credentials.playerId,
        reconnectToken: credentials.reconnectToken,
      } satisfies ClientCommand),
    )
    startHeartbeat()
  })

  ws.addEventListener('message', (event: MessageEvent) => {
    if (socket !== ws) return
    handleMessage(String(event.data))
  })

  ws.addEventListener('close', () => {
    if (socket !== ws) return
    socket = null
    stopHeartbeat()
    if (closing) return
    session.setNotice('连接已断开，正在重连…')
    scheduleReconnect()
  })

  ws.addEventListener('error', () => {
    // 具体原因由随后的 close 事件处理，这里只更新状态。
    if (socket === ws) connection.setStatus('reconnecting')
  })
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return
  const connection = useConnectionStore()
  connection.setStatus('reconnecting')
  const delay = Math.min(600 * 2 ** reconnectAttempts, MAX_BACKOFF_MS)
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    openSocket()
  }, delay)
}

function startHeartbeat(): void {
  stopHeartbeat()
  const beat = (): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    heartbeatSentAt = Date.now()
    socket.send(JSON.stringify({ type: 'heartbeat', requestId: nextRequestId(), clientTime: heartbeatSentAt } satisfies ClientCommand))
  }
  beat()
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS)
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

function handleMessage(text: string): void {
  let message: ServerMessage
  try {
    message = JSON.parse(text) as ServerMessage
  } catch {
    return
  }

  const connection = useConnectionStore()
  const session = useSessionStore()
  session.lastEventType = message.type

  if (message.type === 'pong') {
    const receivedAt = Date.now()
    connection.syncClock(message.serverTime, heartbeatSentAt, receivedAt - heartbeatSentAt)
    connection.setStatus('online')
    return
  }

  if (message.type === 'room.error') {
    session.setError(message.error?.code ?? 'internal', message.error?.message ?? ERROR_MESSAGES.internal)
    // 过期版本已经由服务端回发最新快照，这里只提示、不阻断。
    if ('state' in message && message.state && 'self' in message && message.self) {
      useGameStore().applySnapshot(message.state, message.self)
    }
    return
  }

  useGameStore().applySnapshot(message.state, message.self)
  useRoomStore().setCredentials({
    ...(useRoomStore().credentials ?? (activeCredentials as RoomCredentials)),
    roomId: message.state.roomId,
    roomName: message.state.roomName,
  })
  session.clearError()
  if (message.notice) session.setNotice(message.notice)
  connection.syncClock(message.serverTime, Date.now(), 0)
  connection.setStatus('online')
}

/** 浏览器恢复网络或页面重新可见时立刻重试，不必等退避结束。 */
if (typeof window !== 'undefined') {
  const retryNow = (): void => {
    if (closing || !activeCredentials || socket) return
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    openSocket()
  }
  window.addEventListener('online', retryNow)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retryNow()
  })
}
