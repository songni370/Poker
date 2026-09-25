import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/server/app.ts'
import { openDatabase, type DbHandle } from '../src/server/db/index.ts'
import type { RoomManager } from '../src/server/rooms.ts'
import type {
  ClientCommand,
  GameStatePublic,
  PrivateSelfState,
  RoomCredentials,
  ServerMessage,
} from '../src/shared/protocol.ts'

let seq = 0
const rid = (): string => `rec-${++seq}`
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class TestClient {
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

  async waitFor(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 5000,
    fromIndex = 0,
  ): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.messages.slice(fromIndex).find(predicate)
      if (found) return found
      await delay(20)
    }
    throw new Error('等待服务端消息超时')
  }

  lastState(): GameStatePublic | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!
      if (message.type !== 'room.error' && 'state' in message) return message.state
    }
    return undefined
  }

  lastSelf(): PrivateSelfState | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!
      if (message.type !== 'room.error' && 'self' in message) return message.self
    }
    return undefined
  }
}

interface ServerHandle {
  base: string
  wsUrl: string
  handle: DbHandle
  rooms: RoomManager
  stop: () => Promise<void>
}

async function startServer(dbPath: string): Promise<ServerHandle> {
  const handle = openDatabase(dbPath)
  const { app, rooms } = await buildApp(handle, { clientDir: join(tmpdir(), 'no-client-dir') })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    handle,
    rooms,
    // 模拟进程退出：断开连接、关闭 HTTP（但保留 SQLite 文件）。
    stop: async () => {
      rooms.closeAll()
      await app.close()
      handle.close()
    },
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const path = new URL(url).pathname
  const requestBody =
    (path === '/api/rooms' || /^\/api\/rooms\/[^/]+\/join$/.test(path)) &&
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body)
      ? { password: '123456', ...body }
      : body
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  return (await response.json()) as T
}

/** 落座（新流程）：加入后先是旁观者，必须显式 seat.take 才能进牌局。 */
async function takeSeat(client: TestClient, seat: number): Promise<void> {
  const from = client.messages.length
  client.send({ type: 'seat.take', requestId: rid(), seat })
  await client.waitFor(
    (m) =>
      m.type !== 'room.error' &&
      'self' in m &&
      m.self.seat === seat &&
      'state' in m &&
      m.state.seats[seat]?.away === false,
    5000,
    from,
  )
}

function joinCommand(credentials: RoomCredentials): ClientCommand {
  return {
    type: 'room.join',
    requestId: rid(),
    roomId: credentials.roomId,
    playerId: credentials.playerId,
    reconnectToken: credentials.reconnectToken,
  }
}

/** 只过牌/跟注，保证走到摊牌。 */
async function playOneStep(clients: Map<string, TestClient>, state: GameStatePublic): Promise<boolean> {
  const actingId = state.actingPlayerId
  if (!actingId) return false
  const client = clients.get(actingId)
  if (!client) return false
  const own = client.lastState()
  const self = client.lastSelf()
  if (!own || !self || own.actingPlayerId !== actingId || self.legalActions.length === 0) return false
  const pick =
    self.legalActions.find((action) => action.action === 'check') ??
    self.legalActions.find((action) => action.action === 'call')
  if (!pick) return false
  client.send({
    type: 'game.action',
    requestId: rid(),
    handId: own.handId!,
    expectedVersion: own.version,
    action: pick.action,
    amount: pick.amount,
  })
  await delay(60)
  return true
}

