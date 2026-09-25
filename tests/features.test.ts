import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAT_MAX_LENGTH } from '../src/shared/protocol.ts'
import type { ChatMessage, RoomCredentials, ServerMessage } from '../src/shared/protocol.ts'
import { TestClient, delay, joinCommand, postJson, rid, startTestServer, takeSeat } from './helpers.ts'
import { Repo, newRoomId } from '../src/server/repo.ts'
import { buildApp } from '../src/server/app.ts'
import { openDatabase } from '../src/server/db/index.ts'
import { RoomRuntime, type RoomSnapshot } from '../src/server/rooms.ts'

test('计分板累计买入、参局与离桌筹码，并保存进房间快照', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)
  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '房主' })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '玩家' })).data
  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => { a.close(); b.close() })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((m) => m.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((m) => m.type === 'room.snapshot')
  assert.deepEqual(a.lastState()?.scores, [], '未入座的旁观者不进入计分板')

  await takeSeat(a, 0, 2000)
  await takeSeat(b, 1, 3000)
  assert.deepEqual(a.lastState()?.scores.map((score) => [score.nickname, score.totalBuyIn, score.buyInCount]), [
    ['房主', 2000, 1], ['玩家', 3000, 1],
  ])

  const fromStart = a.messages.length
  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((m) => m.type === 'hand.started', 5000, fromStart)
  assert.deepEqual(a.lastState()?.scores.map((score) => score.handsPlayed), [1, 1])

  const fromLeave = b.messages.length
  a.send({ type: 'room.leave', requestId: rid() })
  await b.waitFor((m) => 'state' in m && m.state.scores.some((score) => score.playerId === host.playerId && !score.seated), 5000, fromLeave)
  const departed = b.lastState()!.scores.find((score) => score.playerId === host.playerId)!
  assert.equal(departed.seated, false)
  assert.equal(departed.net, departed.banked + departed.stack - departed.totalBuyIn, '离桌带走的筹码仍计入净筹码')
  assert.ok(departed.banked > 0)
  const saved = server.handle.db.prepare('SELECT state_json FROM room_snapshots WHERE room_id = ?').get(host.roomId) as { state_json: string }
  assert.equal(JSON.parse(saved.state_json).scores.length, 2)
  const recovered = RoomRuntime.fromSnapshot(JSON.parse(saved.state_json) as RoomSnapshot)
  assert.equal(recovered.scores.get(host.playerId)?.banked, departed.banked)
})

test('只有房主可调整思考与下一手时间，进行中仍不能修改买入范围', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)
  const created = await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '房主' })
  assert.equal(created.status, 201)
  const host = created.data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '玩家' })).data
  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => { a.close(); b.close() })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0)
  await takeSeat(b, 1)
  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((message) => message.type === 'hand.started')

  const deniedFrom = b.messages.length
  b.send({ type: 'room.configure', requestId: rid(), turnSeconds: 45, nextHandSeconds: 0 })
  const denied = await b.waitFor((message) => message.type === 'room.error', 5000, deniedFrom)
  assert.equal(denied.type === 'room.error' && denied.error?.code, 'not_host')

  const before = a.lastState()!
  const from = a.messages.length
  const attemptedBuyInChange = {
    type: 'room.configure' as const, requestId: rid(), turnSeconds: 45, nextHandSeconds: 0,
    minBuyIn: 9999, buyInMax: 9999,
  }
  a.send(attemptedBuyInChange)
  const changed = await a.waitFor((message) => message.type === 'room.configured', 5000, from)
  assert.equal(changed.type === 'room.configured' && changed.state.turnSeconds, 45)
  assert.equal(a.lastState()!.nextHandSeconds, 0)
  assert.equal(a.lastState()!.turnDeadlineAt, before.turnDeadlineAt, '当前玩家的倒计时不应重新开始')
  assert.equal(a.lastState()!.buyInMin, before.buyInMin)
  assert.equal(a.lastState()!.buyInMax, before.buyInMax)
  const row = server.handle.db.prepare('SELECT turn_seconds, next_hand_seconds, min_buy_in, buy_in_max FROM rooms WHERE room_id = ?')
    .get(host.roomId) as { turn_seconds: number; next_hand_seconds: number; min_buy_in: number; buy_in_max: number }
  assert.equal(row.turn_seconds, 45)
  assert.equal(row.next_hand_seconds, 0)
  assert.equal(row.min_buy_in, before.buyInMin)
  assert.equal(row.buy_in_max, before.buyInMax)
  const snapshot = server.handle.db.prepare('SELECT state_json FROM room_snapshots WHERE room_id = ?').get(host.roomId) as { state_json: string }
  assert.equal(JSON.parse(snapshot.state_json).turnSeconds, 45)
})

test('房主退出后按座位顺延，观战者不能抢先继任，权限和数据库同步更新', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '房主' })).data
  const spectator = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '观战' })).data
  const clockwise = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '顺位' })).data
  const wrapped = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '次位' })).data
  const clients = [host, spectator, clockwise, wrapped].map(() => new TestClient(server.wsUrl))
  t.after(() => clients.forEach((client) => client.close()))
  await Promise.all(clients.map((client) => client.open()))
  for (let index = 0; index < clients.length; index++) {
    clients[index]!.send(joinCommand([host, spectator, clockwise, wrapped][index]!))
    await clients[index]!.waitFor((message) => message.type === 'room.snapshot')
  }
  await takeSeat(clients[0]!, 4)
  await takeSeat(clients[2]!, 6)
  await takeSeat(clients[3]!, 1)

  const from = clients.map((client) => client.messages.length)
  clients[0]!.send({ type: 'room.leave', requestId: rid() })
  const changed = await clients[2]!.waitFor((message) => message.type === 'room.player_left', 5000, from[2])
  await Promise.all([1, 3].map((index) => clients[index]!.waitFor((message) => message.type === 'room.player_left', 5000, from[index])))
  assert.equal(changed.type === 'room.player_left' && changed.self.isHost, true)
  assert.equal(clients[2]!.lastState()!.seats[6]?.isHost, true)
  assert.equal(clients[1]!.lastSelf()!.isHost, false)
  assert.equal(clients[3]!.lastSelf()!.isHost, false)

  const roomRow = server.handle.db.prepare('SELECT host_player_id FROM rooms WHERE room_id = ?').get(host.roomId) as { host_player_id: string }
  assert.equal(roomRow.host_player_id, clockwise.playerId)
  const hosts = server.handle.db.prepare('SELECT player_id FROM players WHERE room_id = ? AND is_host = 1').all(host.roomId) as { player_id: string }[]
  assert.deepEqual(hosts.map((row) => row.player_id), [clockwise.playerId])

  const deniedFrom = clients[1]!.messages.length
  clients[1]!.send({ type: 'room.members', requestId: rid() })
  const denied = await clients[1]!.waitFor((message) => message.type === 'room.error', 5000, deniedFrom)
  assert.equal(denied.type === 'room.error' && denied.error?.code, 'not_host')
  const allowedFrom = clients[2]!.messages.length
  clients[2]!.send({ type: 'room.members', requestId: rid() })
  await clients[2]!.waitFor((message) => message.type === 'room.members', 5000, allowedFrom)
})

