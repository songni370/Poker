import { randomUUID } from 'node:crypto'
import { EngineError, HoldemTable, cryptoRng } from '../engine/index.ts'
import { TABLE_RULES } from '../shared/poker.ts'
import {
  ERROR_MESSAGES,
  type ClientCommand,
  type ErrorCode,
  type GameStatePublic,
  type HandResultPublic,
  type LegalAction,
  type PrivateSelfState,
  type RoomCredentials,
  type RoomStatus,
  type SeatPublic,
  type ServerEvent,
  type ServerEventType,
} from '../shared/protocol.ts'
import { hashToken, newPlayerId, newRoomId, newReconnectToken, tokenMatches, type Repo } from './repo.ts'

/** 命令校验失败：只回给发起者，不改变牌局状态。 */
export class CommandError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code])
    this.name = 'CommandError'
    this.code = code
  }
}

export interface RoomMember {
  playerId: string
  nickname: string
  seat: number | null
  ready: boolean
  isHost: boolean
  reconnectHash: string
  socket: ClientSocket | null
  disconnectedAt: number | null
}

/** 只依赖 WebSocket 的最小结构，避免为一个类型引入额外依赖。 */
export interface ClientSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface RoomInit {
  id: string
  name: string
  hostPlayerId: string
  maxSeats: number
  smallBlind: number
  bigBlind: number
  startingStack: number
  turnSeconds: number
}

/** 单个房间的运行时：内存权威状态 + 每房串行命令队列 + 行动计时器。 */
export class RoomRuntime {
  readonly id: string
  readonly name: string
  readonly hostPlayerId: string
  readonly maxSeats: number
  readonly smallBlind: number
  readonly bigBlind: number
  readonly startingStack: number
  readonly turnSeconds: number
  readonly table: HoldemTable
  readonly members = new Map<string, RoomMember>()
  readonly createdAt = Date.now()

  status: RoomStatus = 'waiting'
  version = 0
  turnDeadlineAt: number | null = null
  turnTimer: NodeJS.Timeout | null = null
  /** 已写入 SQLite 的手牌号，保证结算记录幂等。 */
  persistedHandId: string | null = null

  private queue: Promise<unknown> = Promise.resolve()

  constructor(init: RoomInit) {
    this.id = init.id
    this.name = init.name
    this.hostPlayerId = init.hostPlayerId
    this.maxSeats = init.maxSeats
    this.smallBlind = init.smallBlind
    this.bigBlind = init.bigBlind
    this.startingStack = init.startingStack
    this.turnSeconds = init.turnSeconds
    this.table = new HoldemTable({
      smallBlind: init.smallBlind,
      bigBlind: init.bigBlind,
      startingStack: init.startingStack,
      maxSeats: init.maxSeats,
    })
  }

  /** 同一房间的所有命令、超时与状态发布都串行执行，避免并发交错。 */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  memberAtSeat(seat: number): RoomMember | undefined {
    for (const member of this.members.values()) {
      if (member.seat === seat) return member
    }
    return undefined
  }

