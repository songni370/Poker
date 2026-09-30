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

let requestCounter = 0
const rid = (): string => `req-${++requestCounter}`

/** 加入房间命令（多个用例共用；凭证里的重连令牌只在本进程有效）。 */
const joinCommand = (credentials: RoomCredentials): ClientCommand => ({
  type: 'room.join',
  requestId: rid(),
  roomId: credentials.roomId,
  playerId: credentials.playerId,
  reconnectToken: credentials.reconnectToken,
})

/**
 * 落座（新流程）：建房/加入后所有人都是旁观者，必须显式 seat.take 才能入座。
 * 只接受「发送之后」的新消息，否则坐回保留座位时会匹配到历史快照。
 */
async function takeSeat(client: TestClient, seat: number, buyIn?: number): Promise<void> {
  const from = client.messages.length
  client.send({ type: 'seat.take', requestId: rid(), seat, ...(buyIn === undefined ? {} : { buyIn }) })
  await client.waitFor(
    (message) =>
      message.type !== 'room.error' &&
      'self' in message &&
      message.self.seat === seat &&
      'state' in message &&
      message.state.seats[seat]?.away === false,
    5000,
    from,
  )
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 真实 WebSocket 客户端：记录全部原始报文，供信息安全核查使用。 */
class TestClient {
  readonly messages: ServerMessage[] = []
  readonly raw: string[] = []
  private readonly socket: WebSocket
  private waiters: { predicate: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void }[] = []

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.socket.addEventListener('message', (event: MessageEvent) => {
      const text = String(event.data)
      const message = JSON.parse(text) as ServerMessage
      this.raw.push(text)
      this.messages.push(message)
      for (let index = this.waiters.length - 1; index >= 0; index--) {
        const waiter = this.waiters[index]!
        if (waiter.predicate(message)) {
          this.waiters.splice(index, 1)
          waiter.resolve(message)
        }
      }
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

  waitFor(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 4000,
    fromIndex = 0,
  ): Promise<ServerMessage> {
    const existing = this.messages.slice(fromIndex).find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待服务端消息超时')), timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
      })
    })
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

  firstOwnHoleCards(): string[] {
    for (const message of this.messages) {
      if (message.type !== 'room.error' && 'self' in message && message.self.holeCards.length > 0) {
        return message.self.holeCards
      }
    }
    return []
  }

  settledIndex(): number {
    return this.messages.findIndex((message) => message.type === 'hand.settled')
  }
}