test('房间上限：服务器最多同时开放 10 桌，关闭一桌后可以再开', async (t) => {
  // 产品默认上限是 10（DEFAULT_MAX_ROOMS）；这里显式传 10，避免测试依赖环境变量。
  const server = await startTestServer({ maxRooms: 10 })
  t.after(server.stop)

  const created: RoomCredentials[] = []
  for (let index = 0; index < 10; index++) {
    const response = await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: `房主${String(index)}` })
    assert.equal(response.status, 201, `第 ${String(index + 1)} 桌应创建成功`)
    created.push(response.data)
  }

  const eleventh = await postJson<{ error: string; message: string }>(`${server.base}/api/rooms`, { nickname: '第十一桌' })
  assert.equal(eleventh.status, 409, '第 11 桌应被拒绝')
  assert.equal(eleventh.data.error, 'room_full')
  assert.match(eleventh.data.message, /10 桌/, '提示里要说清上限是 10 桌')

  const health = (await (await fetch(`${server.base}/api/health`)).json()) as { rooms: number; maxRooms: number }
  assert.equal(health.rooms, 10)
  assert.equal(health.maxRooms, 10)

  // 回收一桌（全员离线且到达阈值）后应能再开
  assert.equal(server.rooms.sweepIdleRooms(0), 10, '十桌都无人在线，应可全部回收')
  const afterSweep = await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '新桌主' })
  assert.equal(afterSweep.status, 201, '回收后应能重新开桌')
  assert.ok(created.length === 10)
})

test('房间号：纯数字 6 位；撞上已有房间（含历史房间）自动重摇', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)
  const repo = new Repo(server.handle.db)

  // 1) 格式：6 位纯数字且首位非 0，避免「012345」被当成 12345 念出去。
  for (let index = 0; index < 50; index++) {
    const id = newRoomId()
    assert.match(id, /^[1-9]\d{5}$/, `房间号应是 6 位数字，实际 ${id}`)
  }

  // 2) 撞号就重摇：仓储说已存在时必须换一个，一直撞则报错（不能死循环）。
  const tried: string[] = []
  const accepted = newRoomId((candidate) => {
    tried.push(candidate)
    return tried.length < 3
  })
  assert.equal(tried.length, 3, '前两次被占用时应继续重摇')
  assert.equal(tried[2], accepted, '返回的应是第三次摇到的号')
  assert.throws(() => newRoomId(() => true), /房间号分配失败/)

  // 3) 已关闭的历史房间也算占用：room_id 是主键，重号会让建房写库失败。
  repo.insertRoom({
    roomId: '100000',
    roomName: '上一版留下的房',
    hostPlayerId: 'player-old',
    status: 'closed',
    smallBlind: 10,
    bigBlind: 20,
    startingStack: 2000,
    maxSeats: 9,
    turnSeconds: 20,
    nextHandSeconds: 0,
  })
  assert.equal(repo.roomExists('100000'), true, '历史房间号也算已占用')
  assert.equal(repo.roomExists('999999'), false, '没建过的号应是空的')

  // 4) 真实建房拿到的房间号同样是纯数字，并且已经入库。
  const created = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '房主' })).data
  assert.match(created.roomId, /^[1-9]\d{5}$/)
  assert.equal(repo.roomExists(created.roomId), true, '新房间应已入库')
})

test('房间密码：创建必须设置 6 位数字，错误密码拒绝加入，正确密码允许加入', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'poker-password-test-'))
  const handle = openDatabase(join(dir, 'poker.sqlite'))
  const { app, rooms } = await buildApp(handle, { clientDir: join(dir, 'no-client-dir'), logLevel: 'silent' })
  t.after(async () => {
    rooms.closeAll()
    await app.close()
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const missingPassword = await app.inject({ method: 'POST', url: '/api/rooms', payload: { nickname: '房主' } })
  assert.equal(missingPassword.statusCode, 400)
  const invalidPassword = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { nickname: '房主', password: '12345' },
  })
  assert.equal(invalidPassword.statusCode, 400)

  const created = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { nickname: '房主', password: '008042' },
  })
  assert.equal(created.statusCode, 201)
  const credentials = created.json<RoomCredentials>()
  assert.equal(JSON.stringify(credentials).includes('008042'), false, '房间密码不应进入客户端凭证')

  const wrongPassword = await app.inject({
    method: 'POST',
    url: `/api/rooms/${credentials.roomId}/join`,
    payload: { nickname: '访客', password: '123456' },
  })
  assert.equal(wrongPassword.statusCode, 403)
  assert.equal(wrongPassword.json<{ error: string }>().error, 'bad_password')

  const joined = await app.inject({
    method: 'POST',
    url: `/api/rooms/${credentials.roomId}/join`,
    payload: { nickname: '访客', password: '008042' },
  })
  assert.equal(joined.statusCode, 201)
  assert.equal(joined.json<RoomCredentials>().isHost, false)
  assert.equal(JSON.stringify(rooms.get(credentials.roomId)?.serialize()).includes('008042'), false)
})

