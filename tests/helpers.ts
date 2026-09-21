// 测试公用工具：真实 HTTP + WebSocket 客户端与服务器启动器。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/server/app.ts'
import { openDatabase, type DbHandle } from '../src/server/db/index.ts'
import type { RoomManager } from '../src/server/rooms.ts'
import type { ClientCommand, GameStatePublic, PrivateSelfState, RoomCredentials, ServerMessage } from '../src/shared/protocol.ts'

let sequence = 0
export const rid = (): string => `t-${++sequence}`
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class TestClient {
  readonly messages: ServerMessage[] = []
  private readonly socket: WebSocket

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.socket.addEventListener('message', (event: MessageEvent) => {
      this.messages.push(JSON.parse(String(event.data)) as ServerMessage)
    })
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState === WebSocket.OPEN) return resolve()
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
    })
  }

  send(command: ClientCommand): void {
    this.socket.send(JSON.stringify(command))
  }

  close(): void {
    this.socket.close()
  }

  async waitFor(predicate: (message: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate)
      if (found) return found
      await delay(20)
    }
    throw new Error('等待服务端消息超时')
  }

  lastState(): GameStatePublic | undefined {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index]!
      if (message.type !== 'room.error' && 'state' in message) return message.state
    }
    return undefined
  }

  lastSelf(): PrivateSelfState | undefined {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index]!
      if (message.type !== 'room.error' && 'self' in message) return message.self
    }
    return undefined
  }
}

export interface TestServer {
  base: string
  wsUrl: string
  handle: DbHandle
  rooms: RoomManager
  stop: () => Promise<void>
}

export async function startTestServer(options: { dbPath?: string; maxRooms?: number } = {}): Promise<TestServer> {
  const dir = options.dbPath ? null : mkdtempSync(join(tmpdir(), 'poker-test-'))
  const dbPath = options.dbPath ?? join(dir!, 'poker.sqlite')
  const handle = openDatabase(dbPath)
  const { app, rooms } = await buildApp(handle, {
    clientDir: join(tmpdir(), 'no-client-dir'),
    ...(options.maxRooms === undefined ? {} : { maxRooms: options.maxRooms }),
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    handle,
    rooms,
    stop: async () => {
      rooms.closeAll()
      await app.close()
      handle.close()
      if (dir) rmSync(dir, { recursive: true, force: true })
    },
  }
}

export async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, data: (await response.json()) as T }
}

export function joinCommand(credentials: RoomCredentials): ClientCommand {
  return {
    type: 'room.join',
    requestId: rid(),
    roomId: credentials.roomId,
    playerId: credentials.playerId,
    reconnectToken: credentials.reconnectToken,
  }
}
