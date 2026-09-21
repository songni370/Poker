import { randomUUID } from 'node:crypto'
import { EngineError, HoldemTable, cryptoRng, type TableSnapshot } from '../engine/index.ts'
import { TABLE_RULES, normalizeBuyIn, minBuyInFor } from '../shared/poker.ts'
import {
  CHAT_HISTORY_LIMIT,
  DEFAULT_MAX_ROOMS,
  ERROR_MESSAGES,
  HAND_HISTORY_LIMIT,
  type ChatMessage,
  type ChatSendCommand,
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

/** 全下后逐张亮公共牌的间隔（毫秒）。 */
const REVEAL_DELAY_MS = 750

/** 聊天限流：窗口内最多几条。 */
const CHAT_WINDOW_MS = 5000
const CHAT_WINDOW_LIMIT = 5

/** 掉线宽限期：成员掉线后超过这个时间仍没回来，就释放他占的座位（可用环境变量覆盖，测试用短值）。 */
const SEAT_RELEASE_MS = Number(process.env.SEAT_RELEASE_MS ?? 5 * 60 * 1000)

/** 房间快照结构版本；改动结构时必须同步提升，旧快照会被安全丢弃。 */
export const SNAPSHOT_VERSION = 1

/**
 * 房间的可恢复快照（第 4 阶段）：一房一行，含引擎私有状态（牌堆/底牌）。
 * 只写服务端 SQLite，绝不整体下发客户端。
 */
export interface RoomSnapshot {
  schemaVersion: number
  roomId: string
  name: string
  hostPlayerId: string
  maxSeats: number
  smallBlind: number
  bigBlind: number
  startingStack: number
  /** 房主自定义的买入上限（老快照没有该字段时回落到 startingStack）。 */
  buyInMax: number
  turnSeconds: number
  status: RoomStatus
  version: number
  turnDeadlineAt: number | null
  persistedHandId: string | null
  members: {
    playerId: string
    nickname: string
    seat: number | null
    ready: boolean
    isHost: boolean
    reconnectHash: string
  }[]
  table: TableSnapshot
  savedAt: number
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
  buyInMax?: number
}

/** 单个房间的运行时：内存权威状态 + 每房串行命令队列 + 行动计时器。 */
export class RoomRuntime {
  readonly id: string
  readonly name: string
  /** 主持人可以移交：原主持人退出房间时交给下一位成员。 */
  hostPlayerId: string
  readonly maxSeats: number
  readonly smallBlind: number
  readonly bigBlind: number
  readonly startingStack: number
  readonly turnSeconds: number
  /** 房主自定义的买入上限；买入下限 = 10 个大盲，步进 = 小盲。 */
  readonly buyInMax: number
  table: HoldemTable
  readonly members = new Map<string, RoomMember>()
  readonly createdAt = Date.now()

  status: RoomStatus = 'waiting'
  version = 0
  turnDeadlineAt: number | null = null
  turnTimer: NodeJS.Timeout | null = null
  /** 已写入 SQLite 的手牌号，保证结算记录幂等。 */
  persistedHandId: string | null = null
  /** 最近聊天（内存环形缓冲，不落库、不记录历史聊天内容）。 */
  readonly chat: ChatMessage[] = []
  /** 本房最近的手牌结算，进入房间时下发给客户端。 */
  readonly history: HandResultPublic[] = []
  /** 逐张亮牌的待执行定时器，开下一手或关房时必须清掉。 */
  readonly revealTimers: NodeJS.Timeout[] = []
  /** 已结算但还没广播出去的结算（逐张亮牌期间暂存），保证结果绝不丢失。 */
  pendingSettlement: { result: HandResultPublic; notice?: string } | null = null
  /** 聊天限流用的时间戳。 */
  readonly chatRate = new Map<string, number[]>()
  /** 掉线宽限定时器：超时后释放该成员的座位（键为 playerId）。 */
  readonly seatReleaseTimers = new Map<string, NodeJS.Timeout>()

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
    this.buyInMax = init.buyInMax ?? init.startingStack
    this.table = new HoldemTable({
      smallBlind: init.smallBlind,
      bigBlind: init.bigBlind,
      startingStack: init.startingStack,
      maxSeats: init.maxSeats,
    })
  }

  /** 导出可恢复快照（含引擎私有状态）。 */
  serialize(): RoomSnapshot {
    return {
      schemaVersion: SNAPSHOT_VERSION,
      roomId: this.id,
      name: this.name,
      hostPlayerId: this.hostPlayerId,
      maxSeats: this.maxSeats,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      startingStack: this.startingStack,
      buyInMax: this.buyInMax,
      turnSeconds: this.turnSeconds,
      status: this.status,
      version: this.version,
      turnDeadlineAt: this.turnDeadlineAt,
      persistedHandId: this.persistedHandId,
      members: [...this.members.values()].map((member) => ({
        playerId: member.playerId,
        nickname: member.nickname,
        seat: member.seat,
        ready: member.ready,
        isHost: member.isHost,
        reconnectHash: member.reconnectHash,
      })),
      table: this.table.serialize(),
      savedAt: Date.now(),
    }
  }

  /** 从快照重建运行时；结构损坏会抛错，由调用方决定是否放弃该房间。 */
  static fromSnapshot(snapshot: RoomSnapshot): RoomRuntime {
    if (!snapshot || snapshot.schemaVersion !== SNAPSHOT_VERSION) {
      throw new Error(`房间快照版本不兼容：${String(snapshot?.schemaVersion)}`)
    }
    if (!Array.isArray(snapshot.members)) throw new Error('房间快照结构损坏')
    const room = new RoomRuntime({
      id: snapshot.roomId,
      name: snapshot.name,
      hostPlayerId: snapshot.hostPlayerId,
      maxSeats: snapshot.maxSeats,
      smallBlind: snapshot.smallBlind,
      bigBlind: snapshot.bigBlind,
      startingStack: snapshot.startingStack,
      buyInMax: snapshot.buyInMax ?? snapshot.startingStack,
      turnSeconds: snapshot.turnSeconds,
    })
    for (const entry of snapshot.members) {
      room.members.set(entry.playerId, {
        playerId: entry.playerId,
        nickname: entry.nickname,
        seat: entry.seat,
        ready: entry.ready,
        isHost: entry.isHost,
        reconnectHash: entry.reconnectHash,
        socket: null,
        // 重启后一律视为「曾断线」：客户端回来时走 connection.recovered，
        // 同时让闲置回收能按这个时间点计算。
        disconnectedAt: Date.now(),
      })
    }
    room.status = snapshot.status === 'closed' ? 'waiting' : snapshot.status
    room.version = snapshot.version
    room.turnDeadlineAt = snapshot.turnDeadlineAt
    room.persistedHandId = snapshot.persistedHandId
    room.table = HoldemTable.restore(snapshot.table)
    return room
  }

  pushChat(message: ChatMessage): void {
    this.chat.push(message)
    if (this.chat.length > CHAT_HISTORY_LIMIT) this.chat.shift()
  }

  /**
   * 追加一条系统消息（房间事件）。聊天面板因此同时是房间日志：
   * 换设备/刷新回来也能看到期间发生了什么。
   */
  pushSystem(text: string): ChatMessage {
    return this.#pushSystemInternal(text)
  }

  #pushSystemInternal(text: string): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      kind: 'system',
      playerId: '',
      nickname: '',
      text,
      at: Date.now(),
    }
    this.pushChat(message)
    return message
  }

  pushHistory(result: HandResultPublic): void {
    if (this.history.some((entry) => entry.handId === result.handId)) return
    this.history.push(result)
    if (this.history.length > HAND_HISTORY_LIMIT) this.history.shift()
  }

  clearRevealTimers(): void {
    for (const timer of this.revealTimers) clearTimeout(timer)
    this.revealTimers.length = 0
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
  private readonly maxRooms: number

  constructor(repo: Repo, maxRooms = Number(process.env.MAX_ROOMS ?? DEFAULT_MAX_ROOMS)) {
    this.repo = repo
    this.maxRooms = Number.isInteger(maxRooms) && maxRooms > 0 ? maxRooms : DEFAULT_MAX_ROOMS
    this.repo.pruneReceipts()
  }

  roomLimit(): number {
    return this.maxRooms
  }

  get(roomId: string): RoomRuntime | undefined {
    return this.rooms.get(roomId)
  }

  roomCount(): number {
    return this.rooms.size
  }

  /**
   * 启动恢复：从 room_snapshots 重建所有未关闭房间（含牌局与牌堆位置）。
   * 快照缺失或损坏的房间会被安全关闭并记录，绝不让半个状态对外服务。
   */
  restoreRooms(): { restored: number; discarded: number } {
    const rows = this.repo.loadSnapshots()
    const restoredIds = new Set<string>()
    let restored = 0
    let discarded = 0

    for (const row of rows) {
      try {
        const snapshot = JSON.parse(row.state_json) as RoomSnapshot ?? undefined
        const room = RoomRuntime.fromSnapshot(snapshot)
        for (const entry of this.repo.recentHandResults(room.id, HAND_HISTORY_LIMIT)) room.pushHistory(entry)
        this.rooms.set(room.id, room)
        restoredIds.add(room.id)
        restored += 1
        // 恢复后立刻按持久化的截止时间接管计时（过期则立即执行一次超时动作）。
        this.scheduleTurn(room, true)
      } catch (error) {
        discarded += 1
        console.error(`[room] 房间 ${row.room_id} 的快照不可用，已关闭：`, error instanceof Error ? error.message : error)
        this.repo.setRoomStatus(row.room_id, 'closed')
        this.repo.deleteSnapshot(row.room_id)
      }
    }

    // 没有快照的遗留房间（例如旧版本数据）同样关闭，避免留下打不开的「进行中」。
    for (const roomId of this.repo.openRoomIds()) {
      if (restoredIds.has(roomId)) continue
      this.repo.setRoomStatus(roomId, 'closed')
      discarded += 1
    }

    return { restored, discarded }
  }

  createRoom(input: { nickname: string; roomName?: string; maxSeats: number; buyInMax?: number }): RoomCredentials {
    if (this.rooms.size >= this.maxRooms) {
      throw new CommandError(
        'room_full',
        `服务器最多同时开放 ${String(this.maxRooms)} 桌，请等其中一桌结束或关闭后再开新桌`,
      )
    }
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
      buyInMax: normalizeBuyIn(
        input.buyInMax ?? TABLE_RULES.startingStack,
        TABLE_RULES.bigBlind,
        TABLE_RULES.maxBuyInLimit,
        TABLE_RULES.smallBlind,
      ),
      turnSeconds: TABLE_RULES.turnSeconds,
    })

    // 主持人不自动入座：建房后直接进牌桌，自己选座位并确认买入（与加入者一致）。
    const member: RoomMember = {
      playerId,
      nickname: input.nickname,
      seat: null,
      ready: false,
      isHost: true,
      reconnectHash: hashToken(token),
      socket: null,
      disconnectedAt: null,
    }
    room.members.set(playerId, member)

    this.repo.transaction(() => {
      this.repo.insertRoom({
        roomId,
        roomName: room.name,
        hostPlayerId: playerId,
        status: 'waiting',
        smallBlind: room.smallBlind,
        bigBlind: room.bigBlind,
        startingStack: room.startingStack,
        buyInMax: room.buyInMax,
        maxSeats: room.maxSeats,
        turnSeconds: room.turnSeconds,
      })
      this.repo.upsertPlayer(this.playerRecord(room, member))
      // 建房即落一份快照：否则「建了房但还没发过命令」的房间重启后无快照可恢复，只能被关闭。
      this.repo.saveSnapshot(roomId, room.version, JSON.stringify(room.serialize()))
    })

    this.rooms.set(roomId, room)
    return this.credentials(room, member, token)
  }

  joinRoom(roomId: string, nickname: string): RoomCredentials {
    const room = this.rooms.get(roomId)
    if (!room) throw new CommandError('room_not_found')
    if (room.status === 'closed') throw new CommandError('room_closed')

    // 加入后先以旁观者身份进桌（自己挑座位并确认买入）；观战位满了才拒绝。
    const observers = [...room.members.values()].filter((member) => member.seat === null).length
    if (observers >= room.maxSeats * 2) {
      throw new CommandError('room_full', '这个房间人太多了，请稍后再来')
    }

    const playerId = newPlayerId()
    const token = newReconnectToken()
    const member: RoomMember = {
      playerId,
      nickname,
      seat: null,
      ready: false,
      isHost: false,
      reconnectHash: hashToken(token),
      socket: null,
      disconnectedAt: null,
    }
    room.members.set(playerId, member)

    this.repo.transaction(() => {
      this.repo.upsertPlayer(this.playerRecord(room, member))
      this.repo.saveSnapshot(room.id, room.version, JSON.stringify(room.serialize()))
    })
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
    this.clearAwayTimer(room, playerId)

    void room.run(() => {
      this.sendSnapshot(room, member.playerId, reconnected ? 'connection.recovered' : 'room.snapshot')
      // 全员广播：新玩家加入与重连都必须让其他人立刻看到「连接状态」变化。
      const notice = reconnected ? `${member.nickname} 已重新连接` : `${member.nickname} 加入了房间`
      // 只有首次加入进聊天日志；重连不记，避免网络抖动把日志刷满。
      if (!reconnected) this.publishSystemChat(room, notice)
      this.bumpVersion(room)
      this.publish(room, reconnected ? 'connection.recovered' : 'room.player_joined', { notice })
    })
    return null
  }

  detach(roomId: string, playerId: string, socket: ClientSocket): void {
    const room = this.rooms.get(roomId)
    const member = room?.members.get(playerId)
    if (!room || !member || member.socket !== socket) return
    member.socket = null
    member.disconnectedAt = Date.now()
    // 掉线只影响展示；但座位不能无限期占着：宽限期到了就释放（见 scheduleSeatRelease）。
    if (member.seat !== null) this.scheduleSeatRelease(room, playerId)
    void room.run(() => {
      this.bumpVersion(room)
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
      room.clearRevealTimers()
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
      room.clearRevealTimers()
      for (const timer of room.seatReleaseTimers.values()) clearTimeout(timer)
      room.seatReleaseTimers.clear()
      room.status = 'closed'
      this.repo.setRoomStatus(roomId, 'closed')
      this.repo.deleteSnapshot(roomId)
      this.rooms.delete(roomId)
      closed += 1
    }
    return closed
  }

  /** 取消某成员的掉线释放定时器（重连或坐回时调用）。 */
  clearAwayTimer(room: RoomRuntime, playerId: string): void {
    const timer = room.seatReleaseTimers.get(playerId)
    if (timer) {
      clearTimeout(timer)
      room.seatReleaseTimers.delete(playerId)
    }
  }

  /**
   * 掉线宽限期：成员掉线后开始计时，超时仍未回来就释放他的座位（筹码也一并结算掉），
   * 成员身份保留为旁观，回来可以重新买入入座。在线离座（away）不受影响——
   * 那种情况座位一直保留，随时能坐回。
   */
  scheduleSeatRelease(room: RoomRuntime, playerId: string): void {
    this.clearAwayTimer(room, playerId)
    const timer = setTimeout(() => {
      room.seatReleaseTimers.delete(playerId)
      void room.run(() => {
        const member = room.members.get(playerId)
        if (!member || member.socket !== null || member.seat === null) return
        room.table.removePlayer(playerId)
        member.seat = null
        this.bumpVersion(room)
        this.persist(room)
        this.publish(room, 'room.player_left', {
          notice: `${member.nickname} 掉线超过宽限期，座位已释放`,
        })
      })
    }, SEAT_RELEASE_MS)
    timer.unref?.()
    room.seatReleaseTimers.set(playerId, timer)
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
    /** 全下摊牌时需要补发的中间公共牌张数（例如 0 → 3 → 4 → 5）。 */
    let revealSteps: number[] = []

    try {
      // 聊天不进游戏状态机：不改筹码、不推进版本号，也不落库（避免记录聊天内容）。
      if (command.type === 'chat.send') {
        this.handleChat(room, member, command)
        return
      }

      switch (command.type) {
        case 'seat.take': {
          const seated = room.table.seatOf(playerId)
          if (seated) {
            // 坐回自己保留的座位：筹码照旧（只有 0 筹码时才用新的买入额补充）。
            if (seated.seat !== command.seat) {
              throw new CommandError('bad_request', '你已经有一个保留的座位，先退出房间才能换座')
            }
          } else if (!room.table.isSeatAvailable(command.seat)) {
            throw new CommandError('seat_taken', '这个座位已经有人了')
          }
          const buyIn = normalizeBuyIn(
            command.buyIn ?? room.buyInMax,
            room.bigBlind,
            room.buyInMax,
            room.smallBlind,
          )
          room.table.sit(playerId, member.nickname, command.seat, seated && seated.stack > 0 ? seated.stack : buyIn)
          const wasAway = seated !== undefined
          member.seat = command.seat
          member.ready = true
          this.clearAwayTimer(room, playerId)
          notice = wasAway
            ? `${member.nickname} 回到了 ${command.seat + 1} 号位`
            : `${member.nickname} 买入 ${buyIn} 入座 ${command.seat + 1} 号位`
          eventType = 'room.player_joined'
          break
        }
        case 'seat.leave': {
          if (member.seat === null) throw new CommandError('bad_request', '你还没有入座')
          // 座位与筹码保留，只有本人能坐回；手牌进行中会先自动弃牌。
          room.table.leave(playerId)
          notice = `${member.nickname} 已离座（座位为你保留）`
          eventType = 'room.player_left'
          break
        }
        case 'room.leave': {
          if (member.seat !== null) room.table.removePlayer(playerId)
          room.members.delete(playerId)
          this.clearAwayTimer(room, playerId)
          // 主持人退出：把主持权交给还在房间里的下一位（否则没人能开局）。
          if (playerId === room.hostPlayerId) {
            const next = [...room.members.values()][0]
            if (next) {
              room.hostPlayerId = next.playerId
              next.isHost = true
            }
          }
          notice = `${member.nickname} 退出了房间`
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
          // 有人抢在逐张亮牌结束前开下一手：先把上一手的结算补发出去，结果不能丢。
          if (room.pendingSettlement) {
            const pending = room.pendingSettlement
            room.pendingSettlement = null
            room.clearRevealTimers()
            this.bumpVersion(room)
            this.publish(room, 'hand.settled', { notice: pending.notice, result: pending.result })
          }
          room.clearRevealTimers()
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
          const boardBefore = state.board.length
          room.table.act(playerId, command.action, command.amount)
          const settled = room.table.publicState().result
          if (settled && !room.table.isHandRunning()) {
            result = settled
            eventType = 'hand.settled'
            revealSteps = this.revealStepsFor(settled, boardBefore)
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

      // 房间事件（入座/离座/开局/结算…）同时进聊天流，聊天面板因此也是房间日志。
      // 全下逐张亮牌时结算消息延后到亮牌结束，避免「已结算」与还在亮牌同时出现。
      const deferNoticeToChat = Boolean(result) && revealSteps.length > 0
      if (notice && !deferNoticeToChat) this.publishSystemChat(room, notice)

      // 先推进版本号并定下本回合截止时间，再连同快照一起落库：
      // 这样快照里的 version / turnDeadlineAt 与随后广播的状态完全一致。
      this.bumpVersion(room)
      this.scheduleTurn(room)
      this.repo.transaction(() => {
        this.repo.saveReceipt(command.requestId, room.id, playerId, command.type, '{"ok":true}')
        this.writeState(room)
      })
      if (room.status === 'playing') this.repo.setRoomStatus(room.id, 'playing')
      if (result && revealSteps.length > 0) {
        // 全下后一次性发完 5 张太突兀：按翻牌 → 转牌 → 河牌逐段推送，最后再发结算。
        this.scheduleReveals(room, result, revealSteps, notice, true)
      } else {
        this.publish(room, eventType, { notice, result })
      }
    } catch (error) {
      const code = error instanceof CommandError ? error.code : error instanceof EngineError ? this.mapEngineError(error) : 'internal'
      if (code === 'internal') {
        // 记录真实原因，但对外只给通用错误，避免泄露内部细节。
        console.error('[room] 命令处理失败', { roomId: room.id, playerId, type: command.type, error })
      }
      this.sendError(room, playerId, code, error instanceof Error ? error.message : undefined)
    }
  }

  /**
   * 全下跑到摊牌时，公共牌是一次性发完的；这里算出需要补发的中间张数。
   * 只在真正摊牌（showdown）且牌面从较短直接跳到 5 张时才补发。
   */
  private revealStepsFor(result: HandResultPublic, boardBefore: number): number[] {
    if (!result.showdown || result.board.length !== 5) return []
    return [3, 4].filter((count) => count > boardBefore && count < 5)
  }

  /** 按固定间隔逐段亮牌，最后再发结算事件。开下一手或关房时会清掉未执行的定时器。 */
  private scheduleReveals(
    room: RoomRuntime,
    result: HandResultPublic,
    steps: number[],
    notice: string | undefined,
    logNoticeToChat = false,
  ): void {
    const stillSameHand = (): boolean =>
      !room.table.isHandRunning() && room.table.publicState().handId === result.handId

    room.pendingSettlement = { ...(notice === undefined ? {} : { notice }), result }

    steps.forEach((count, index) => {
      const timer = setTimeout(
        () => {
          void room.run(() => {
            if (!stillSameHand()) return
            const street: 'flop' | 'turn' = count === 3 ? 'flop' : 'turn'
            this.bumpVersion(room)
            // 只覆盖展示用的公共牌与阶段：引擎此刻已经结算，不会再接受任何动作，
            // 且不带 lastResult，避免结算叠层提前弹出。
            this.publish(
              room,
              'hand.state_changed',
              {},
              {
                ...this.publicState(room),
                board: result.board.slice(0, count),
                street,
                phase: street,
                lastResult: null,
                // 结算时投入已清零，这里补上最终底池，避免亮牌过程中显示「底池 0」。
                potTotal: result.potTotal,
                pots: [{ amount: result.potTotal, eligiblePlayerIds: [] }],
              },
            )
          })
        },
        REVEAL_DELAY_MS * (index + 1),
      )
      room.revealTimers.push(timer)
    })

    const finalTimer = setTimeout(
      () => {
        void room.run(() => {
          if (!stillSameHand()) return
          room.pendingSettlement = null
          // 结算事件与它的日志同时在最后一步发出：亮牌过程里不会提前说「已结算」。
          if (logNoticeToChat && notice) this.publishSystemChat(room, notice)
          this.bumpVersion(room)
          this.publish(room, 'hand.settled', { notice, result })
        })
      },
      REVEAL_DELAY_MS * (steps.length + 1),
    )
    room.revealTimers.push(finalTimer)
  }

  /** 聊天：长度与限流都在服务端裁定，文本按纯文本下发。 */
  private handleChat(room: RoomRuntime, member: RoomMember, command: ChatSendCommand): void {
    const now = Date.now()
    const recent = (room.chatRate.get(member.playerId) ?? []).filter((stamp) => now - stamp < CHAT_WINDOW_MS)
    if (recent.length >= CHAT_WINDOW_LIMIT) {
      throw new CommandError('rate_limited', '发言太快了，请稍后再试')
    }
    recent.push(now)
    room.chatRate.set(member.playerId, recent)

    const text = command.text.trim()
    const message: ChatMessage = {
      id: randomUUID(),
      kind: 'user',
      playerId: member.playerId,
      nickname: member.nickname,
      text,
      at: now,
      mentions: this.parseMentions(room, text, member.playerId),
    }
    room.pushChat(message)
    this.repo.saveReceipt(command.requestId, room.id, member.playerId, command.type, '{"ok":true}')
    this.publishChat(room, message)
  }

  /**
   * 解析 @ 提及：在文本里找 `@昵称`，只认房间里真实存在的成员（最长昵称优先），
   * 排除发言者自己。返回被提及的 playerId 列表。
   */
  private parseMentions(room: RoomRuntime, text: string, senderId: string): string[] {
    const candidates = [...room.members.values()]
      .filter((member) => member.playerId !== senderId)
      .map((member) => ({ id: member.playerId, nickname: member.nickname }))
      .sort((a, b) => b.nickname.length - a.nickname.length)
    const mentioned = new Set<string>()
    for (const candidate of candidates) {
      if (text.includes(`@${candidate.nickname}`)) mentioned.add(candidate.id)
    }
    return [...mentioned]
  }

  /** 广播一条系统消息（同时进入聊天历史）。 */
  private publishSystemChat(room: RoomRuntime, text: string): void {
    this.publishChat(room, room.pushSystem(text))
  }

  private publishChat(room: RoomRuntime, message: ChatMessage): void {
    // 轻量事件：不带 state/self，因此不会影响对局状态的时序（尤其是逐张亮牌）。
    const event = { type: 'chat.message', eventId: randomUUID(), serverTime: Date.now(), message }
    for (const member of room.members.values()) {
      if (!this.isConnected(member)) continue
      this.sendTo(member, event)
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

  /**
   * 武装/重置行动计时器。
   * keepPersistedDeadline=true 用于重启恢复：沿用快照里的截止时间，
   * 若它已经过期则 delay=0，超时动作会立即被判定执行（而不是重新给满 20 秒）。
   */
  private scheduleTurn(room: RoomRuntime, keepPersistedDeadline = false): void {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer)
      room.turnTimer = null
    }
    const state = room.table.publicState()
    if (!room.table.isHandRunning() || state.actingSeat === null) {
      room.turnDeadlineAt = null
      return
    }
    const now = Date.now()
    const deadline =
      keepPersistedDeadline && room.turnDeadlineAt !== null ? room.turnDeadlineAt : now + room.turnSeconds * 1000
    room.turnDeadlineAt = deadline
    room.turnTimer = setTimeout(
      () => {
        void room.run(() => this.onTurnTimeout(room))
      },
      Math.max(0, deadline - now),
    )
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
    const boardBefore = room.table.publicState().board.length
    room.table.act(member.playerId, chosen.action)
    const settled = room.table.publicState().result
    const justSettled = Boolean(settled && settled !== settledBefore)
    room.status = 'playing'
    const notice = `${member.nickname} 超时，系统自动${chosen.action === 'check' ? '过牌' : '弃牌'}`

    this.publishSystemChat(room, notice)
    this.bumpVersion(room)
    this.scheduleTurn(room)
    this.repo.transaction(() => this.writeState(room))
    const steps = justSettled && settled ? this.revealStepsFor(settled, boardBefore) : []
    if (justSettled && settled && steps.length > 0) {
      this.scheduleReveals(room, settled, steps, notice)
    } else {
      this.publish(room, justSettled ? 'hand.settled' : 'hand.state_changed', {
        notice,
        result: justSettled ? (settled ?? undefined) : undefined,
      })
    }
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

  /** 必须在事务内调用：玩家投影、手牌结算与可恢复快照一起落库。 */
  private writeState(room: RoomRuntime): void {
    for (const member of room.members.values()) this.repo.upsertPlayer(this.playerRecord(room, member))
    const result = room.table.publicState().result
    if (result && result.handId !== room.persistedHandId) {
      this.repo.saveHandResult(room.id, result)
      room.persistedHandId = result.handId
      room.pushHistory(result)
    }
    this.repo.saveSnapshot(room.id, room.version, JSON.stringify(room.serialize()))
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
      if (room.table.isSeatAvailable(seat)) return seat
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
        holeCardCount: engineSeat.inHand && !engineSeat.away ? 2 : 0,
        revealedCards: engineSeat.revealedCards,
        lastAction: engineSeat.lastAction,
        away: engineSeat.away,
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
      buyInMin: minBuyInFor(room.bigBlind),
      buyInMax: room.buyInMax,
      buyInStep: room.smallBlind,
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

  /** 推进房间版本号；必须在写入快照之前调用。 */
  private bumpVersion(room: RoomRuntime): void {
    room.version += 1
  }

  private sendTo(member: RoomMember, payload: unknown): void {
    if (member.socket && member.socket.readyState === 1) member.socket.send(JSON.stringify(payload))
  }

  private sendSnapshot(room: RoomRuntime, playerId: string, type: ServerEventType = 'room.snapshot'): void {
    const member = room.members.get(playerId)
    if (!member) return
    this.sendTo(member, {
      ...this.envelope(room, type, { chatHistory: [...room.chat], handHistory: [...room.history] }),
      self: this.privateState(room, playerId),
    })
  }

  private sendError(room: RoomRuntime, playerId: string, code: ErrorCode, message?: string): void {
    const member = room.members.get(playerId)
    if (!member) return
    this.sendTo(member, {
      ...this.envelope(room, 'room.error', { error: { code, message: message ?? ERROR_MESSAGES[code] } }),
      self: this.privateState(room, playerId),
    })
  }

  /**
   * 状态推送：所有在线成员各自收到「公共状态 + 本人私有状态」。
   * 版本号由调用方在写快照之前推进（见 bumpVersion），这样落库的版本与广播的版本一致，
   * 重启恢复后客户端不会看到版本倒退。
   */
  private publish(
    room: RoomRuntime,
    type: ServerEventType,
    extra: Partial<ServerEvent> = {},
    stateOverride?: GameStatePublic,
  ): void {
    const base = this.envelope(room, type, extra)
    if (stateOverride) base.state = stateOverride
    for (const member of room.members.values()) {
      if (!this.isConnected(member)) continue
      this.sendTo(member, { ...base, self: this.privateState(room, member.playerId) })
    }
  }
}