test('房主自定义盲注：建房校验、买入步进、发盲与公开状态使用同一桌规', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)

  for (const blinds of [
    { smallBlind: 20, bigBlind: 20 },
    { smallBlind: 10, bigBlind: 1001 },
    { smallBlind: 20, bigBlind: 40, minBuyIn: 200, buyInMax: 1000 },
    { smallBlind: 39, bigBlind: 40, minBuyIn: 401, buyInMax: 401 },
  ]) {
    const rejected = await postJson<{ error: string }>(`${server.base}/api/rooms`, { nickname: '甲', ...blinds })
    assert.equal(rejected.status, 400)
    assert.equal(rejected.data.error, 'bad_request')
  }

  const created = await postJson<RoomCredentials>(`${server.base}/api/rooms`, {
    nickname: '甲', smallBlind: 15, bigBlind: 30, minBuyIn: 300, buyInMax: 1500,
  })
  assert.equal(created.status, 201)
  const host = created.data
  const info = await (await fetch(`${server.base}/api/rooms/${host.roomId}`)).json() as {
    smallBlind: number; bigBlind: number; buyInMin: number; buyInMax: number; buyInStep: number
  }
  assert.deepEqual(
    [info.smallBlind, info.bigBlind, info.buyInMin, info.buyInMax, info.buyInStep],
    [15, 30, 300, 1500, 15],
  )
  const row = server.handle.db.prepare('SELECT small_blind, big_blind FROM rooms WHERE room_id = ?').get(host.roomId) as
    { small_blind: number; big_blind: number }
  assert.deepEqual([row.small_blind, row.big_blind], [15, 30])

  const rounded = await postJson<RoomCredentials>(`${server.base}/api/rooms`, {
    nickname: '丙', smallBlind: 15, bigBlind: 30, minBuyIn: 301, buyInMax: 1508,
  })
  assert.equal(rounded.status, 201)
  const roundedInfo = await (await fetch(`${server.base}/api/rooms/${rounded.data.roomId}`)).json() as {
    buyInMin: number; buyInMax: number
  }
  assert.deepEqual([roundedInfo.buyInMin, roundedInfo.buyInMax], [315, 1500])

  const highBlinds = await postJson<RoomCredentials>(`${server.base}/api/rooms`, {
    nickname: '丁', smallBlind: 999, bigBlind: 1000,
  })
  assert.equal(highBlinds.status, 201)
  const highInfo = await (await fetch(`${server.base}/api/rooms/${highBlinds.data.roomId}`)).json() as {
    buyInMin: number; buyInMax: number
  }
  assert.deepEqual([highInfo.buyInMin, highInfo.buyInMax], [10989, 10989])

  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data
  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => { a.close(); b.close() })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0, 308)
  await takeSeat(b, 1, 1500)
  assert.equal(a.lastState()!.seats[0]!.stack, 315, '落座买入按本桌小盲 15 取整')

  a.send({ type: 'game.start', requestId: rid() })
  const started = await a.waitFor((message) => message.type === 'hand.started')
  assert.ok(started.type === 'hand.started')
  assert.equal(started.state.smallBlind, 15)
  assert.equal(started.state.bigBlind, 30)
  assert.equal(started.state.minRaise, 30)
  assert.equal(started.state.seats[0]!.committedStreet, 15)
  assert.equal(started.state.seats[1]!.committedStreet, 30)
})

test('房主自定义计时：行动倒计时与结算后自动开下一手', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)
  for (const settings of [
    { turnSeconds: 29 }, { turnSeconds: 301 }, { nextHandSeconds: -1 }, { nextHandSeconds: 121 },
  ]) {
    const rejected = await postJson<{ error: string }>(`${server.base}/api/rooms`, { nickname: '甲', ...settings })
    assert.equal(rejected.status, 400)
  }
  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, {
    nickname: '甲', turnSeconds: 30, nextHandSeconds: 1,
  })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data
  const row = server.handle.db.prepare('SELECT turn_seconds, next_hand_seconds FROM rooms WHERE room_id = ?')
    .get(host.roomId) as { turn_seconds: number; next_hand_seconds: number }
  assert.deepEqual([row.turn_seconds, row.next_hand_seconds], [30, 1])
  const info = await (await fetch(`${server.base}/api/rooms/${host.roomId}`)).json() as
    { turnSeconds: number; nextHandSeconds: number }
  assert.deepEqual([info.turnSeconds, info.nextHandSeconds], [30, 1])

  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => { a.close(); b.close() })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0, 500)
  await takeSeat(b, 1, 500)
  a.send({ type: 'game.start', requestId: rid() })
  const first = await a.waitFor((message) => message.type === 'hand.started')
  assert.ok(first.type === 'hand.started')
  assert.equal(first.state.turnSeconds, 30)
  assert.equal(first.state.nextHandSeconds, 1)
  assert.ok(first.state.turnDeadlineAt && first.state.turnDeadlineAt - Date.now() <= 30000)

  a.send({ type: 'game.action', requestId: rid(), handId: first.state.handId!,
    expectedVersion: first.state.version, action: 'fold' })
  const settled = await a.waitFor((message) => message.type === 'hand.settled')
  assert.ok(settled.type === 'hand.settled')
  assert.ok(settled.state.nextHandDeadlineAt && settled.state.nextHandDeadlineAt > Date.now())
  const saved = server.handle.db.prepare('SELECT state_json FROM room_snapshots WHERE room_id = ?').get(host.roomId) as
    { state_json: string }
  assert.equal((JSON.parse(saved.state_json) as { nextHandDeadlineAt: number }).nextHandDeadlineAt,
    settled.state.nextHandDeadlineAt)
  const from = a.messages.length
  const second = await a.waitFor((message) => message.type === 'hand.started' && message.state.handNo === 2, 3000, from)
  assert.ok(second.type === 'hand.started')
  assert.equal(second.state.nextHandDeadlineAt, null)

  const actor = second.state.actingPlayerId === host.playerId ? a : b
  actor.send({ type: 'game.action', requestId: rid(), handId: second.state.handId!,
    expectedVersion: second.state.version, action: 'fold' })
  const secondSettlement = await a.waitFor((message) => message.type === 'hand.settled' && message.state.handNo === 2)
  assert.ok(secondSettlement.type === 'hand.settled')
  a.send({ type: 'game.start', requestId: rid() })
  const third = await a.waitFor((message) => message.type === 'hand.started' && message.state.handNo === 3)
  assert.ok(third.type === 'hand.started')
  assert.equal(third.state.nextHandDeadlineAt, null, '房主提前开局后应取消原来的自动计时')
})

test('自动下一手人数不足时不发牌；有人重新买入后重新计时', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)
  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, {
    nickname: '甲', minBuyIn: 200, buyInMax: 1000, nextHandSeconds: 1,
  })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data
  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => { a.close(); b.close() })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0, 200)
  await takeSeat(b, 1, 200)
  a.send({ type: 'game.start', requestId: rid() })
  const started = await a.waitFor((message) => message.type === 'hand.started')
  assert.ok(started.type === 'hand.started')
  a.send({ type: 'game.action', requestId: rid(), handId: started.state.handId!,
    expectedVersion: started.state.version, action: 'all_in' })
  await b.waitFor((message) => message.type === 'turn.started' && message.state.currentBet === 200)
  b.send({ type: 'game.action', requestId: rid(), handId: b.lastState()!.handId!,
    expectedVersion: b.lastState()!.version, action: 'call' })
  const settled = await a.waitFor((message) => message.type === 'hand.settled')
  assert.ok(settled.type === 'hand.settled')
  // 随机牌面可能平局；此用例只测计时器的人数门槛，平局时构造确定性的 0 筹码座位。
  let bustedSeat = settled.state.seats[0]?.stack === 0 ? 0 : 1
  if ((settled.state.seats[bustedSeat]?.stack ?? 0) > 0) {
    server.rooms.get(host.roomId)!.table.seatOf(host.playerId)!.stack = 0
    bustedSeat = 0
  }
  const afterExpiry = await a.waitFor((message) => message.type === 'hand.state_changed' &&
    message.state.handNo === 1 && message.state.nextHandDeadlineAt === null, 3000, a.messages.length)
  assert.ok(afterExpiry.type === 'hand.state_changed')
  assert.equal(server.rooms.get(host.roomId)!.table.publicState().handNo, 1)

  const busted = bustedSeat === 0 ? a : b
  await takeSeat(busted, bustedSeat, 300)
  assert.ok(busted.lastState()!.nextHandDeadlineAt, '重新买入后重新计时')
  const next = await a.waitFor((message) => message.type === 'hand.started' && message.state.handNo === 2,
    3000, a.messages.length)
  assert.ok(next.type === 'hand.started')
})