test('单进程重启：从 SQLite 快照恢复一致牌局，继续打完且不重复结算', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'poker-recovery-'))
  const dbPath = join(dir, 'poker.sqlite')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  /* ── 第一次启动：建房、开局、打两步 ── */
  const first = await startServer(dbPath)
  const host = await postJson<RoomCredentials>(`${first.base}/api/rooms`, { nickname: '甲', maxSeats: 2 })
  const guest = await postJson<RoomCredentials>(`${first.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })

  const clientA = new TestClient(first.wsUrl)
  const clientB = new TestClient(first.wsUrl)
  await Promise.all([clientA.open(), clientB.open()])
  clientA.send(joinCommand(host))
  await clientA.waitFor((m) => m.type === 'room.snapshot')
  clientB.send(joinCommand(guest))
  await clientB.waitFor((m) => m.type === 'room.snapshot')
  await takeSeat(clientA, 0)
  await takeSeat(clientB, 1)
  const totalChips = clientA.lastState()!.seats.reduce((sum, seat) => sum + (seat ? seat.stack : 0), 0)

  clientA.send({ type: 'game.start', requestId: rid() })
  await clientA.waitFor((m) => m.type === 'hand.started')
  await clientB.waitFor((m) => m.type === 'hand.started')

  const clients = new Map([
    [host.playerId, clientA],
    [guest.playerId, clientB],
  ])

  // 打两步（翻牌前双方各行动一次）
  let steps = 0
  const stepDeadline = Date.now() + 5000
  while (steps < 2 && Date.now() < stepDeadline) {
    const state = clientA.lastState()
    if (!state || state.phase === 'settlement') break
    if (await playOneStep(clients, state)) steps += 1
    else await delay(20)
  }
  assert.equal(steps, 2, '重启前应完成 2 次行动')

  const before = clientA.lastState()!
  const holeBefore = clientA.lastSelf()!.holeCards
  const guestHoleBefore = clientB.lastSelf()!.holeCards
  const handId = before.handId!
  assert.equal(holeBefore.length, 2)
  assert.notEqual(before.phase, 'waiting')

  // 退出前先确认快照已经落库（stop() 会关闭数据库句柄）
  const snapshotRow = first.handle.db.prepare('SELECT COUNT(*) AS c FROM room_snapshots').get() as unknown as {
    c: number
  }
  assert.equal(Number(snapshotRow.c), 1, '退出前应已写入房间快照')

  // 进程退出（客户端同时掉线）
  clientA.close()
  clientB.close()
  await first.stop()

  /* ── 第二次启动：同一个 SQLite 文件 ── */
  const second = await startServer(dbPath)
  t.after(second.stop)

  const roomInfo = await fetch(`${second.base}/api/rooms/${before.roomId}`)
  assert.equal(roomInfo.status, 200, '房间不应被判为已关闭')

  const reconnectA = new TestClient(second.wsUrl)
  const reconnectB = new TestClient(second.wsUrl)
  t.after(() => {
    reconnectA.close()
    reconnectB.close()
  })
  await Promise.all([reconnectA.open(), reconnectB.open()])
  reconnectA.send(joinCommand(host))
  const recoveredA = await reconnectA.waitFor((m) => m.type === 'connection.recovered')
  reconnectB.send(joinCommand(guest))
  await reconnectB.waitFor((m) => m.type === 'connection.recovered')

  assert.ok(recoveredA.type === 'connection.recovered')
  const after = recoveredA.state

  // 一致性：同一手牌、同一牌面、同一底池与筹码、同一行动者、同一版本
  assert.equal(after.handId, handId, '重启后应仍在同一手牌')
  assert.equal(after.handNo, before.handNo)
  assert.deepEqual(after.board, before.board, '公共牌应一致')
  assert.equal(after.potTotal, before.potTotal, '底池应一致')
  assert.equal(after.actingPlayerId, before.actingPlayerId, '行动者应一致')
  assert.equal(after.version, before.version, '版本号应一致')
  assert.deepEqual(
    after.seats.map((seat) => (seat ? `${seat.playerId}:${String(seat.stack)}:${String(seat.committedStreet)}` : '-')),
    before.seats.map((seat) => (seat ? `${seat.playerId}:${String(seat.stack)}:${String(seat.committedStreet)}` : '-')),
    '每个座位的筹码与投入应一致',
  )

  // 底牌：本人拿回自己的牌，且两人不同
  assert.deepEqual(
    [...recoveredA.self.holeCards].sort(),
    [...holeBefore].sort(),
    '本人底牌应原样恢复',
  )
  const recoveredB = reconnectB.lastSelf()!
  assert.deepEqual([...recoveredB.holeCards].sort(), [...guestHoleBefore].sort(), '对手底牌同样恢复')
  assert.equal(new Set([...recoveredA.self.holeCards, ...recoveredB.holeCards]).size, 4)

  /* ── 恢复后继续打完这一手 ── */
  const clients2 = new Map([
    [host.playerId, reconnectA],
    [guest.playerId, reconnectB],
  ])
  const endDeadline = Date.now() + 12000
  while (Date.now() < endDeadline && reconnectA.lastState()?.phase !== 'settlement') {
    const state = reconnectA.lastState()
    if (!state) break
    if (!(await playOneStep(clients2, state))) await delay(20)
  }
  const settled = reconnectA.lastState()!
  assert.equal(settled.phase, 'settlement', '恢复后应能打完这一手')
  assert.equal(settled.seats.reduce((sum, seat) => sum + (seat ? seat.stack + seat.committedHand : 0), 0), totalChips)

  // 重复结算为 0：同一 handId 只允许一条结算记录
  const rows = second.handle.db
    .prepare('SELECT COUNT(*) AS c FROM hand_results WHERE hand_id = ?')
    .get(handId) as unknown as { c: number }
  assert.equal(Number(rows.c), 1, '同一手牌不得重复结算')

  // 再重启一次：结算后的状态同样可恢复，且不会二次结算
  const third = await startServer(dbPath)
  t.after(third.stop)
  const settledRoom = await fetch(`${third.base}/api/rooms/${before.roomId}`)
  assert.equal(settledRoom.status, 200, '摊牌快照恢复后房间仍应存在')
  const rows2 = third.handle.db
    .prepare('SELECT COUNT(*) AS c FROM hand_results WHERE hand_id = ?')
    .get(handId) as unknown as { c: number }
  assert.equal(Number(rows2.c), 1, '二次重启后仍只有一条结算记录')
})

test('重启恢复：从未开过手的等待房间也必须存活（无牌堆的快照不算损坏）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'poker-waiting-'))
  const dbPath = join(dir, 'poker.sqlite')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const first = await startServer(dbPath)
  const host = await postJson<RoomCredentials>(`${first.base}/api/rooms`, {
    nickname: '房主',
    roomName: '等待中的房',
    maxSeats: 3,
  })
  const early = await postJson<RoomCredentials>(`${first.base}/api/rooms/${host.roomId}/join`, { nickname: '先到的' })
  // 先让两人落座（等待区页面已删除，座位来自牌桌上的 seat.take），再重启验证快照恢复
  const seatA = new TestClient(first.wsUrl)
  const seatB = new TestClient(first.wsUrl)
  await Promise.all([seatA.open(), seatB.open()])
  seatA.send(joinCommand(host))
  await seatA.waitFor((m) => m.type === 'room.snapshot')
  seatB.send(joinCommand(early))
  await seatB.waitFor((m) => m.type === 'room.snapshot')
  await takeSeat(seatA, 0)
  await takeSeat(seatB, 1)
  seatA.close()
  seatB.close()
  await first.stop()

  const second = await startServer(dbPath)
  t.after(second.stop)

  assert.equal(second.rooms.roomCount(), 1, '等待中的房间应被恢复进内存，而不是被当成损坏快照关闭')
  const response = await fetch(`${second.base}/api/rooms/${host.roomId}`)
  assert.equal(response.status, 200, '恢复后邀请链接仍可访问')
  const info = (await response.json()) as { roomName: string; seated: number; maxSeats: number }
  assert.equal(info.roomName, '等待中的房')
  assert.equal(info.seated, 2, '两名玩家都应还在座位上')
  // 产品上固定 9 人桌：接口给的 maxSeats 一律是 9（请求里的 3 只作兼容保留）。
  assert.equal(info.maxSeats, 9)

  // 恢复后仍能正常开局
  const reconnect = new TestClient(second.wsUrl)
  t.after(() => reconnect.close())
  await reconnect.open()
  reconnect.send(joinCommand(host))
  await reconnect.waitFor((m) => m.type === 'connection.recovered')
  reconnect.send({ type: 'game.start', requestId: rid() })
  const started = await reconnect.waitFor((m) => m.type === 'hand.started')
  assert.ok(started.type === 'hand.started')
  assert.equal(started.state.seats.filter(Boolean).length, 2)
})

test('重启后按持久化的截止时间判定超时：已过期则立即执行一次自动动作', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'poker-timeout-'))
  const dbPath = join(dir, 'poker.sqlite')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const first = await startServer(dbPath)
  const host = await postJson<RoomCredentials>(`${first.base}/api/rooms`, { nickname: '甲', maxSeats: 2 })
  const guest = await postJson<RoomCredentials>(`${first.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })

  const clientA = new TestClient(first.wsUrl)
  await clientA.open()
  clientA.send(joinCommand(host))
  await clientA.waitFor((m) => m.type === 'room.snapshot')
  await takeSeat(clientA, 0)
  const guestClient = new TestClient(first.wsUrl)
  t.after(() => guestClient.close())
  await guestClient.open()
  guestClient.send(joinCommand(guest))
  await guestClient.waitFor((m) => m.type === 'room.snapshot')
  await takeSeat(guestClient, 1)
  clientA.send({ type: 'game.start', requestId: rid() })
  await clientA.waitFor((m) => m.type === 'hand.started')

  const started = clientA.lastState()!
  clientA.close()
  await first.stop()

  // 直接把快照里的截止时间改成「已经过期 5 秒」，模拟进程在离线期间错过了行动时限
  const editing = openDatabase(dbPath)
  const row = editing.db.prepare('SELECT state_json FROM room_snapshots').get() as unknown as {
    state_json: string
  }
  const snapshot = JSON.parse(row.state_json) as { turnDeadlineAt: number | null }
  assert.ok(snapshot.turnDeadlineAt, '快照必须持久化了行动截止时间')
  snapshot.turnDeadlineAt = Date.now() - 5000
  editing.db.prepare('UPDATE room_snapshots SET state_json = ?').run(JSON.stringify(snapshot))
  editing.close()

  const second = await startServer(dbPath)
  t.after(second.stop)

  const reconnect = new TestClient(second.wsUrl)
  t.after(() => reconnect.close())
  await reconnect.open()
  reconnect.send(joinCommand(host))
  await reconnect.waitFor((m) => m.type === 'connection.recovered')

  // 等服务端执行超时动作（延迟为 0，应当很快）
  const deadline = Date.now() + 3000
  let after = reconnect.lastState()!
  while (Date.now() < deadline && after.actingPlayerId === started.actingPlayerId) {
    await delay(30)
    after = reconnect.lastState()!
  }

  assert.notEqual(after.actingPlayerId, started.actingPlayerId, '过期截止时间应触发一次自动过牌/弃牌并轮到下一人')
  assert.equal(after.handId, started.handId, '仍处于同一手牌')
  const actor = started.seats.find((seat) => seat?.playerId === started.actingPlayerId)!
  const afterActor = after.seats.find((seat) => seat?.playerId === actor.playerId)!
  assert.ok(
    afterActor.folded || afterActor.committedStreet >= after.currentBet || after.potTotal >= started.potTotal,
    '超时动作必须是自动过牌或自动弃牌',
  )
})