async function startServer(): Promise<{
  base: string
  wsUrl: string
  handle: DbHandle
  rooms: RoomManager
  close: () => Promise<void>
}> {
  const dir = mkdtempSync(join(tmpdir(), 'poker-e2e-'))
  const handle = openDatabase(join(dir, 'poker.sqlite'))
  const { app, rooms } = await buildApp(handle, { clientDir: join(dir, 'no-client-dir') })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    handle,
    rooms,
    close: async () => {
      rooms.closeAll()
      await app.close()
      handle.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data: T }> {
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
  return { status: response.status, data: (await response.json()) as T }
}

/** 双方都只用过牌/跟注，保证这手牌一定走到摊牌。 */
async function playHandToShowdown(
  clients: Map<string, TestClient>,
  observer: TestClient,
): Promise<{ settled: boolean; actions: number }> {
  const deadline = Date.now() + 12000
  let actions = 0

  while (Date.now() < deadline) {
    const state = observer.lastState()
    if (state?.phase === 'settlement') return { settled: true, actions }
    const actingPlayerId = state?.actingPlayerId
    if (!actingPlayerId) {
      await delay(15)
      continue
    }
    const client = clients.get(actingPlayerId)
    if (!client) throw new Error(`未知行动者：${actingPlayerId}`)
    const own = client.lastState()
    const self = client.lastSelf()
    if (!own || !self || own.actingPlayerId !== actingPlayerId || self.legalActions.length === 0) {
      await delay(15)
      continue
    }
    const pick =
      self.legalActions.find((action) => action.action === 'check') ??
      self.legalActions.find((action) => action.action === 'call')
    assert.ok(pick, '过牌/跟注应当是合法动作')
    client.send({
      type: 'game.action',
      requestId: rid(),
      handId: own.handId!,
      expectedVersion: own.version,
      action: pick.action,
      amount: pick.amount,
    })
    actions += 1
    await delay(40)
  }
  return { settled: false, actions }
}

test('联机闭环：两个独立会话建房入座、打完一手摊牌，且全程不泄露他人底牌', async (t) => {
  const server = await startServer()
  t.after(server.close)

  const created = await postJson<RoomCredentials>(`${server.base}/api/rooms`, {
    nickname: '阿德',
    roomName: '验收房',
    maxSeats: 2,
  })
  assert.equal(created.status, 201)
  const host = created.data
  const joined = await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '小可' })
  assert.equal(joined.status, 201)
  const guest = joined.data

  assert.equal(guest.roomId, host.roomId)
  assert.notEqual(guest.playerId, host.playerId)
  assert.notEqual(guest.reconnectToken, host.reconnectToken)

  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b.close()
  })
  await Promise.all([a.open(), b.open()])

  const joinCommand = (credentials: RoomCredentials): ClientCommand => ({
    type: 'room.join',
    requestId: rid(),
    roomId: credentials.roomId,
    playerId: credentials.playerId,
    reconnectToken: credentials.reconnectToken,
  })
  a.send(joinCommand(host))
  b.send(joinCommand(guest))

  const snapA = await a.waitFor((message) => message.type === 'room.snapshot')
  const snapB = await b.waitFor((message) => message.type === 'room.snapshot')
  assert.ok(snapA.type === 'room.snapshot' && snapB.type === 'room.snapshot')
  assert.equal(snapA.self.seat, null, '加入后先是旁观者，需要自己落座')
  assert.equal(snapA.state.seats.filter(Boolean).length, 0, '还没人落座')
  await takeSeat(a, 0)
  await takeSeat(b, 1)
  assert.equal(a.lastState()!.seats.filter(Boolean).length, 2, '两名玩家各占一席')
  // 本桌筹码总量：买入额由房主设定的区间决定（默认 2000–5000），守恒断言对着它算，不写死数字。
  const totalChips = a.lastState()!.seats.reduce((sum, seat) => sum + (seat ? seat.stack : 0), 0)
  assert.ok(totalChips > 0)
  assert.equal(snapA.self.holeCards.length, 0, '开局前没有底牌')
  assert.equal(snapA.state.phase, 'waiting')

  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((message) => message.type === 'hand.started')
  await b.waitFor((message) => message.type === 'hand.started')

  const ownA = a.firstOwnHoleCards()
  const ownB = b.firstOwnHoleCards()
  assert.equal(ownA.length, 2, '自己应收到两张底牌')
  assert.equal(ownB.length, 2, '自己应收到两张底牌')
  assert.equal(new Set([...ownA, ...ownB]).size, 4, '双方底牌不得重复')

  const clients = new Map([
    [host.playerId, a],
    [guest.playerId, b],
  ])
  const outcome = await playHandToShowdown(clients, a)
  assert.ok(outcome.settled, `这手牌应在超时前结算（已执行 ${outcome.actions} 次动作）`)
  assert.ok(outcome.actions > 0, '应至少发生过一次行动')

  const settledA = await a.waitFor((message) => message.type === 'hand.settled')
  await b.waitFor((message) => message.type === 'hand.settled')
  assert.ok(settledA.type === 'hand.settled')
  assert.ok(settledA.result, '结算事件必须携带结果')
  assert.equal(settledA.result.showdown, true, '全程跟注应走到摊牌')
  assert.equal(settledA.result.board.length, 5)

  const finalState = a.lastState()!
  const totalStacks = finalState.seats.reduce((sum, seat) => sum + (seat ? seat.stack : 0), 0)
  const totalCommitted = finalState.seats.reduce((sum, seat) => sum + (seat ? seat.committedHand : 0), 0)
  assert.equal(totalStacks + totalCommitted, totalChips, '一手结束后筹码必须守恒')

  // ── 信息安全核查：摊牌之前，主机收到的任何报文都不得包含对手底牌 ──
  const settleIndex = a.settledIndex()
  assert.ok(settleIndex > 0, '应能定位到结算事件')
  const opponentCards = settledA.result.revealed.find((entry) => entry.playerId === guest.playerId)?.cards ?? []
  assert.equal(opponentCards.length, 2, '摊牌后应能拿到对手亮出的底牌')

  for (let index = 0; index < settleIndex; index++) {
    for (const card of opponentCards) {
      assert.ok(
        !a.raw[index]!.includes(`"${card}"`),
        `第 ${index} 条报文（${a.messages[index]!.type}）泄露了对手底牌 ${card}`,
      )
    }
  }
  // 反向对照：证明上面的检查不是空跑——主机自己的底牌确实出现在报文中。
  assert.ok(
    a.raw.slice(0, settleIndex).some((text) => ownA.every((card) => text.includes(`"${card}"`))),
    '主机应当收到自己的底牌',
  )

  // 结算后允许公开摊牌牌面
  assert.ok(a.messages.some((message) => message.type === 'hand.settled'))
  assert.equal(b.firstOwnHoleCards().length, 2)

  // ── 持久化核查：手牌结算、命令凭据与玩家筹码都已落库 ──
  const handRows = server.handle.db.prepare('SELECT COUNT(*) AS c FROM hand_results').get() as unknown as { c: number }
  assert.equal(Number(handRows.c), 1, '一手结束应写入 1 条 hand_results')
  const receiptRows = server.handle.db.prepare('SELECT COUNT(*) AS c FROM command_receipts').get() as unknown as {
    c: number
  }
  assert.ok(Number(receiptRows.c) > 0, '命令应写入幂等凭据')
  const playerStacks = server.handle.db.prepare('SELECT stack FROM players').all() as unknown as { stack: number }[]
  assert.equal(playerStacks.length, 2)
  assert.equal(
    playerStacks.reduce((sum, row) => sum + Number(row.stack), 0),
    totalChips,
    '落库后的筹码同样守恒',
  )
})