test('聊天：广播给房内所有人、重连能拿到历史、服务端限流与长度校验', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲', maxSeats: 4 })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data

  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b.close()
  })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  // 新流程：加入后都是旁观者，要显式落座才能进牌局
  await takeSeat(a, 0)
  await takeSeat(b, 1)

  const versionBefore = a.lastState()!.version
  a.send({ type: 'chat.send', requestId: rid(), text: '  大家好，开局吧  ' })
  // 房间事件也会进聊天流（system），这里只等玩家发言。
  const receivedByB = await b.waitFor(
    (message) => message.type === 'chat.message' && message.message.kind === 'user',
  )
  assert.ok(receivedByB.type === 'chat.message')
  assert.equal(receivedByB.message.text, '大家好，开局吧', '首尾空白应被去掉')
  assert.equal(receivedByB.message.nickname, '甲')

  // 聊天不是牌局状态：不得推进版本号，否则会误伤别人正在提交的动作
  assert.equal(a.lastState()!.version, versionBefore, '聊天不应推进房间版本号')

  // 另一位玩家发言，房主也能收到
  b.send({ type: 'chat.send', requestId: rid(), text: '来' })
  const receivedByA = await a.waitFor(
    (message) => message.type === 'chat.message' && message.message.kind === 'user' && message.message.nickname === '乙',
  )
  assert.ok(receivedByA.type === 'chat.message')

  // 长度校验：超长直接拒绝
  a.send({ type: 'chat.send', requestId: rid(), text: 'x'.repeat(CHAT_MAX_LENGTH + 1) })
  const tooLong = await a.waitFor((message) => message.type === 'room.error')
  assert.ok(tooLong.type === 'room.error')
  assert.equal(tooLong.error?.code, 'bad_request')

  // 限流：窗口内第 6 条应被拒绝
  for (let index = 0; index < 6; index++) {
    a.send({ type: 'chat.send', requestId: rid(), text: `刷屏 ${String(index)}` })
  }
  const rateLimited = await a.waitFor(
    (message) => message.type === 'room.error' && message.error?.code === 'rate_limited',
  )
  assert.ok(rateLimited.type === 'room.error')
  assert.equal(rateLimited.error?.code, 'rate_limited', '连续发言应触发限流')

  // 新加入的人能看到聊天历史
  const latecomer = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '丙' })).data
  const c = new TestClient(server.wsUrl)
  t.after(() => c.close())
  await c.open()
  c.send(joinCommand(latecomer))
  const snapshot = await c.waitFor((message) => message.type === 'room.snapshot')
  assert.ok(snapshot.type === 'room.snapshot')
  const history = (snapshot.chatHistory ?? []) as ChatMessage[]
  assert.ok(history.length >= 2, `新加入者应拿到聊天历史，实际 ${String(history.length)} 条`)
  assert.ok(history.some((message) => message.text === '大家好，开局吧'))
})

test('全下摊牌：公共牌按翻牌 → 转牌 → 河牌逐段推送，最后才发结算', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲', maxSeats: 2 })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data
  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b.close()
  })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  // 新流程：加入后都是旁观者，要显式落座才能进牌局
  await takeSeat(a, 0)
  await takeSeat(b, 1)

  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((message) => message.type === 'hand.started')
  await b.waitFor((message) => message.type === 'hand.started')

  // 双人桌翻牌前由庄家（小盲）先行动，双方直接全下 → 一次性发完公共牌
  const clients = new Map([
    [host.playerId, a],
    [guest.playerId, b],
  ])
  const deadline = Date.now() + 8000
  let pushed = 0
  while (pushed < 2 && Date.now() < deadline) {
    const state = a.lastState()
    if (!state || state.phase === 'settlement') break
    const actingId = state.actingPlayerId
    const client = actingId ? clients.get(actingId) : undefined
    const self = client?.lastSelf()
    if (!client || !self || self.legalActions.length === 0) {
      await delay(20)
      continue
    }
    const allIn = self.legalActions.find((action) => action.action === 'all_in')
    assert.ok(allIn, '应提供全下选项')
    client.send({
      type: 'game.action',
      requestId: rid(),
      handId: state.handId!,
      expectedVersion: state.version,
      action: 'all_in',
    })
    pushed += 1
    await delay(60)
  }
  assert.equal(pushed, 2, '双方应都已全下')

  // 等服务端把 0 → 3 → 4 → 5 逐段推完（每段 750ms）
  const settleDeadline = Date.now() + 8000
  while (Date.now() < settleDeadline) {
    if (a.messages.some((message) => message.type === 'hand.settled')) break
    await delay(50)
  }
  const settledIndex = a.messages.findIndex((message) => message.type === 'hand.settled')
  assert.ok(settledIndex > 0, '应收到结算事件')

  const boards: number[] = []
  for (const message of a.messages.slice(0, settledIndex)) {
    if (message.type !== 'room.error' && 'state' in message) boards.push(message.state.board.length)
  }
  const grows = boards.filter((length, index) => index === 0 || length !== boards[index - 1])
  assert.deepEqual(
    grows.filter((length) => length > 0),
    [3, 4],
    `摊牌前应先看到 3 张、再看到 4 张，实际序列 ${grows.join(' → ')}`,
  )

  const settled = a.messages[settledIndex]!
  assert.ok(settled.type === 'hand.settled')
  assert.equal(settled.state.board.length, 5, '结算事件里才是完整 5 张')
  assert.ok(settled.result, '结算事件必须带结果')
  assert.equal(settled.result.showdown, true)

  // 中间态不得提前暴露结算叠层数据
  const earlyResult = a.messages
    .slice(0, settledIndex)
    .some((message) => message.type !== 'room.error' && 'state' in message && message.state.lastResult !== null)
  assert.equal(earlyResult, false, '逐张亮牌期间不应提前下发 lastResult')

  // 结算日志既不能提前出现，也不能丢：必须在结算事件之后进入聊天流
  const settleLogIndex = a.messages.findIndex(
    (message) => message.type === 'chat.message' && message.message.kind === 'system' && /结算/.test(message.message.text),
  )
  // 日志与结算是同一时刻发出的（日志紧邻在前），关键是它绝不能出现在亮牌过程中。
  assert.ok(
    settleLogIndex >= settledIndex - 1,
    `结算日志不应早于结算事件（日志下标 ${String(settleLogIndex)}，结算下标 ${String(settledIndex)}）`,
  )
  const lastRevealIndex = a.messages.reduce(
    (last, message, index) =>
      message.type !== 'room.error' && 'state' in message && message.state.board.length > 0 && message.state.board.length < 5
        ? index
        : last,
    -1,
  )
  assert.ok(settleLogIndex > lastRevealIndex, '结算日志必须等亮牌结束后才出现')
})

