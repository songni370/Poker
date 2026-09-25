import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import type { RoomCredentials } from '../src/shared/protocol.ts'
import { connectRoom, disconnectRoom } from '../src/client/net/session.ts'

test('重复进入同一房间不会关闭正在建立的 WebSocket', (t) => {
  const originalSocket = globalThis.WebSocket
  const originalLocation = globalThis.location
  const sockets: FakeSocket[] = []
  class FakeSocket {
    static CONNECTING = 0
    static OPEN = 1
    readyState = FakeSocket.CONNECTING
    closed = false

    constructor() { sockets.push(this) }
    addEventListener(): void {}
    close(): void { this.closed = true }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', host: 'localhost:5173' } })
  t.after(() => {
    disconnectRoom()
    globalThis.WebSocket = originalSocket
    Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation })
  })
  setActivePinia(createPinia())

  const credentials: RoomCredentials = {
    roomId: '123456', roomName: '牌局', playerId: 'player-1', nickname: '玩家',
    isHost: true, reconnectToken: 'token', maxSeats: 9,
  }
  connectRoom(credentials)
  connectRoom(credentials)
  assert.equal(sockets.length, 1)
  assert.equal(sockets[0]!.closed, false)

  connectRoom({ ...credentials, playerId: 'player-2' })
  assert.equal(sockets.length, 2)
  assert.equal(sockets[0]!.closed, true)
})