test('连续两手：结算后可以开始下一手，庄位轮转且筹码继续守恒', async (t) => {
  const server = await startServer()
  t.after(server.close)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲', maxSeats: 2 })).data
  const guest = (
    await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })
  ).data

  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b.close()
  })
  await Promise.all([a.open(), b.open()])
  a.send({
    type: 'room.join',
    requestId: rid(),
    roomId: host.roomId,
    playerId: host.playerId,
    reconnectToken: host.reconnectToken,
  })
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send({
    type: 'room.join',
    requestId: rid(),
    roomId: guest.roomId,
    playerId: guest.playerId,
    reconnectToken: guest.reconnectToken,
  })
  await b.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0)
  await takeSeat(b, 1)
  const totalChips = a.lastState()!.seats.reduce((sum, seat) => sum + (seat ? seat.stack : 0), 0)

  const clients = new Map([
    [host.playerId, a],
    [guest.playerId, b],
  ])

  const buttonSeats: (number | null)[] = []
  for (let handNo = 1; handNo <= 2; handNo++) {
    const startedBefore = a.messages.filter((message) => message.type === 'hand.started').length
    a.send({ type: 'game.start', requestId: rid() })
    await a.waitFor((message) => message.type === 'hand.started' && message.state.handNo === handNo)
    await b.waitFor((message) => message.type === 'hand.started' && message.state.handNo === handNo)
    assert.equal(
      a.messages.filter((message) => message.type === 'hand.started').length,
      startedBefore + 1,
      `第 ${handNo} 手应只开始一次`,
    )

    const state = a.lastState()!
    assert.equal(state.handNo, handNo)
    buttonSeats.push(state.buttonSeat)

    assert.ok((await playHandToShowdown(clients, a)).settled, `第 ${handNo} 手应能结算`)
    const settled = a.lastState()!
    const total = settled.seats.reduce((sum, seat) => sum + (seat ? seat.stack + seat.committedHand : 0), 0)
    assert.equal(total, totalChips, `第 ${handNo} 手后筹码守恒`)
    assert.equal(settled.phase, 'settlement')
  }

  assert.equal(buttonSeats.length, 2)
  assert.notEqual(buttonSeats[0], buttonSeats[1], '双人桌庄位应在两手之间轮转')

  const handRows = server.handle.db.prepare('SELECT COUNT(*) AS c FROM hand_results').get() as unknown as { c: number }
  assert.equal(Number(handRows.c), 2, '两手牌应各写入一条结算记录')
})