test('观战：座位满了仍可进来观战，观战者看不到他人底牌，也不能行动，空位后可入座', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲', maxSeats: 2 })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data
  // 第三个人：座位已满，应作为观战者加入而不是报错
  const watcher = await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '丙' })
  assert.equal(watcher.status, 201, '座位满时应允许以观战身份加入')
  assert.equal(watcher.data.nickname, '丙')

  const a = new TestClient(server.wsUrl)
  const b0 = new TestClient(server.wsUrl)
  const c = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b0.close()
    c.close()
  })
  await Promise.all([a.open(), b0.open(), c.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b0.send(joinCommand(guest))
  await b0.waitFor((message) => message.type === 'room.snapshot')
  c.send(joinCommand(watcher.data))
  await c.waitFor((message) => message.type === 'room.snapshot')

  assert.equal(c.lastSelf()!.seat, null, '观战者不应有座位')
  assert.deepEqual(c.lastSelf()!.holeCards, [], '观战者不应拿到任何底牌')
  // 甲还没落座：让甲先坐下，乙也坐下，然后再开手
  await takeSeat(a, 0)
  await takeSeat(b0, 1)

  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((message) => message.type === 'hand.started')
  await c.waitFor((message) => message.type === 'hand.started')

  // 观战者能看到公共状态，但看不到任何底牌，也没有合法动作
  const watcherState = c.lastState()!
  assert.equal(watcherState.seats.filter(Boolean).length, 2)
  assert.deepEqual(c.lastSelf()!.legalActions, [], '观战者不应有合法动作')
  const anyRevealed = watcherState.seats.some((seat) => seat && seat.revealedCards && seat.revealedCards.length > 0)
  assert.equal(anyRevealed, false, '未摊牌时观战者不得看到任何已公开底牌')

  // 乙「离座」只是保留座位：座位仍归乙，别人坐不进来
  b0.send({ type: 'seat.leave', requestId: rid() })
  await b0.waitFor(
    (message) =>
      message.type !== 'room.error' &&
      'state' in message &&
      message.state.seats[1] !== null &&
      message.state.seats[1]!.away,
  )
  c.send({ type: 'seat.take', requestId: rid(), seat: 1 })
  const rejected = await c.waitFor((message) => message.type === 'room.error')
  assert.ok(rejected.type === 'room.error')
  assert.equal(c.lastSelf()!.seat, null, '保留的座位不能被别人占')

  // 乙「坐回」自己的座位：筹码照旧，随时可以接着玩
  await takeSeat(b0, 1)
  assert.equal(b0.lastState()!.seats[1]!.away, false, '坐回后应恢复为在座')

  // 只有「退出房间」才真正释放座位：丙这时才能坐下
  b0.send({ type: 'room.leave', requestId: rid() })
  await delay(120)
  await takeSeat(c, 1)
  assert.equal(c.lastState()!.seats[1]!.playerId, watcher.data.playerId, '退出后释放的座位应能被观战者坐上')
  assert.equal(c.lastSelf()!.holeCards.length, 0, '本手已开始，入座者要等下一手才有底牌')
})

test('逐张亮牌期间被抢先开下一手：上一手结算不会丢', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲', maxSeats: 2 })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data
  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b.close()
  })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  // 新流程：加入后都是旁观者，要显式落座才能进牌局
  await takeSeat(a, 0)
  await takeSeat(b, 1)

  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((message) => message.type === 'hand.started')

  const clients = new Map([
    [host.playerId, a],
    [guest.playerId, b],
  ])
  let pushed = 0
  const deadline = Date.now() + 6000
  while (pushed < 2 && Date.now() < deadline) {
    const state = a.lastState()
    if (!state || state.phase === 'settlement') break
    const client = state.actingPlayerId ? clients.get(state.actingPlayerId) : undefined
    const self = client?.lastSelf()
    if (!client || !self?.legalActions.some((action) => action.action === 'all_in')) {
      await delay(20)
      continue
    }
    client.send({
      type: 'game.action',
      requestId: rid(),
      handId: state.handId!,
      expectedVersion: state.version,
      action: 'all_in',
    })
    pushed += 1
    await delay(50)
  }
  assert.equal(pushed, 2)

  // 逐张亮牌才开始（第一段 750ms 还没到）就抢先开下一手
  await delay(150)
  a.send({ type: 'game.start', requestId: rid() })

  const settled = await a.waitFor((message) => message.type === 'hand.settled' && Boolean(message.result), 4000)
  assert.ok(settled.type === 'hand.settled')
  assert.equal(settled.result?.board.length, 5, '补发的结算必须是完整 5 张公共牌')
  assert.ok(settled.result && settled.result.showdown, '应是一次摊牌结算')

  // 这一手本身已经完整广播（含结果）。注意双人桌全下后必有一方筹码归零，
  // 所以「下一手」会被服务端以「至少需要 2 名有筹码的玩家」正确拒绝——
  // 这里只断言结算不丢，不断言能立刻开下一手。
  const rejected = await a.waitFor((message) => message.type === 'room.error', 3000)
  assert.ok(rejected.type === 'room.error')
  assert.equal(rejected.error?.code, 'illegal_action')
})

