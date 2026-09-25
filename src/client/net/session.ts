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
import { playPing, playYourTurn, soundEnabled } from '../sound.ts'
import { useChatStore } from '../stores/chat.ts'
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

/* ───────────────────────────── 致命错误（身份失效 / 房间不可用） ───────────────────────────── */

/**
 * 这三种错误说明「当前身份在这个房间里已经没有任何意义」：
 *   - unauthorized：被主持人移除，或凭证失效；
 *   - room_closed：房间已关闭；
 *   - room_not_found：房间已解散。
 * 继续留在这个房间只会不停重连（每次都被同样拒绝），所以交给界面跳到错误页。
 */
const FATAL_ROOM_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'unauthorized',
  'room_closed',
  'room_not_found',
])

type FatalRoomErrorHandler = (error: { code: ErrorCode; message: string }) => void

let fatalRoomErrorHandler: FatalRoomErrorHandler | null = null

/**
 * 注册致命错误处理（由牌桌页在挂载时注册、卸载时注销）。
 * 用回调而不是在这里直接跳路由：session.ts 不认识 vue-router，
 * 只负责「识别致命错误 + 停止重连」这一件事。
 */
export function onFatalRoomError(handler: FatalRoomErrorHandler | null): void {
  fatalRoomErrorHandler = handler
}

function handleFatalRoomError(error: { code: ErrorCode; message: string }): void {
  // closing 必须在这里就置上：服务端随后会关掉连接，若还按普通断线处理就会立刻开始重连。
  closing = true
  clearTimers()
  const current = socket
  socket = null
  activeCredentials = null
  current?.close(1000, 'room unavailable')
  useConnectionStore().setStatus('idle')
  useGameStore().clear()
  useChatStore().clear()
  fatalRoomErrorHandler?.(error)
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
  if (
    !closing &&
    activeCredentials?.roomId === credentials.roomId &&
    activeCredentials.playerId === credentials.playerId &&
    activeCredentials.reconnectToken === credentials.reconnectToken &&
    (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN || reconnectTimer !== null)
  ) return
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
  useChatStore().clear()
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

/** 发送一条聊天；文本长度由服务端 zod 再校验一次。 */
export function sendChat(text: string): boolean {
  return sendCommand({ type: 'chat.send', requestId: nextRequestId(), text: text.trim() } satisfies ClientCommand)
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

  // 聊天是轻量事件：只进聊天列表，不参与对局状态替换。
  if (message.type === 'chat.message') {
    const chat = useChatStore()
    chat.append(message.message)
    if (soundEnabled.value && message.message.kind === 'user') playPing()
    return
  }

  if (message.type === 'room.error') {
    const error = {
      code: message.error?.code ?? ('internal' as ErrorCode),
      message: message.error?.message ?? ERROR_MESSAGES.internal,
    }
    // 身份失效 / 房间不可用：先终止会话（不再重连），再让牌桌页跳到错误页。
    if (FATAL_ROOM_ERRORS.has(error.code)) {
      handleFatalRoomError(error)
      return
    }
    session.setError(error.code, error.message)
    // 过期版本已经由服务端回发最新快照，这里只提示、不阻断。
    if ('state' in message && message.state && 'self' in message && message.self) {
      useGameStore().applySnapshot(message.state, message.self)
    }
    return
  }

  // 成员名单是主持人按需查询的轻量结果，不携带牌局状态，也不参与状态替换。
  if (message.type === 'room.members') {
    if (message.members) useRoomStore().setMembers(message.members)
    return
  }

  const game = useGameStore()
  const chat = useChatStore()

  // 进入房间 / 重连：服务端下发最近聊天与手牌历史，整体替换本地列表。
  if (message.chatHistory) chat.setHistory(message.chatHistory)
  if (message.handHistory) game.setHistory(message.handHistory)

  const wasMyTurn = game.isMyTurn
  game.applySnapshot(message.state, message.self)
  if (message.type === 'hand.settled' && message.result) game.appendHistory(message.result)

  // 提示音：轮到自己行动、以及本手结算。
  if (soundEnabled.value) {
    if (!wasMyTurn && game.isMyTurn) playYourTurn()
    else if (message.type === 'hand.settled') playPing()
  }
  const updatedCredentials = {
    ...(useRoomStore().credentials ?? (activeCredentials as RoomCredentials)),
    roomId: message.state.roomId,
    roomName: message.state.roomName,
    isHost: message.self.isHost ?? (useRoomStore().credentials ?? activeCredentials)?.isHost ?? false,
  }
  if (updatedCredentials.isHost !== useRoomStore().credentials?.isHost) saveCredentials(updatedCredentials)
  useRoomStore().setCredentials(updatedCredentials)
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