test('闲置房间回收：全员离线超过阈值后关闭并移出内存', async (t) => {
  const server = await startServer()
  t.after(server.close)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '房主', maxSeats: 2 })).data
  const before = (await (await fetch(`${server.base}/api/rooms/${host.roomId}`)).json()) as { status: string }
  assert.equal(before.status, 'waiting')

  assert.equal(server.rooms.roomCount(), 1)
  assert.equal(server.rooms.sweepIdleRooms(60 * 60 * 1000), 0, '未超过阈值不应回收')
  assert.equal(server.rooms.sweepIdleRooms(0), 1, '全员离线且到达阈值应回收')
  assert.equal(server.rooms.roomCount(), 0)
  assert.equal(server.rooms.get(host.roomId), undefined)
  assert.equal((await fetch(`${server.base}/api/rooms/${host.roomId}`)).status, 404, '回收后房间不可再访问')
})

test('房间自动关闭：全员退出立即关、没人落座且无人在线关、5 分钟没人操作关', async (t) => {
  const server = await startServer()
  t.after(server.close)

  // ① 所有人都退出 → 立即关闭
  const first = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲' })).data
  const client = new TestClient(server.wsUrl)
  t.after(() => client.close())
  await client.open()
  client.send(joinCommand(first))
  await client.waitFor((m) => m.type === 'room.snapshot')
  assert.equal(server.rooms.roomCount(), 1)
  client.send({ type: 'room.leave', requestId: rid() })
  await delay(120)
  assert.equal(server.rooms.sweepIdleRooms(60 * 60 * 1000), 1, '所有人都退出的房间应立即关闭（不受阈值影响）')
  assert.equal(server.rooms.get(first.roomId), undefined)

  // ② 没人在线、也没人落座 → 过了宽限期就关
  const second = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '乙' })).data
  assert.equal(server.rooms.sweepIdleRooms(60 * 60 * 1000), 0, '刚建好、还没人连上时不能被自己的回收器关掉')
  assert.equal(server.rooms.sweepIdleRooms(0), 1, '到达阈值后应关闭')
  assert.equal(server.rooms.get(second.roomId), undefined)

  // ③ 「5 分钟没有任何玩家操作」：有人落座且在线时不关；掉线后到达阈值才关
  const third = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '丙' })).data
  const owner = new TestClient(server.wsUrl)
  t.after(() => owner.close())
  await owner.open()
  owner.send(joinCommand(third))
  await owner.waitFor((m) => m.type === 'room.snapshot')
  await takeSeat(owner, 0)
  assert.equal(server.rooms.sweepIdleRooms(0), 0, '还有人在线时不能回收正在玩的桌子')
  owner.close()
  await delay(120)
  assert.equal(server.rooms.sweepIdleRooms(0), 1, '最后一个人掉线后到达阈值应关闭')
})