test('聊天 @ 提醒：只认房间内真实昵称、排除自己；房间事件进入聊天日志且不占未读', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '阿德', maxSeats: 3 })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '小可' })).data

  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b.close()
  })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  // 新流程：加入后都是旁观者，要显式落座才能进牌局
  await takeSeat(a, 0)
  await takeSeat(b, 1)

  const userMessages = (client: TestClient): Extract<ServerMessage, { type: 'chat.message' }>[] =>
    client.messages.filter(
      (message): message is Extract<ServerMessage, { type: 'chat.message' }> =>
        message.type === 'chat.message' && message.message.kind === 'user',
    )

  // 1) @ 到对手：mentions 里应恰好是对手
  a.send({ type: 'chat.send', requestId: rid(), text: '@小可 这手你跟不跟' })
  const mentioned = await b.waitFor(
    (message) => message.type === 'chat.message' && message.message.mentions?.length === 1,
  )
  assert.ok(mentioned.type === 'chat.message')
  assert.deepEqual(mentioned.message.mentions, [guest.playerId], '@ 到自己人应被识别')

  // 2) @ 不存在的昵称：不得凭空产生提及
  a.send({ type: 'chat.send', requestId: rid(), text: '@查无此人 在吗' })
  await delay(150)
  const last = userMessages(b).at(-1)!
  assert.deepEqual(last.message.mentions, [], '不存在的昵称不应产生提及')

  // 3) @ 自己：不应把自己算进提及
  a.send({ type: 'chat.send', requestId: rid(), text: '@阿德 我自己' })
  await delay(150)
  assert.deepEqual(userMessages(b).at(-1)!.message.mentions, [], '不应把自己算作被提及')

  // 4) 房间事件进入聊天日志（开局/结算这类 system 消息），且不带 playerId
  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((message) => message.type === 'hand.started')
  // 房间里已经有过「XX 加入了房间」这类系统消息，这里等的是开局那条。
  const systemMessage = await a.waitFor(
    (message) =>
      message.type === 'chat.message' && message.message.kind === 'system' && /手牌开始/.test(message.message.text),
  )
  assert.ok(systemMessage.type === 'chat.message')
  assert.equal(systemMessage.message.playerId, '', '系统消息不属于任何玩家')
  assert.match(systemMessage.message.text, /手牌开始/, `系统消息内容应说明发生了什么，实际：${systemMessage.message.text}`)

  // 5) 重连时系统消息也在历史里（房间日志可回溯）
  b.close()
  await delay(120)
  const reconnect = new TestClient(server.wsUrl)
  t.after(() => reconnect.close())
  await reconnect.open()
  reconnect.send(joinCommand(guest))
  const snapshot = await reconnect.waitFor((message) => message.type === 'connection.recovered')
  assert.ok(snapshot.type === 'connection.recovered')
  const history = snapshot.chatHistory ?? []
  assert.ok(
    history.some((message) => message.kind === 'system' && /手牌开始/.test(message.text)),
    '重连后应能从历史里看到房间事件',
  )
  assert.ok(
    history.some((message) => message.kind === 'user' && message.mentions?.includes(guest.playerId)),
    '重连后 @ 提及信息也应保留',
  )
})

/* ───────────── 第 5/6 项需求：落座买入、离座保留座位、退出释放座位 ───────────── */

test('落座买入：买入额按房主上限/下限/步进收敛，离座保留座位，退出才释放', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)

  // 房主把初始筹码定成 200、买入上限定成 1000（步进 = 小盲 10）：
  // 这一组就是「区间两端都由房主设定」的常规用例。
  const host = (
    await postJson<RoomCredentials>(`${server.base}/api/rooms`, {
      nickname: '甲',
      minBuyIn: 200,
      buyInMax: 1000,
    })
  ).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data

  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b.close()
  })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  const snapshot = await a.waitFor((message) => message.type === 'room.snapshot')
  assert.ok(snapshot.type === 'room.snapshot')
  // 加入即旁观：没有座位，但能拿到本桌买入范围
  assert.equal(snapshot.self.seat, null, '加入后先是旁观者')
  assert.equal(snapshot.state.buyInMax, 1000, '房主自定义的买入上限应下发给客户端')
  assert.equal(snapshot.state.buyInMin, 200, '房主设定的初始筹码应下发给客户端')
  assert.equal(snapshot.state.maxSeats, 9, '产品固定 9 人桌（请求里的 maxSeats 只作兼容保留）')
  assert.equal(snapshot.state.buyInStep, 10, '买入步进 = 小盲')

  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')

  // 405 → 按步进（小盲 10）收到 410；5000 → 收到本桌上限 1000
  // （协议层还会挡掉超过 maxBuyInLimit=20000 的值，那是「请求格式不正确」而不是收敛）
  await takeSeat(a, 0, 405)
  assert.equal(a.lastState()!.seats[0]!.stack, 410, '买入额应按小盲步进取整')
  await takeSeat(b, 1, 5000)
  assert.equal(b.lastState()!.seats[1]!.stack, 1000, '高于本桌上限应收到上限')

  // 离座：座位与筹码保留，只有本人能坐回
  b.send({ type: 'seat.leave', requestId: rid() })
  const awayState = await b.waitFor(
    (message) =>
      message.type !== 'room.error' && 'state' in message && message.state.seats[1]?.away === true,
  )
  assert.ok(awayState.type !== 'room.error')
  const c = new TestClient(server.wsUrl)
  t.after(() => c.close())
  await c.open()
  const late = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '丙' })).data
  c.send(joinCommand(late))
  await c.waitFor((message) => message.type === 'room.snapshot')
  c.send({ type: 'seat.take', requestId: rid(), seat: 1, buyIn: 500 })
  const rejected = await c.waitFor((message) => message.type === 'room.error')
  assert.ok(rejected.type === 'room.error')
  assert.equal(rejected.error?.code, 'seat_taken', '保留的座位不能被别人占')

  // 本人坐回：筹码照旧（1000），买入额被忽略
  await takeSeat(b, 1, 500)
  assert.equal(b.lastState()!.seats[1]!.stack, 1000, '坐回保留座位时筹码照旧')

  /*
   * 第 4 项需求：离座玩家可以改坐**任意空位**，筹码跟人走（不用再买入）。
   * 原座位同时腾空，但筹码仍然属于玩家本人。
   */
  b.send({ type: 'seat.leave', requestId: rid() })
  await b.waitFor((message) => message.type !== 'room.error' && 'state' in message && message.state.seats[1]?.away === true)
  const stackBefore = b.lastState()!.seats[1]!.stack
  // 换到 5 号座位：不传 buyIn 也应当带上自己的筹码
  b.send({ type: 'seat.take', requestId: rid(), seat: 5 })
  await b.waitFor(
    (message) => message.type !== 'room.error' && 'state' in message && message.state.seats[5]?.playerId === guest.playerId,
  )
  const movedState = b.lastState()!
  assert.equal(movedState.seats[5]!.stack, stackBefore, '换座位后筹码原样带走')
  assert.equal(movedState.seats[5]!.away, false, '换座位后不再处于离座状态')
  assert.equal(movedState.seats[1], null, '原座位腾空释放')

  // 退出房间：真正释放座位，别人可以落座
  b.send({ type: 'room.leave', requestId: rid() })
  await delay(150)
  await takeSeat(c, 1, 5)
  assert.equal(c.lastState()!.seats[1]!.stack, 200, '低于下限应收到下限')
  assert.equal(c.lastState()!.seats[1]!.playerId, late.playerId)
})