  seatedCount(): number {
    let count = 0
    for (const member of this.members.values()) if (member.seat !== null) count += 1
    return count
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, RoomRuntime>()
  private readonly repo: Repo

  constructor(repo: Repo) {
    this.repo = repo
    this.repo.pruneReceipts()
  }

  get(roomId: string): RoomRuntime | undefined {
    return this.rooms.get(roomId)
  }

  roomCount(): number {
    return this.rooms.size
  }

  /** 进程重启后内存房间已丢失：明确关闭遗留房间，而不是留下一个打不开的「进行中」。 */
  closeStaleRooms(): number {
    const stale = this.repo.openRoomIds()
    for (const roomId of stale) this.repo.setRoomStatus(roomId, 'closed')
    return stale.length
  }

  createRoom(input: { nickname: string; roomName?: string; maxSeats: number }): RoomCredentials {
    const roomId = newRoomId()
    const playerId = newPlayerId()
    const token = newReconnectToken()
    const room = new RoomRuntime({
      id: roomId,
      name: input.roomName?.trim() || `${input.nickname} 的牌局`,
      hostPlayerId: playerId,
      maxSeats: input.maxSeats,
      smallBlind: TABLE_RULES.smallBlind,
      bigBlind: TABLE_RULES.bigBlind,
      startingStack: TABLE_RULES.startingStack,
      turnSeconds: TABLE_RULES.turnSeconds,
    })

    const member: RoomMember = {
      playerId,
      nickname: input.nickname,
      seat: 0,
      ready: false,
      isHost: true,
      reconnectHash: hashToken(token),
      socket: null,
      disconnectedAt: null,
    }
    room.members.set(playerId, member)
    room.table.sit(playerId, input.nickname, 0)

    this.repo.transaction(() => {
      this.repo.insertRoom({
        roomId,
        roomName: room.name,
        hostPlayerId: playerId,
        status: 'waiting',
        smallBlind: room.smallBlind,
        bigBlind: room.bigBlind,
        startingStack: room.startingStack,
        maxSeats: room.maxSeats,
        turnSeconds: room.turnSeconds,
      })
      this.repo.upsertPlayer(this.playerRecord(room, member))
    })

    this.rooms.set(roomId, room)
    return this.credentials(room, member, token)
  }

  joinRoom(roomId: string, nickname: string): RoomCredentials {
    const room = this.rooms.get(roomId)
    if (!room) throw new CommandError('room_not_found')
    if (room.status === 'closed') throw new CommandError('room_closed')
    if (room.seatedCount() >= room.maxSeats) throw new CommandError('room_full')
    if (room.members.size >= room.maxSeats * 2) throw new CommandError('room_full')

    const playerId = newPlayerId()
    const token = newReconnectToken()
    const seat = this.firstFreeSeat(room)
    const member: RoomMember = {
      playerId,
      nickname,
      seat,
      ready: false,
      isHost: false,
      reconnectHash: hashToken(token),
      socket: null,
      disconnectedAt: null,
    }
    room.members.set(playerId, member)
    if (seat !== null) room.table.sit(playerId, nickname, seat)

    this.repo.upsertPlayer(this.playerRecord(room, member))
    return this.credentials(room, member, token)
  }

  /** 凭证校验：房间、玩家与重连凭证三者必须同时匹配。 */
  authenticate(roomId: string, playerId: string, token: string): RoomMember | null {
    const room = this.rooms.get(roomId)
    const member = room?.members.get(playerId)
    if (!room || !member) return null
    // 房间已关闭后仍允许回桌读到最后状态是不必要的，直接拒绝。
    if (room.status === 'closed') return null
    return tokenMatches(token, member.reconnectHash) ? member : null
  }

  attach(roomId: string, playerId: string, token: string, socket: ClientSocket): ErrorCode | null {
    const room = this.rooms.get(roomId)
    const member = this.authenticate(roomId, playerId, token)
    if (!room || !member) return 'unauthorized'

    // 同一玩家只保留一个活动连接：新连接顶掉旧连接，避免双端同时操作。
    if (member.socket && member.socket !== socket && member.socket.readyState === 1) {
      member.socket.close(4001, 'replaced by new session')
    }
    // 只有「曾经断线过」才算重连；首次加入仍然走 room.snapshot。
    const reconnected = member.disconnectedAt !== null
    member.socket = socket
    member.disconnectedAt = null

    void room.run(() => {
      this.sendSnapshot(room, member.playerId, reconnected ? 'connection.recovered' : 'room.snapshot')
      // 全员广播：新玩家加入与重连都必须让其他人立刻看到「连接状态」变化。
      this.publish(room, reconnected ? 'connection.recovered' : 'room.player_joined', {
        notice: reconnected ? `${member.nickname} 已重新连接` : `${member.nickname} 加入了房间`,
      })
    })
    return null
  }

  detach(roomId: string, playerId: string, socket: ClientSocket): void {
    const room = this.rooms.get(roomId)
    const member = room?.members.get(playerId)
    if (!room || !member || member.socket !== socket) return
    member.socket = null
    member.disconnectedAt = Date.now()
    void room.run(() => {
      this.persist(room)
      this.publish(room, 'hand.state_changed', { notice: `${member.nickname} 断线（座位保留至本局结束）` })
    })
  }

  handleCommand(roomId: string, playerId: string, command: ClientCommand): Promise<void> {
    const room = this.rooms.get(roomId)
    if (!room) return Promise.resolve()
    return room.run(() => this.execute(room, playerId, command))
  }

  closeAll(): void {
    for (const room of this.rooms.values()) {
      if (room.turnTimer) clearTimeout(room.turnTimer)
      for (const member of room.members.values()) member.socket?.close(1001, 'server shutting down')
    }
  }

  /** 定期回收长期无人在线的房间：内存房间不能无限增长。 */
  startSweeper(intervalMs = 10 * 60 * 1000, idleMs = 30 * 60 * 1000): void {
    const timer = setInterval(() => {
      const closed = this.sweepIdleRooms(idleMs)
      if (closed > 0) console.info(`[room] 已回收 ${closed} 个长时间无人在线的房间`)
    }, intervalMs)
    timer.unref()
  }

  /** 关闭并移除「所有成员都离线且已超过 idleMs」的房间。返回回收数量。 */
  sweepIdleRooms(idleMs: number): number {
    const now = Date.now()
    let closed = 0
    for (const [roomId, room] of this.rooms) {
      let connected = 0
      let lastSeen = room.createdAt
      for (const member of room.members.values()) {
        if (member.socket) connected += 1
        else if (member.disconnectedAt !== null) lastSeen = Math.max(lastSeen, member.disconnectedAt)
      }
      if (connected > 0 || now - lastSeen < idleMs) continue
      if (room.turnTimer) clearTimeout(room.turnTimer)
      room.status = 'closed'
      this.repo.setRoomStatus(roomId, 'closed')
      this.rooms.delete(roomId)
      closed += 1
    }
    return closed
  }

  /* ───────────────────────── 命令执行 ───────────────────────── */

  private execute(room: RoomRuntime, playerId: string, command: ClientCommand): void {
    const member = room.members.get(playerId)
    if (!member) return
    if (command.type === 'heartbeat') {
      this.sendTo(member, { type: 'pong', eventId: randomUUID(), serverTime: Date.now() })
      return
    }

    // 幂等：同一 requestId 只生效一次，重放请求只补发当前快照。
    if (this.repo.hasReceipt(command.requestId)) {
      this.sendSnapshot(room, playerId)
      return
    }

    let eventType: ServerEventType = 'hand.state_changed'
    let notice: string | undefined
    let result: HandResultPublic | undefined

    try {
      switch (command.type) {
        case 'seat.take': {
          if (room.table.seatAt(command.seat)) throw new CommandError('seat_taken')
          if (member.seat === command.seat) throw new CommandError('bad_request', '你已经在这个座位上')
          if (member.seat !== null) room.table.leave(playerId)
          room.table.sit(playerId, member.nickname, command.seat)
          member.seat = command.seat
          notice = `${member.nickname} 入座 ${command.seat + 1} 号位`
          eventType = 'room.player_joined'
          break
        }
        case 'seat.leave': {
          if (member.seat === null) throw new CommandError('bad_request', '你还没有入座')
          room.table.leave(playerId)
          member.seat = null
          notice = `${member.nickname} 已离座`
          eventType = 'room.player_left'
          break
        }
        case 'room.ready': {
          member.ready = command.ready
          break
        }
        case 'game.start': {
          if (playerId !== room.hostPlayerId) throw new CommandError('not_host')
          if (room.table.isHandRunning()) throw new CommandError('illegal_action', '本手牌还在进行中')
          if (!room.table.canStartHand()) {
            throw new CommandError('illegal_action', '至少需要 2 名已入座且有筹码的玩家')
          }
          if (room.table.suggestButtonSeat() === undefined) throw new CommandError('illegal_action', '无法确定庄位')
          room.table.startHand({
            handId: randomUUID(),
            rng: cryptoRng(),
            buttonSeat: room.table.suggestButtonSeat(),
          })
          room.status = 'playing'
          room.persistedHandId = null
          notice = `第 ${room.table.publicState().handNo} 手牌开始`
          eventType = 'hand.started'
          break
        }
        case 'game.action': {
          const state = room.table.publicState()
          if (!state.handId || command.handId !== state.handId) {
            throw new CommandError('hand_finished', '本手牌已结束或已换手')
          }
          if (command.expectedVersion !== room.version) {
            this.sendSnapshot(room, playerId, 'room.snapshot')
            throw new CommandError('stale_version')
          }
          room.table.act(playerId, command.action, command.amount)
          const settled = room.table.publicState().result
          if (settled && !room.table.isHandRunning()) {
            result = settled
            eventType = 'hand.settled'
            const winners = settled.winners.map((winner) => {
              const winnerMember = room.members.get(winner.playerId)
              return `${winnerMember?.nickname ?? winner.playerId} +${winner.amount}${winner.handName ? `（${winner.handName}）` : ''}`
            })
            notice = `第 ${settled.handNo} 手结算：${winners.join('、')}`
          } else if (room.table.publicState().actingSeat !== null && state.actingSeat !== room.table.publicState().actingSeat) {
            eventType = 'turn.started'
          }
          break
        }
        default:
          throw new CommandError('bad_request')
      }

      this.repo.transaction(() => {
        this.repo.saveReceipt(command.requestId, room.id, playerId, command.type, '{"ok":true}')
        this.writeState(room)
      })
      if (room.status === 'playing') this.repo.setRoomStatus(room.id, 'playing')
      this.scheduleTurn(room)
      this.publish(room, eventType, { notice, result })
    } catch (error) {
      const code = error instanceof CommandError ? error.code : error instanceof EngineError ? this.mapEngineError(error) : 'internal'
      if (code === 'internal') {
        // 记录真实原因，但对外只给通用错误，避免泄露内部细节。
        console.error('[room] 命令处理失败', { roomId: room.id, playerId, type: command.type, error })
      }
      this.sendError(room, playerId, code, error instanceof Error ? error.message : undefined)
    }
  }

  private mapEngineError(error: EngineError): ErrorCode {
    switch (error.code) {
      case 'not_seated':
        return 'not_seated'
      case 'not_your_turn':
        return 'not_your_turn'
      case 'illegal_action':
        return 'illegal_action'
      case 'hand_finished':
        return 'hand_finished'
      default:
        return 'bad_request'
    }
  }

  /* ───────────────────────── 超时 ───────────────────────── */

  private scheduleTurn(room: RoomRuntime): void {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer)
      room.turnTimer = null
    }
    const state = room.table.publicState()
    if (!room.table.isHandRunning() || state.actingSeat === null) {
      room.turnDeadlineAt = null
      return
    }
    room.turnDeadlineAt = Date.now() + room.turnSeconds * 1000
    room.turnTimer = setTimeout(() => {
      void room.run(() => this.onTurnTimeout(room))
    }, room.turnSeconds * 1000)
  }

  /** 超时以服务端为准：无需跟注则自动过牌，否则自动弃牌；断线不暂停全桌。 */
  private onTurnTimeout(room: RoomRuntime): void {
    const state = room.table.publicState()
    if (!room.table.isHandRunning() || state.actingSeat === null) return
    const member = room.memberAtSeat(state.actingSeat)
    if (!member) return

    const legal = room.table.legalActions(member.playerId)
    const chosen = legal.find((action) => action.action === 'check') ?? legal.find((action) => action.action === 'fold')
    if (!chosen) return

    const settledBefore = room.table.publicState().result
    room.table.act(member.playerId, chosen.action)
    const settled = room.table.publicState().result
    room.status = 'playing'

    this.repo.transaction(() => this.writeState(room))
    this.scheduleTurn(room)
    this.publish(room, settled && settled !== settledBefore ? 'hand.settled' : 'hand.state_changed', {
      notice: `${member.nickname} 超时，系统自动${chosen.action === 'check' ? '过牌' : '弃牌'}`,
      result: settled && settled !== settledBefore ? settled : undefined,
    })
  }

  /* ───────────────────────── 持久化 ───────────────────────── */

  private playerRecord(room: RoomRuntime, member: RoomMember) {
    return {
      playerId: member.playerId,
      roomId: room.id,
      nickname: member.nickname,
      seat: member.seat,
      stack: room.table.seatOf(member.playerId)?.stack ?? room.startingStack,
      isHost: member.isHost,
      ready: member.ready,
      reconnectHash: member.reconnectHash,
    }
  }

  /** 必须在事务内调用。 */
  private writeState(room: RoomRuntime): void {
    for (const member of room.members.values()) this.repo.upsertPlayer(this.playerRecord(room, member))
    const result = room.table.publicState().result
    if (result && result.handId !== room.persistedHandId) {
      this.repo.saveHandResult(room.id, result)
      room.persistedHandId = result.handId
    }
  }

  private persist(room: RoomRuntime): void {
    this.repo.transaction(() => this.writeState(room))
  }

  /* ───────────────────────── 状态与广播 ───────────────────────── */

  private credentials(room: RoomRuntime, member: RoomMember, token: string): RoomCredentials {
    return {
      roomId: room.id,
      roomName: room.name,
      playerId: member.playerId,
      nickname: member.nickname,
      isHost: member.isHost,
      reconnectToken: token,
      maxSeats: room.maxSeats,
    }
  }

  private firstFreeSeat(room: RoomRuntime): number | null {
    for (let seat = 0; seat < room.maxSeats; seat++) {
      if (!room.table.seatAt(seat)) return seat
    }
    return null
  }

  private isConnected(member: RoomMember): boolean {
    return member.socket !== null && member.socket.readyState === 1
  }

  /** 公共状态：只包含所有人都能看到的信息，绝不携带他人底牌。 */
  private publicState(room: RoomRuntime): GameStatePublic {
    const table = room.table.publicState()
    const seats: (SeatPublic | null)[] = Array.from({ length: room.maxSeats }, () => null)

    for (const member of room.members.values()) {
      if (member.seat === null) continue
      const engineSeat = table.seats.find((entry) => entry.playerId === member.playerId)
      if (!engineSeat) continue
      seats[member.seat] = {
        playerId: member.playerId,
        seat: member.seat,
        nickname: member.nickname,
        stack: engineSeat.stack,
        committedStreet: engineSeat.committedStreet,
        committedHand: engineSeat.committedHand,
        folded: engineSeat.folded,
        allIn: engineSeat.allIn,
        connected: this.isConnected(member),
        inHand: engineSeat.inHand,
        isHost: member.isHost,
        ready: member.ready,
        isDealer: table.buttonSeat === member.seat,
        isSmallBlind: table.smallBlindSeat === member.seat,
        isBigBlind: table.bigBlindSeat === member.seat,
        holeCardCount: engineSeat.inHand ? 2 : 0,
        revealedCards: engineSeat.revealedCards,
        lastAction: engineSeat.lastAction,
      }
    }

    const actingSeat = table.actingSeat
    return {
      roomId: room.id,
      roomName: room.name,
      status: room.status,
      version: room.version,
      handId: table.handId,
      handNo: table.handNo,
      phase: table.phase,
      street: table.street,
      board: table.board,
      pots: table.pots,
      potTotal: table.potTotal,
      currentBet: table.currentBet,
      minRaise: table.minRaise,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      startingStack: room.startingStack,
      maxSeats: room.maxSeats,
      turnSeconds: room.turnSeconds,
      seats,
      buttonSeat: table.buttonSeat,
      actingPlayerId: actingSeat === null ? null : (room.memberAtSeat(actingSeat)?.playerId ?? null),
      turnDeadlineAt: room.turnDeadlineAt,
      lastResult: table.result,
    }
  }

  /** 私有状态：只含请求者本人的底牌与合法动作。 */
  private privateState(room: RoomRuntime, playerId: string): PrivateSelfState {
    const member = room.members.get(playerId)
    const seat = member?.seat ?? null
    const state = room.table.publicState()
    const holeCards = seat === null ? [] : room.table.holeCardsOf(playerId)
    const legalActions: LegalAction[] =
      seat !== null && state.actingSeat === seat ? room.table.legalActions(playerId) : []
    return { playerId, seat, holeCards, legalActions }
  }

  private envelope(room: RoomRuntime, type: ServerEventType, extra: Partial<ServerEvent>): Omit<ServerEvent, 'self'> {
    return {
      type,
      eventId: randomUUID(),
      roomId: room.id,
      handId: room.table.publicState().handId,
      version: room.version,
      serverTime: Date.now(),
      state: this.publicState(room),
      ...extra,
    }
  }

  private sendTo(member: RoomMember, payload: unknown): void {
    if (member.socket && member.socket.readyState === 1) member.socket.send(JSON.stringify(payload))
  }

  private sendSnapshot(room: RoomRuntime, playerId: string, type: ServerEventType = 'room.snapshot'): void {
    const member = room.members.get(playerId)
    if (!member) return
    this.sendTo(member, { ...this.envelope(room, type, {}), self: this.privateState(room, playerId) })
  }

  private sendError(room: RoomRuntime, playerId: string, code: ErrorCode, message?: string): void {
    const member = room.members.get(playerId)
    if (!member) return
    this.sendTo(member, {
      ...this.envelope(room, 'room.error', { error: { code, message: message ?? ERROR_MESSAGES[code] } }),
      self: this.privateState(room, playerId),
    })
  }

  /** 状态推送：版本号自增，所有在线成员各自收到「公共状态 + 本人私有状态」。 */
  private publish(room: RoomRuntime, type: ServerEventType, extra: Partial<ServerEvent> = {}): void {
    room.version += 1
    const base = this.envelope(room, type, extra)
    for (const member of room.members.values()) {
      if (!this.isConnected(member)) continue
      this.sendTo(member, { ...base, self: this.privateState(room, member.playerId) })
    }
  }
}
