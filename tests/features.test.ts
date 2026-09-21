import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_MAX_LENGTH } from '../src/shared/protocol.ts'
import type { ChatMessage, RoomCredentials, ServerMessage } from '../src/shared/protocol.ts'
import { TestClient, delay, joinCommand, postJson, rid, startTestServer } from './helpers.ts'

test('房间上限：服务器最多同时开放 3 桌，关闭一桌后可以再开', async (t) => {
  const server = await startTestServer({ maxRooms: 3 })
  t.after(server.stop)

  const created: RoomCredentials[] = []
  for (let index = 0; index < 3; index++) {
    const response = await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: `房主${String(index)}` })
    assert.equal(response.status, 201, `第 ${String(index + 1)} 桌应创建成功`)
    created.push(response.data)
  }

  const fourth = await postJson<{ error: string; message: string }>(`${server.base}/api/rooms`, { nickname: '第四桌' })
  assert.equal(fourth.status, 409, '第 4 桌应被拒绝')
  assert.equal(fourth.data.error, 'room_full')
  assert.match(fourth.data.message, /3 桌/, '提示里要说清上限是 3 桌')

  const health = (await (await fetch(`${server.base}/api/health`)).json()) as { rooms: number; maxRooms: number }
  assert.equal(health.rooms, 3)
  assert.equal(health.maxRooms, 3)

  // 回收一桌（全员离线且到达阈值）后应能再开
  assert.equal(server.rooms.sweepIdleRooms(0), 3, '三桌都无人在线，应可全部回收')
  const afterSweep = await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '新桌主' })
  assert.equal(afterSweep.status, 201, '回收后应能重新开桌')
  assert.ok(created.length === 3)
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

  const versionBefore = a.lastState()!.version
  a.send({ type: 'chat.send', requestId: rid(), text: '  大家好，开局吧  ' })
  const receivedByB = await b.waitFor((message) => message.type === 'chat.message')
  assert.ok(receivedByB.type === 'chat.message')
  assert.equal(receivedByB.chat?.text, '大家好，开局吧', '首尾空白应被去掉')
  assert.equal(receivedByB.chat?.nickname, '甲')

  // 聊天不是牌局状态：不得推进版本号，否则会误伤别人正在提交的动作
  assert.equal(a.lastState()!.version, versionBefore, '聊天不应推进房间版本号')

  // 另一位玩家发言，房主也能收到
  b.send({ type: 'chat.send', requestId: rid(), text: '来' })
  const receivedByA = await a.waitFor((message) => message.type === 'chat.message' && message.chat?.nickname === '乙')
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
  const c = new TestClient(server.wsUrl)
  t.after(() => {
    a.close()
    c.close()
  })
  await Promise.all([a.open(), c.open()])
  a.send(joinCommand(host))
  await a.waitFor((message) => message.type === 'room.snapshot')
  c.send(joinCommand(watcher.data))
  await c.waitFor((message) => message.type === 'room.snapshot')

  assert.equal(c.lastSelf()!.seat, null, '观战者不应有座位')
  assert.deepEqual(c.lastSelf()!.holeCards, [], '观战者不应拿到任何底牌')

  a.send({ type: 'game.start', requestId: rid() })
  await a.waitFor((message) => message.type === 'hand.started')
  await c.waitFor((message) => message.type === 'hand.started')

  // 观战者能看到公共状态，但看不到任何底牌，也没有合法动作
  const watcherState = c.lastState()!
  assert.equal(watcherState.seats.filter(Boolean).length, 2)
  assert.deepEqual(c.lastSelf()!.legalActions, [], '观战者不应有合法动作')
  const anyRevealed = watcherState.seats.some((seat) => seat && seat.revealedCards && seat.revealedCards.length > 0)
  assert.equal(anyRevealed, false, '未摊牌时观战者不得看到任何已公开底牌')

  // 有人离座后，观战者可以入座
  const guest2 = guest // 乙离座
  const b = new TestClient(server.wsUrl)
  t.after(() => b.close())
  await b.open()
  b.send(joinCommand(guest2))
  await b.waitFor((message) => message.type === 'room.snapshot')
  b.send({ type: 'seat.leave', requestId: rid() })
  await delay(120)

  c.send({ type: 'seat.take', requestId: rid(), seat: 1 })
  const seated = await c.waitFor((message: ServerMessage) => {
    if (message.type === 'room.error' || !('self' in message)) return false
    return message.self.seat === 1
  })
  assert.ok(seated.type !== 'room.error' && 'self' in seated)
  assert.equal(seated.self.seat, 1, '空出的座位应能被观战者坐上')
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