test('筹码归零后可在原座位重新买入，但手牌未结束时不能补筹码', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)
  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, {
    nickname: '甲', minBuyIn: 200, buyInMax: 1000,
  })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data
  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => { a.close(); b.close() })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0, 200)
  await takeSeat(b, 1, 200)

  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((message) => message.type === 'hand.started')
  a.send({ type: 'game.action', requestId: rid(), handId: a.lastState()!.handId!,
    expectedVersion: a.lastState()!.version, action: 'all_in' })
  await a.waitFor((message) => message.type !== 'room.error' && 'state' in message &&
    message.state.phase === 'preflop' && message.state.seats[0]?.stack === 0)
  const beforeError = a.messages.length
  a.send({ type: 'seat.take', requestId: rid(), seat: 0, buyIn: 500 })
  const early = await a.waitFor((message) => message.type === 'room.error', 5000, beforeError)
  assert.ok(early.type === 'room.error')
  assert.equal(early.error?.code, 'bad_request')
  assert.equal(server.rooms.get(host.roomId)!.table.seatOf(host.playerId)!.stack, 0)

  b.send({ type: 'game.action', requestId: rid(), handId: b.lastState()!.handId!,
    expectedVersion: b.lastState()!.version, action: 'call' })
  const settled = await a.waitFor((message) => message.type === 'hand.settled')
  assert.ok(settled.type === 'hand.settled')
  const bustedSeat = settled.state.seats[0]?.stack === 0 ? 0 : 1
  const busted = bustedSeat === 0 ? a : b
  await takeSeat(busted, bustedSeat, 505)
  assert.equal(busted.lastState()!.seats[bustedSeat]!.stack, 510, '重新买入仍按小盲步进取整')
  assert.equal(busted.lastState()!.seats[bustedSeat]!.away, false)
  assert.equal(server.rooms.get(host.roomId)!.table.canStartHand(), true)

  const beforeDuplicate = busted.messages.length
  busted.send({ type: 'seat.take', requestId: rid(), seat: bustedSeat, buyIn: 500 })
  const duplicate = await busted.waitFor((message) => message.type === 'room.error', 5000, beforeDuplicate)
  assert.ok(duplicate.type === 'room.error')
  assert.equal(duplicate.error?.code, 'bad_request', '有筹码时不能重复买入')
})

test('离座/退出发生在手牌中：先自动弃牌并结算，筹码留在池里，退出等本手结束才移除', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲', maxSeats: 2 })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data
  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b.close()
  })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0)
  await takeSeat(b, 1)
  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((message) => message.type === 'hand.started')

  // 乙在本手里离座：必须自动弃牌并让本手立刻结算（否则牌局会卡住）
  b.send({ type: 'seat.leave', requestId: rid() })
  const settled = await a.waitFor((message) => message.type === 'hand.settled')
  assert.ok(settled.type === 'hand.settled')
  assert.equal(settled.result?.showdown, false, '弃牌结束本手不应进入摊牌')
  assert.equal(b.lastState()!.seats[1]!.away, true, '离座后座位仍为乙保留')
  assert.ok((b.lastState()!.seats[1]!.stack ?? 0) > 0, '离座不没收筹码')

  // 乙退出房间：本手已结束，座位立刻释放
  b.send({ type: 'room.leave', requestId: rid() })
  await delay(150)
  assert.equal(a.lastState()!.seats[1], null, '退出房间后座位应被释放')
})

test('掉线超过宽限期自动释放座位；宽限期内重连则保留', async (t) => {
  const server = await startTestServer({ seatReleaseMs: 200 })
  t.after(server.stop)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲', maxSeats: 3 })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data
  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0)
  await takeSeat(b, 1)

  // 乙掉线：超过 200ms 的宽限期后座位被释放
  b.close()
  const released = await a.waitFor(
    (message) => message.type === 'room.player_left' && message.state.seats[1] === null,
    5000,
  )
  assert.ok(released.type === 'room.player_left')

  // 乙重新连上并再次落座（座位刚被释放，所以这次是全新的座位与买入）
  const b2 = new TestClient(server.wsUrl)
  t.after(() => b2.close())
  await b2.open()
  b2.send(joinCommand(guest))
  await b2.waitFor((message) => message.type === 'connection.recovered')
  await takeSeat(b2, 1)

  // 这次在宽限期内重连：座位必须保留
  b2.close()
  await delay(60)
  const again = new TestClient(server.wsUrl)
  t.after(() => again.close())
  await again.open()
  again.send(joinCommand(guest))
  await again.waitFor((message) => message.type === 'connection.recovered')
  await delay(350)
  assert.equal(again.lastState()?.seats[1]?.playerId, guest.playerId, '宽限期内重连应保留座位')
  a.close()
})

/* ───────────── 主持人移除玩家（room.kick） ───────────── */

/**
 * 让当前行动者按「能过牌就过牌、否则弃牌」把这一手推到结束。
 * 用于「kick 掉一名玩家后牌局还得能正常打完」这类断言：
 * 我们关心的是座位释放时机，不是具体牌型。
 */
async function playHandToSettle(clients: Map<string, TestClient>, observer: TestClient, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = observer.lastState()
    if (!state || !state.handId || state.phase === 'settlement') return
    const client = state.actingPlayerId ? clients.get(state.actingPlayerId) : undefined
    const self = client?.lastSelf()
    if (!client || !self || self.legalActions.length === 0) {
      await delay(20)
      continue
    }
    const chosen =
      self.legalActions.find((action) => action.action === 'check') ?? self.legalActions.find((action) => action.action === 'fold')
    if (!chosen) return
    client.send({
      type: 'game.action',
      requestId: rid(),
      handId: state.handId,
      expectedVersion: state.version,
      action: chosen.action,
    })
    await delay(40)
  }
}