test('网络一致性：重复请求幂等、过期版本被拒绝', async (t) => {
  const server = await startServer()
  t.after(server.close)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲', maxSeats: 2 })).data
  const guest = (
    await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })
  ).data

  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b.close()
  })
  await Promise.all([a.open(), b.open()])
  a.send({
    type: 'room.join',
    requestId: rid(),
    roomId: host.roomId,
    playerId: host.playerId,
    reconnectToken: host.reconnectToken,
  })
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send({
    type: 'room.join',
    requestId: rid(),
    roomId: guest.roomId,
    playerId: guest.playerId,
    reconnectToken: guest.reconnectToken,
  })
  await b.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0)
  await takeSeat(b, 1)

  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((message) => message.type === 'hand.started')
  await b.waitFor((message) => message.type === 'hand.started')

  // 等到轮到自己时构造一条确定性命令
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && a.lastState()?.actingPlayerId !== host.playerId) await delay(15)
  const own = a.lastState()!
  const self = a.lastSelf()!
  assert.equal(own.actingPlayerId, host.playerId)
  const pick = self.legalActions.find((action) => action.action === 'call') ?? self.legalActions[0]!
  const command: ClientCommand = {
    type: 'game.action',
    requestId: `dup-${rid()}`,
    handId: own.handId!,
    expectedVersion: own.version,
    action: pick.action,
    amount: pick.amount,
  }

  const broadcastsBefore = b.messages.filter((message) => message.type !== 'pong').length
  a.send(command)
  await delay(120)
  const broadcastsAfterFirst = b.messages.filter((message) => message.type !== 'pong').length
  assert.equal(broadcastsAfterFirst, broadcastsBefore + 1, '首次执行应广播一次状态变化')

  // 同一 requestId 重放：只补发快照给发起者，不重复改变牌局
  a.send(command)
  await delay(150)
  const broadcastsAfterReplay = b.messages.filter((message) => message.type !== 'pong').length
  assert.equal(broadcastsAfterReplay, broadcastsAfterFirst, '重复请求不得再次改变牌局')

  // 过期版本：必须被拒绝，并回发最新快照让客户端重新对齐
  const staleVersion = a.lastState()!.version - 1
  a.send({
    type: 'game.action',
    requestId: rid(),
    handId: a.lastState()!.handId!,
    expectedVersion: staleVersion < 0 ? 0 : staleVersion,
    action: pick.action,
    amount: pick.amount,
  })
  const staleError = await a.waitFor(
    (message) => message.type === 'room.error' && message.error?.code === 'stale_version',
  )
  assert.ok(staleError.type === 'room.error')
  assert.equal(staleError.error?.code, 'stale_version')
})

test('断线重连：凭证正确可拿到一致快照，凭证错误被拒绝', async (t) => {
  const server = await startServer()
  t.after(server.close)

  const created = await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '房主', maxSeats: 3 })
  const host = created.data
  const guest = (
    await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '断线者' })
  ).data

  const first = new TestClient(server.wsUrl)
  await first.open()
  first.send({
    type: 'room.join',
    requestId: rid(),
    roomId: guest.roomId,
    playerId: guest.playerId,
    reconnectToken: guest.reconnectToken,
  })
  await first.waitFor((message) => message.type === 'room.snapshot')

  const hostClient = new TestClient(server.wsUrl)
  await hostClient.open()
  hostClient.send({
    type: 'room.join',
    requestId: rid(),
    roomId: host.roomId,
    playerId: host.playerId,
    reconnectToken: host.reconnectToken,
  })
  await hostClient.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(first, 0)
  await takeSeat(hostClient, 1)

  hostClient.send({ type: 'game.start', requestId: rid() })
  // 两名玩家都收到 hand.started 后再读取，避免把推送时延误判成数据缺失。
  await Promise.all([
    hostClient.waitFor((message) => message.type === 'hand.started'),
    first.waitFor((message) => message.type === 'hand.started'),
  ])
  const before = first.lastState()!
  const holeBefore = first.firstOwnHoleCards()
  assert.equal(holeBefore.length, 2)

  // 断线
  first.close()
  await delay(80)

  // 冒名重连：错误的凭证必须被拒绝
  const impostor = new TestClient(server.wsUrl)
  await impostor.open()
  impostor.send({
    type: 'room.join',
    requestId: rid(),
    roomId: guest.roomId,
    playerId: guest.playerId,
    reconnectToken: 'not-the-real-token',
  })
  const rejected = await impostor.waitFor((message) => message.type === 'room.error')
  assert.ok(rejected.type === 'room.error')
  assert.equal(rejected.error?.code, 'unauthorized')
  impostor.close()

  // 正确凭证重连：拿到一致快照 + 自己的底牌
  const second = new TestClient(server.wsUrl)
  await second.open()
  second.send({
    type: 'room.join',
    requestId: rid(),
    roomId: guest.roomId,
    playerId: guest.playerId,
    reconnectToken: guest.reconnectToken,
  })
  const recovered = await second.waitFor((message) => message.type === 'connection.recovered')
  assert.ok(recovered.type === 'connection.recovered')
  assert.equal(recovered.state.handId, before.handId, '重连后仍处于同一手牌')
  assert.equal(recovered.self.playerId, guest.playerId)
  assert.deepEqual(
    [...recovered.self.holeCards].sort(),
    [...holeBefore].sort(),
    '重连后拿回自己的底牌',
  )
  assert.ok(
    recovered.version >= before.version,
    '重连快照版本不得倒退',
  )
  second.close()
})