test('重启后自动下一手沿用快照里的截止时间，不重新计满间隔', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'poker-next-hand-recovery-'))
  const dbPath = join(dir, 'poker.sqlite')
  let server: ServerHandle | null = await startServer(dbPath)
  t.after(async () => { if (server) await server.stop(); rmSync(dir, { recursive: true, force: true }) })

  const host = await postJson<RoomCredentials>(`${server.base}/api/rooms`, {
    nickname: '甲', nextHandSeconds: 120, turnSeconds: 30,
  })
  const guest = await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })
  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0)
  await takeSeat(b, 1)
  a.send({ type: 'game.start', requestId: rid() })
  const started = await a.waitFor((message) => message.type === 'hand.started')
  assert.ok(started.type === 'hand.started')
  a.send({ type: 'game.action', requestId: rid(), handId: started.state.handId!,
    expectedVersion: started.state.version, action: 'fold' })
  const settled = await a.waitFor((message) => message.type === 'hand.settled')
  assert.ok(settled.type === 'hand.settled')
  assert.ok(settled.state.nextHandDeadlineAt)
  a.close()
  b.close()
  await server.stop()
  server = null

  const handle = openDatabase(dbPath)
  const row = handle.db.prepare('SELECT state_json FROM room_snapshots WHERE room_id = ?').get(host.roomId) as
    { state_json: string }
  const snapshot = JSON.parse(row.state_json) as { nextHandDeadlineAt: number }
  snapshot.nextHandDeadlineAt = Date.now() - 1000
  handle.db.prepare('UPDATE room_snapshots SET state_json = ? WHERE room_id = ?')
    .run(JSON.stringify(snapshot), host.roomId)
  handle.close()

  server = await startServer(dbPath)
  const restored = server.rooms.get(host.roomId)
  assert.ok(restored)
  await delay(100)
  assert.equal(restored.table.publicState().handNo, 2)
  assert.equal(restored.turnSeconds, 30)
  assert.equal(restored.nextHandDeadlineAt, null)
})