test('主持人移除玩家：非主持人被拒，被移除者收到 unauthorized，座位释放、其他人看到 player_left', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲', maxSeats: 3 })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data

  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b.close()
  })
  await Promise.all([a.open(), b.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0)
  await takeSeat(b, 1)

  // 1) 非主持人：即便目标是真实存在的玩家也必须被拒
  b.send({ type: 'room.kick', requestId: rid(), playerId: host.playerId })
  const notHost = await b.waitFor((message) => message.type === 'room.error')
  assert.ok(notHost.type === 'room.error')
  assert.equal(notHost.error?.code, 'not_host', '只有主持人可以移除玩家')
  assert.equal(a.lastState()!.seats[0]!.playerId, host.playerId, '被拒绝时不应改变任何状态')

  // 2) 主持人移除自己：引导去用「退出房间」
  a.send({ type: 'room.kick', requestId: rid(), playerId: host.playerId })
  const selfKick = await a.waitFor((message) => message.type === 'room.error')
  assert.ok(selfKick.type === 'room.error')
  assert.equal(selfKick.error?.code, 'bad_request')
  assert.match(selfKick.error?.message ?? '', /退出房间/, '提示里要指出正确的做法')

  // 3) 目标不在房间里：同样是 bad_request，而不是静默成功
  a.send({ type: 'room.kick', requestId: rid(), playerId: 'not-a-member' })
  const ghost = await a.waitFor((message) => message.type === 'room.error' && message.error?.code === 'bad_request')
  assert.ok(ghost.type === 'room.error')

  // 4) 正常移除：被移除者定向收到 unauthorized，其他人收到 player_left，座位释放
  const kickedFrom = b.messages.length
  a.send({ type: 'room.kick', requestId: rid(), playerId: guest.playerId })

  const kicked = await b.waitFor(
    (message) => message.type === 'room.error' && message.error?.code === 'unauthorized',
    5000,
    kickedFrom,
  )
  assert.ok(kicked.type === 'room.error')
  assert.match(kicked.error?.message ?? '', /移出房间/, '要说明这是被主持人移除，而不是凭证失效')

  const left = await a.waitFor(
    (message) =>
      message.type === 'room.player_left' &&
      message.state.seats[1] === null &&
      (message.notice ?? '').includes('移出房间'),
  )
  assert.ok(left.type === 'room.player_left')
  assert.match(left.notice ?? '', /乙 已被主持人移出房间/, '系统提示要写明是谁被移除')
  assert.equal(a.lastState()!.seats[1], null, '座位应立刻释放（没有手牌在跑）')

  // 系统日志同步进聊天流（房间日志可回溯）
  const log = await a.waitFor(
    (message) => message.type === 'chat.message' && message.message.kind === 'system' && /移出房间/.test(message.message.text),
  )
  assert.ok(log.type === 'chat.message')

  // 5) 被移除者已经不在房间里：按原凭证重连只会被拒绝
  const b2 = new TestClient(server.wsUrl)
  t.after(() => b2.close())
  await b2.open()
  b2.send(joinCommand(guest))
  const rejected = await b2.waitFor((message) => message.type === 'room.error')
  assert.ok(rejected.type === 'room.error')
  assert.equal(rejected.error?.code, 'unauthorized', '被移除后的凭证不能再进来')

  // 6) 释放出来的座位别人可以坐
  const late = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '丙' })).data
  const c = new TestClient(server.wsUrl)
  t.after(() => c.close())
  await c.open()
  c.send(joinCommand(late))
  await c.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(c, 1)
  assert.equal(c.lastState()!.seats[1]!.playerId, late.playerId, '释放的座位应能被新玩家坐上')
})

test('主持人移除玩家：手牌进行中先弃牌，座位等本手结算后才真正空出', async (t) => {
  const server = await startTestServer()
  t.after(server.stop)

  const host = (await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲', maxSeats: 3 })).data
  const guest = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '乙' })).data
  const third = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '丙' })).data

  const a = new TestClient(server.wsUrl)
  const b = new TestClient(server.wsUrl)
  const c = new TestClient(server.wsUrl)
  const d = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    b.close()
    c.close()
    d.close()
  })
  await Promise.all([a.open(), b.open(), c.open(), d.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  b.send(joinCommand(guest))
  await b.waitFor((message) => message.type === 'room.snapshot')
  c.send(joinCommand(third))
  await c.waitFor((message) => message.type === 'room.snapshot')
  await takeSeat(a, 0)
  await takeSeat(b, 1)
  await takeSeat(c, 2)

  // 丁旁观：专门用来验证「座位什么时候才真的能坐」
  const watcher = (await postJson<RoomCredentials>(`${server.base}/api/rooms/${host.roomId}/join`, { nickname: '丁' })).data
  d.send(joinCommand(watcher))
  await d.waitFor((message) => message.type === 'room.snapshot')

  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((message) => message.type === 'hand.started')
  await b.waitFor((message) => message.type === 'hand.started')
  await c.waitFor((message) => message.type === 'hand.started')

  // 本手进行中移除乙：他自动弃牌，但三家还剩两家在打，本手不会立刻结束。
  // 筹码还在池里，座位必须先挂起（等结算），否则筹码会凭空消失。
  a.send({ type: 'room.kick', requestId: rid(), playerId: guest.playerId })
  const held = await a.waitFor(
    (message) =>
      message.type !== 'room.error' &&
      'state' in message &&
      message.state.handId !== null &&
      message.state.seats[1]?.playerId === guest.playerId &&
      message.state.seats[1]?.away === true &&
      message.state.seats[1]?.folded === true,
  )
  // 用常量把类型收敛成 ServerEvent：断言函数不会改变 TS 对联合类型的收窄。
  assert.ok(held.type !== 'room.error' && held.type !== 'pong' && held.type !== 'chat.message')
  const heldSeat = held.state.seats[1]
  assert.equal(heldSeat?.playerId, guest.playerId, '本手没打完前座位还在他名下')
  assert.equal(heldSeat?.away, true, '被移除后应立刻标为离座（并自动弃牌）')
  assert.equal(held.state.phase, 'preflop', '三家还剩两家在打，本手不该被提前结束')

  // 这时候座位对新玩家来说仍然不可用
  d.send({ type: 'seat.take', requestId: rid(), seat: 1 })
  const occupied = await d.waitFor((message) => message.type === 'room.error')
  assert.ok(occupied.type === 'room.error')
  assert.equal(occupied.error?.code, 'seat_taken', '本手结算前座位不能易主')
  assert.equal(d.lastSelf()!.seat, null)

  // 剩下两人把这一手打完：结算时才真正移除座位
  const settleFrom = d.messages.length
  await playHandToSettle(
    new Map([
      [host.playerId, a],
      [third.playerId, c],
    ]),
    a,
  )
  const settled = await d.waitFor((message) => message.type === 'hand.settled', 6000, settleFrom)
  assert.ok(settled.type === 'hand.settled')
  assert.equal(settled.state.seats[1], null, '本手结算后座位才真正空出')

  // 被移除者的那条系统日志没有丢（它在本手结算前就发出了，属于房间日志的一部分）
  assert.ok(
    d.messages.some(
      (message) =>
        message.type === 'chat.message' &&
        message.message.kind === 'system' &&
        /乙 已被主持人移出房间/.test(message.message.text),
    ),
    '被移除的日志应进入聊天流',
  )

  // 座位空出来了，观战者可以坐下（本手已结束，下一手才参与）
  await takeSeat(d, 1)
  assert.equal(d.lastState()!.seats[1]!.playerId, watcher.playerId, '结算后座位应被释放给新玩家')
})
