import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_MAX_LENGTH } from '../src/shared/protocol.ts'
import type { ChatMessage, RoomCredentials, ServerMessage } from '../src/shared/protocol.ts'
import { TestClient, delay, joinCommand, postJson, rid, startTestServer, takeSeat } from './helpers.ts'

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

  // 房主把买入上限定成 1000（下限仍是 10 个大盲 = 200，步进 = 小盲 10）
  const host = (
    await postJson<RoomCredentials>(`${server.base}/api/rooms`, { nickname: '甲', maxSeats: 3, buyInMax: 1000 })
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
  assert.equal(snapshot.state.buyInMin, 200, '买入下限 = 10 个大盲')
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

  // 退出房间：真正释放座位，别人可以落座
  b.send({ type: 'room.leave', requestId: rid() })
  await delay(150)
  await takeSeat(c, 1, 5)
  assert.equal(c.lastState()!.seats[1]!.stack, 200, '低于下限应收到下限')
  assert.equal(c.lastState()!.seats[1]!.playerId, late.playerId)
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
