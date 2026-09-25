import { randomUUID } from 'node:crypto'
import { EngineError, HoldemTable, cryptoRng, type TableSnapshot } from '../engine/index.ts'
import { TABLE_RULES, normalizeBuyIn } from '../shared/poker.ts'
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
  type PlayerScorePublic,
  type RoomCredentials,
  type RoomMemberPublic,
  type RoomStatus,
  type SeatPublic,
  type ServerEvent,
  type ServerEventType,
} from '../shared/protocol.ts'
import {
  hashRoomPassword,
  hashToken,
  newPlayerId,
  newRoomId,
  newReconnectToken,
  roomPasswordMatches,
  tokenMatches,
  type Repo,
} from './repo.ts'
import { silentLogger, type Logger } from './logger.ts'

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
  /**
   * 已被主持人移除、但本手还没结算（筹码还在池里）。
   * 这类成员必须留到结算之后才能真正删除：公共状态的座位是按 room.members 渲染的，
   * 提前删掉会让那个座位在桌面上凭空消失。
   */
  pendingKickRemoval?: boolean
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
/**
 * 房间「没人操作」多久就关闭（第 2 项需求，默认 5 分钟，可用 `IDLE_ROOM_MS` 覆盖）。
 * 判定依据是「最后一次有人在牌桌上做事」的时间（RoomRuntime.lastActivityAt）：
 * 任何命令（心跳除外）、成员进出、开局都会刷新它。
 */
const IDLE_ROOM_MS = Number(process.env.IDLE_ROOM_MS ?? 5 * 60 * 1000)

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
  /** 服务端私有快照内只保存密码摘要；旧快照可能没有密码。 */
  passwordHash?: string | null
  hostPlayerId: string
  maxSeats: number
  smallBlind: number
  bigBlind: number
  startingStack: number
  /** 房主设定的买入上限（老快照没有该字段时回落到 startingStack）。 */
  buyInMax: number
  /** 房主设定的初始筹码 = 上桌最低买入（老快照没有该字段时回落到 2000 与买入上限的较小值）。 */
  minBuyIn: number
  turnSeconds: number
  nextHandSeconds?: number
  nextHandDeadlineAt?: number | null
  status: RoomStatus
  version: number
  turnDeadlineAt: number | null
  persistedHandId: string | null
  scores?: PlayerScorePublic[]
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
  passwordHash?: string | null
  hostPlayerId: string
  maxSeats: number
  smallBlind: number
  bigBlind: number
  startingStack: number
  turnSeconds: number
  nextHandSeconds?: number
  buyInMax?: number
  minBuyIn?: number
}

/** 单个房间的运行时：内存权威状态 + 每房串行命令队列 + 行动计时器。 */
export class RoomRuntime {
  readonly id: string
  readonly name: string
  readonly passwordHash: string | null
  /** 主持人可以移交：原主持人退出房间时交给下一位成员。 */
  hostPlayerId: string
  readonly maxSeats: number
  readonly smallBlind: number
  readonly bigBlind: number
  readonly startingStack: number
  /** 上桌最低买入（房主设定的初始筹码）。 */
  readonly minBuyIn: number
  turnSeconds: number
  nextHandSeconds: number
  /** 房主自定义的买入上限；买入下限 = 10 个大盲，步进 = 小盲。 */
  readonly buyInMax: number
  table: HoldemTable
  readonly members = new Map<string, RoomMember>()
  readonly createdAt = Date.now()
  /**
   * 最后一次「有人在牌桌上做事」的时间：任何命令（含心跳之外的玩家动作）、成员进出、
   * 以及每一手牌开始都会刷新它。回收器用它判断「5 分钟没有玩家操作」（第 2 项需求）。
   * 注意与 createdAt 的分工：createdAt 是房间寿命（用于「建了房但一直没人来」的兜底回收），
   * lastActivityAt 是活跃度。
   */
  lastActivityAt = Date.now()

  /** 记一次活跃（成员进出 / 命令 / 开局都算）。 */
  touch(): void {
    this.lastActivityAt = Date.now()
  }

  status: RoomStatus = 'waiting'
  version = 0
  turnDeadlineAt: number | null = null
  turnTimer: NodeJS.Timeout | null = null
  nextHandDeadlineAt: number | null = null
  nextHandTimer: NodeJS.Timeout | null = null
  /** 已写入 SQLite 的手牌号，保证结算记录幂等。 */
  persistedHandId: string | null = null
  /** 最近聊天（内存环形缓冲，不落库、不记录历史聊天内容）。 */
  readonly chat: ChatMessage[] = []
  /** 本房最近的手牌结算，进入房间时下发给客户端。 */
  readonly history: HandResultPublic[] = []
  /** 曾入座玩家的累计记录；离桌后仍留在本桌。 */
  readonly scores = new Map<string, PlayerScorePublic>()
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
    this.passwordHash = init.passwordHash ?? null
    this.hostPlayerId = init.hostPlayerId
    this.maxSeats = init.maxSeats
    this.smallBlind = init.smallBlind
    this.bigBlind = init.bigBlind
    this.startingStack = init.startingStack
    this.turnSeconds = init.turnSeconds
    this.nextHandSeconds = init.nextHandSeconds ?? TABLE_RULES.nextHandSeconds
    this.buyInMax = init.buyInMax ?? init.startingStack
    /*
     * 初始筹码（上桌最低买入）：
     *   - 显式传入就用传入值（创建房间时已经收敛过，不能再夹一次——否则「上限 1000、初始 200」
     *     会被夹成 1000，玩家只剩一种买入额可选，实测踩过）；
     *   - 缺失（老快照/老房间）才回落到「2000 与买入上限的较小值」。
     */
    this.minBuyIn = init.minBuyIn ?? Math.min(TABLE_RULES.startingStack, this.buyInMax)
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
      passwordHash: this.passwordHash,
      hostPlayerId: this.hostPlayerId,
      maxSeats: this.maxSeats,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      startingStack: this.startingStack,
      buyInMax: this.buyInMax,
      minBuyIn: this.minBuyIn,
      turnSeconds: this.turnSeconds,
      nextHandSeconds: this.nextHandSeconds,
      nextHandDeadlineAt: this.nextHandDeadlineAt,
      status: this.status,
      version: this.version,
      turnDeadlineAt: this.turnDeadlineAt,
      persistedHandId: this.persistedHandId,
      scores: [...this.scores.values()],
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
      passwordHash: snapshot.passwordHash ?? null,
      hostPlayerId: snapshot.hostPlayerId,
      maxSeats: snapshot.maxSeats,
      smallBlind: snapshot.smallBlind,
      bigBlind: snapshot.bigBlind,
      startingStack: snapshot.startingStack,
      buyInMax: snapshot.buyInMax ?? snapshot.startingStack,
      minBuyIn: snapshot.minBuyIn ?? TABLE_RULES.startingStack,
      turnSeconds: snapshot.turnSeconds,
      nextHandSeconds: snapshot.nextHandSeconds ?? TABLE_RULES.nextHandSeconds,
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
    room.nextHandDeadlineAt = snapshot.nextHandDeadlineAt ?? null
    room.persistedHandId = snapshot.persistedHandId
    for (const score of snapshot.scores ?? []) room.scores.set(score.playerId, score)
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
  /** 掉线宽限期（毫秒）：超时释放座位。做成实例参数，测试里可以用很短的值。 */
  private readonly seatReleaseMs: number
  /** 精简日志（见 logger.ts）：只记建房/开局结算/房间回收/错误；测试里传静默实现。 */
  private readonly logger: Logger
  /**
   * 已经打过结算日志的手牌 id（按房间）。
   * 结算事件可能走三条路径（主流程 / 全下逐张亮牌的收尾 / 开下一手时补发），
   * 没有这个去重就会出现同一手牌写两行日志的情况。
   */
  private readonly loggedSettlement = new Map<string, string>()

  constructor(
    repo: Repo,
    options: { maxRooms?: number; seatReleaseMs?: number; logger?: Logger } = {},
  ) {
    const maxRooms = options.maxRooms ?? Number(process.env.MAX_ROOMS ?? DEFAULT_MAX_ROOMS)
    this.repo = repo
    this.maxRooms = Number.isInteger(maxRooms) && maxRooms > 0 ? maxRooms : DEFAULT_MAX_ROOMS
    const release = options.seatReleaseMs ?? SEAT_RELEASE_MS
    this.seatReleaseMs = Number.isFinite(release) && release > 0 ? release : SEAT_RELEASE_MS
    this.logger = options.logger ?? silentLogger
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
        this.scheduleNextHand(room, true)
      } catch (error) {
        discarded += 1
        this.logger.warn(`房间 ${row.room_id} 的快照已损坏，已安全关闭该房间`, {
          roomId: row.room_id,
          detail: error instanceof Error ? error.message : error,
        })
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

  createRoom(input: {
    nickname: string
    password: string
    roomName?: string
    /** 已忽略：产品上固定 9 人桌（保留参数只为兼容旧客户端与测试）。 */
    maxSeats?: number
    /** 初始筹码 = 上桌最低买入（默认 2000）。 */
    minBuyIn?: number
    /** 买入上限（默认 5000）。 */
    buyInMax?: number
    smallBlind?: number
    bigBlind?: number
    turnSeconds?: number
    nextHandSeconds?: number
  }): RoomCredentials {
    if (this.rooms.size >= this.maxRooms) {
      throw new CommandError(
        'room_full',
        `服务器最多同时开放 ${String(this.maxRooms)} 桌，请等其中一桌结束或关闭后再开新桌`,
      )
    }
    const smallBlind = input.smallBlind ?? TABLE_RULES.smallBlind
    const bigBlind = input.bigBlind ?? TABLE_RULES.bigBlind
    if (
      !Number.isSafeInteger(smallBlind) || !Number.isSafeInteger(bigBlind) ||
      smallBlind < 1 || bigBlind <= smallBlind || bigBlind > TABLE_RULES.maxBigBlind
    ) {
      throw new CommandError('bad_request', `盲注须为正整数，且小盲低于大盲（大盲最多 ${TABLE_RULES.maxBigBlind}）`)
    }
    const turnSeconds = input.turnSeconds ?? TABLE_RULES.turnSeconds
    const nextHandSeconds = input.nextHandSeconds ?? TABLE_RULES.nextHandSeconds
    if (!Number.isSafeInteger(turnSeconds) || turnSeconds < TABLE_RULES.minTurnSeconds || turnSeconds > TABLE_RULES.maxTurnSeconds ||
      !Number.isSafeInteger(nextHandSeconds) || nextHandSeconds < 0 || nextHandSeconds > TABLE_RULES.maxNextHandSeconds) {
      throw new CommandError('bad_request', '行动时间或下一手间隔超出允许范围')
    }
    const buyInFloor = Math.max(TABLE_RULES.minBuyInFloor, 10 * bigBlind)
    const firstValidBuyIn = Math.ceil(buyInFloor / smallBlind) * smallBlind
    const requestedMax = input.buyInMax ?? Math.max(TABLE_RULES.maxBuyInDefault, firstValidBuyIn)
    if (requestedMax < buyInFloor) throw new CommandError('bad_request', `买入上限至少为 10 个大盲（${buyInFloor}）`)
    const requestedMin = input.minBuyIn ?? Math.min(Math.max(TABLE_RULES.startingStack, buyInFloor), requestedMax)
    if (requestedMin < buyInFloor || requestedMin > requestedMax) {
      throw new CommandError('bad_request', `最低买入须在 ${buyInFloor}–${requestedMax} 之间`)
    }
    const normalizedMax = Math.floor(requestedMax / smallBlind) * smallBlind
    const normalizedMin = Math.ceil(requestedMin / smallBlind) * smallBlind
    if (normalizedMax > TABLE_RULES.maxBuyInLimit || normalizedMin > normalizedMax || normalizedMax < firstValidBuyIn) {
      throw new CommandError('bad_request', '买入范围内须至少有一个符合小盲步进的金额')
    }
    // 房间号是纯数字：随机 6 位，撞上已有房间（含已关闭的历史房间）就重摇。
    const roomId = newRoomId((candidate) => this.repo.roomExists(candidate))
    const playerId = newPlayerId()
    const token = newReconnectToken()
    const room = new RoomRuntime({
      id: roomId,
      name: input.roomName?.trim() || `${input.nickname} 的牌局`,
      passwordHash: hashRoomPassword(input.password),
      hostPlayerId: playerId,
      // 固定 9 人桌：大厅不再让房主选座位数，服务端也只认这一个值。
      maxSeats: TABLE_RULES.maxSeats,
      smallBlind,
      bigBlind,
      startingStack: TABLE_RULES.startingStack,
      buyInMax: normalizedMax,
      // 房主输入的下限向上、上限向下对齐小盲，实际买入不会越过其设定的范围。
      minBuyIn: normalizedMin,
      turnSeconds,
      nextHandSeconds,
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
        minBuyIn: room.minBuyIn,
        maxSeats: room.maxSeats,
        turnSeconds: room.turnSeconds,
        nextHandSeconds: room.nextHandSeconds,
      })
      this.repo.upsertPlayer(this.playerRecord(room, member))
      // 建房即落一份快照：否则「建了房但还没发过命令」的房间重启后无快照可恢复，只能被关闭。
      this.repo.saveSnapshot(roomId, room.version, JSON.stringify(room.serialize()))
    })

    this.rooms.set(roomId, room)
    return this.credentials(room, member, token)
  }

  joinRoom(roomId: string, nickname: string, password: string): RoomCredentials {
    const room = this.rooms.get(roomId)
    if (!room) throw new CommandError('room_not_found')
    if (room.status === 'closed') throw new CommandError('room_closed')
    if (room.passwordHash && !roomPasswordMatches(password, room.passwordHash)) {
      throw new CommandError('bad_password')
    }
    // 有人加入也算活跃（第 2 项需求）。
    room.touch()

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
    // 连上来也算活跃（第 2 项需求）：否则「刚进桌、还没点任何按钮」会被误判成没人操作。
    room.touch()

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
    // 断线也刷新活跃时间：5 分钟从「最后一个人掉线」开始算，给重连留出完整窗口。
    room.touch()
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
      if (room.nextHandTimer) clearTimeout(room.nextHandTimer)
      room.clearRevealTimers()
      for (const member of room.members.values()) member.socket?.close(1001, 'server shutting down')
    }
    // 关服时给一行总结：这次运行一共开着几桌。
    if (this.rooms.size > 0) this.logger.info(`关闭 ${String(this.rooms.size)} 个仍在内存中的房间`)
  }

  /**
   * 定期回收房间（第 2 项需求）：内存房间不能无限增长，也不能留着空桌子。
   * 三个关闭条件（满足任一即关）：
   *   1. **所有人都退出了房间**（`members` 为空）→ 立即关闭；
   *   2. **没人落座、房间里也没有人**（例如大家只旁观就走了）→ 立即关闭；
   *   3. **没有任何在线连接**且超过 `idleMs`（默认 5 分钟）→ 关闭，也就是
   *      「最后一个人掉线 / 退出后 5 分钟没有任何玩家操作」；房间建立后一直没人连过
   *      也按这一条处理（`lastActivityAt` 初值即建房时间）。
   * 只要还有人在线就不动它——正在玩的桌子不能被回收器关掉；
   * 「房主刚建好房、还没落座」也不算条件 2，否则新房会被自己关掉（实测踩到）。
   */
  startSweeper(intervalMs = 60 * 1000, idleMs = IDLE_ROOM_MS): void {
    const timer = setInterval(() => {
      const closed = this.sweepIdleRooms(idleMs)
      if (closed > 0) {
        this.logger.info(
          `已关闭 ${String(closed)} 个房间（没人落座或超过 ${String(Math.round(idleMs / 60000))} 分钟没有玩家操作）`,
        )
      }
    }, intervalMs)
    timer.unref()
  }

  /**
   * 关闭并移除满足上面三条之一的房间。返回回收数量。
   * `idleMs = 0`：只要没人在线（或没人落座）就立刻回收——测试用。
   */
  sweepIdleRooms(idleMs: number = IDLE_ROOM_MS): number {
    const now = Date.now()
    let closed = 0
    for (const [roomId, room] of this.rooms) {
      let connected = 0
      for (const member of room.members.values()) {
        if (member.socket) connected += 1
      }
      const aliveFor = now - room.createdAt
      const idleFor = now - room.lastActivityAt
      const empty = room.members.size === 0
      const nobodySeated = room.table.presentSeatCount() === 0
      /*
       * 判定顺序里有两条容易踩的边界：
       *   · 「没人落座且没人在线」不能立刻生效 —— 房主刚建好房、WebSocket 还没连上的那一瞬间
       *     正是这个状态（实测：新建的房间被自己的回收器关掉，单测立刻报「未超过阈值不应回收」）；
       *   · 真没人连过的房也不能永远留着，所以给它 `idleMs` 的宽限期，之后再按「从没来过」处理。
       */
      const nobodySeatedAndGone = nobodySeated && (room.members.size === 0 || connected === 0) && (idleFor >= idleMs || aliveFor >= idleMs)
      const abandoned = connected === 0 && idleFor >= idleMs
      if (!empty && !nobodySeatedAndGone && !abandoned) continue
      if (room.turnTimer) clearTimeout(room.turnTimer)
      if (room.nextHandTimer) clearTimeout(room.nextHandTimer)
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
        this.freezeScore(room, playerId)
        room.table.removePlayer(playerId)
        member.seat = null
        this.bumpVersion(room)
        this.persist(room)
        this.publish(room, 'room.player_left', {
          notice: `${member.nickname} 掉线超过宽限期，座位已释放`,
        })
      })
    }, this.seatReleaseMs)
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

    // 任何真实命令都算一次「玩家操作」：房间因此重新获得 5 分钟寿命（第 2 项需求）。
    room.touch()

    // 幂等：同一 requestId 只生效一次，重放请求只补发当前快照。
    if (this.repo.hasReceipt(command.requestId)) {
      this.sendSnapshot(room, playerId)
      return
    }

    let eventType: ServerEventType = 'hand.state_changed'
    /** 本手是否在跑：用于在任何命令之后检测「本手刚刚结束」。
     *  离座 / 退出房间现在也会自动弃牌并可能直接结算本手，不能只靠 game.action 分支补结算。 */
    const handWasRunning = room.table.isHandRunning()
    const boardBeforeCommand = room.table.publicState().board.length
    let notice: string | undefined
    let result: HandResultPublic | undefined
    let newHostPlayerId: string | null = null
    /** 被主持人移除者的连接：等错误与广播都发完再关闭。 */
    let kickedSocket: ClientSocket | null | undefined
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
          const wasAway = seated?.away ?? false
          const needsBuyIn = !seated || seated.stack <= 0
          // 买入区间 = 房主设定的「初始筹码 ~ 买入上限」，缺省买入额取上限（一次带够）。
          const buyIn = normalizeBuyIn(
            command.buyIn ?? room.buyInMax,
            room.minBuyIn,
            room.buyInMax,
            room.smallBlind,
          )
          if (wasAway) {
            /*
             * 离座玩家换座位（第 4 项需求）：任意空位都能坐，筹码跟人走、不用再买入——
             * 原座位腾空，原筹码原样带到新座位（只有原筹码为 0 时才用本次买入额补充）。
             */
            const previousStack = room.table.reSit(playerId, member.nickname, command.seat, buyIn)
            if (previousStack <= 0) {
              // 输光了重新买入：仍受房主设定的买入区间约束。
              room.table.seatOf(playerId)!.stack = buyIn
            }
          } else if (seated) {
            if (seated.seat !== command.seat || seated.stack !== 0 || room.table.isHandRunning()) {
              throw new CommandError('bad_request', '只有本手结束后筹码归零的玩家可以在原座位重新买入')
            }
            room.table.sit(playerId, member.nickname, command.seat, buyIn)
          } else if (!room.table.isSeatAvailable(command.seat)) {
            throw new CommandError('seat_taken', '这个座位已经有人了')
          } else {
            room.table.sit(playerId, member.nickname, command.seat, buyIn)
          }
          member.seat = command.seat
          member.ready = true
          const score = room.scores.get(playerId) ?? {
            playerId, nickname: member.nickname, totalBuyIn: 0, buyInCount: 0,
            handsPlayed: 0, banked: 0, stack: 0, net: 0, seated: true,
          }
          if (needsBuyIn) {
            score.totalBuyIn += buyIn
            score.buyInCount += 1
          }
          score.seated = true
          room.scores.set(playerId, score)
          this.clearAwayTimer(room, playerId)
          notice = wasAway
            ? `${member.nickname} 回到 ${command.seat + 1} 号位（筹码 ${String(room.table.seatOf(playerId)?.stack ?? 0)} 原样带走）`
            : seated ? `${member.nickname} 重新买入 ${buyIn} 筹码` : `${member.nickname} 买入 ${buyIn} 入座 ${command.seat + 1} 号位`
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
          const previousHostSeat = member.seat
          this.freezeScore(room, playerId)
          if (member.seat !== null) room.table.removePlayer(playerId)
          room.members.delete(playerId)
          this.clearAwayTimer(room, playerId)
          // 房主退出后按座位顺序顺延；无人入座时才交给房间里的观战者。
          if (playerId === room.hostPlayerId) {
            const seated = [...room.members.values()]
              .filter((candidate) => candidate.seat !== null && !candidate.pendingKickRemoval)
              .sort((a, b) => {
                const distance = (seat: number) => previousHostSeat === null
                  ? seat
                  : (seat - previousHostSeat + room.maxSeats) % room.maxSeats
                return distance(a.seat!) - distance(b.seat!)
              })
            const next = seated.find((candidate) => !room.table.seatOf(candidate.playerId)?.away)
              ?? seated[0]
              ?? [...room.members.values()].find((candidate) => !candidate.pendingKickRemoval)
            if (next) {
              room.hostPlayerId = next.playerId
              next.isHost = true
              newHostPlayerId = next.playerId
            }
          }
          notice = `${member.nickname} 退出了房间`
          eventType = 'room.player_left'
          break
        }
        case 'room.members': {
          // 成员名单里有旁观者，不是牌局公共状态：只回给主持人，其他人按权限拒绝。
          if (playerId !== room.hostPlayerId) throw new CommandError('not_host')
          // 只读命令：不推进版本号，所以也没有可写的回执（否则重放时会漏发名单）。
          this.sendMembers(room, member)
          return
        }
        case 'room.configure': {
          if (playerId !== room.hostPlayerId) throw new CommandError('not_host')
          room.turnSeconds = command.turnSeconds
          room.nextHandSeconds = command.nextHandSeconds
          if (room.table.publicState().phase === 'settlement' && !room.pendingSettlement) this.scheduleNextHand(room)
          notice = `${member.nickname} 更新了思考时间和下一手等待时间`
          eventType = 'room.configured'
          break
        }
        case 'room.kick': {
          if (playerId !== room.hostPlayerId) throw new CommandError('not_host')
          if (command.playerId === playerId) {
            throw new CommandError('bad_request', '不能移除自己，想离开请用「退出房间」')
          }
          const target = room.members.get(command.playerId)
          if (!target) throw new CommandError('bad_request', '这名玩家已经不在房间里了')

          // 先留一份引用：成员记录下面就会被标记/删除，之后拿不到他的 socket。
          const targetSocket = target.socket
          targetSocket?.send(
            JSON.stringify({
              ...this.envelope(room, 'room.error', {
                error: { code: 'unauthorized', message: '你已被主持人移出房间' },
              }),
              self: this.privateState(room, target.playerId),
            }),
          )

          // 与「退出房间」同一套语义：手牌中先弃牌并挂 pendingRemoval，等本手结算再让出座位。
          this.freezeScore(room, command.playerId)
          if (target.seat !== null) room.table.removePlayer(command.playerId)
          // 手牌进行中时成员记录要留到结算之后：公共状态的座位是按 room.members 渲染的，
          // 提前删掉会让那个座位在桌面上凭空消失——筹码还在池里却看不见，别人还会以为能坐。
          // 注意别动 member.seat：它是座位的渲染依据，释放与否由引擎的 pendingRemoval 决定。
          if (room.table.seatOf(command.playerId)?.pendingRemoval) {
            target.pendingKickRemoval = true
          } else {
            room.members.delete(command.playerId)
          }
          this.clearAwayTimer(room, command.playerId)

          notice = `${target.nickname} 已被主持人移出房间`
          eventType = 'room.player_left'
          kickedSocket = targetSocket
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
          this.clearNextHand(room)
          room.table.startHand({
            handId: randomUUID(),
            rng: cryptoRng(),
            buttonSeat: room.table.suggestButtonSeat(),
          })
          for (const seat of room.table.publicState().seats) {
            if (seat.inHand) {
              const score = room.scores.get(seat.playerId)
              if (score) score.handsPlayed += 1
            }
          }
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
            notice = this.settlementNotice(room, settled)
          } else if (room.table.publicState().actingSeat !== null && state.actingSeat !== room.table.publicState().actingSeat) {
            eventType = 'turn.started'
          }
          break
        }
        default:
          throw new CommandError('bad_request')
      }

      // 任何命令都可能让本手结束（例如离座自动弃牌后只剩一人）：统一在这里补结算，
      // 否则客户端永远收不到 hand.settled，手牌记录也不会落库。
      if (!result && handWasRunning && !room.table.isHandRunning()) {
        const settled = room.table.publicState().result
        if (settled) {
          result = settled
          eventType = 'hand.settled'
          revealSteps = this.revealStepsFor(settled, boardBeforeCommand)
          notice = this.settlementNotice(room, settled)
        }
      }

      // 结算之后才真正移除被踢的成员（在此之前那个座位还挂在公共状态里）。
      if (result) this.bankDepartedWinnings(room, result)
      this.syncScores(room)
      this.dropPendingKicks(room)

      // 精简日志里最有价值的一条：这一手谁赢了、赢多少。
      // 放在这里而不是 publish 处：结算是引擎状态的事实，与「逐张亮牌是否还在跑」无关，
      // 断线/开下一手都不会漏记；按 handId 去重，也不会因为补发结算而重复写。
      if (result) this.logSettlement(room, result)

      // 房间事件（入座/离座/开局/结算…）同时进聊天流，聊天面板因此也是房间日志。
      // 全下逐张亮牌时结算消息延后到亮牌结束，避免「已结算」与还在亮牌同时出现。
      const deferNoticeToChat = Boolean(result) && revealSteps.length > 0
      if (notice && !deferNoticeToChat) this.publishSystemChat(room, notice)

      // 先推进版本号并定下本回合截止时间，再连同快照一起落库：
      // 这样快照里的 version / turnDeadlineAt 与随后广播的状态完全一致。
      this.bumpVersion(room)
      this.scheduleTurn(room, command.type === 'room.configure')
      if (result && revealSteps.length === 0) this.scheduleNextHand(room)
      if (command.type === 'seat.take' && room.nextHandDeadlineAt === null && !room.pendingSettlement &&
        room.table.publicState().phase === 'settlement' && room.table.canStartHand()) this.scheduleNextHand(room)
      this.repo.transaction(() => {
        this.repo.saveReceipt(command.requestId, room.id, playerId, command.type, '{"ok":true}')
        if (newHostPlayerId) this.repo.setRoomHost(room.id, newHostPlayerId)
        if (command.type === 'room.configure') this.repo.updateRoomConfig(room)
        this.writeState(room)
      })
      if (room.status === 'playing') this.repo.setRoomStatus(room.id, 'playing')
      if (result && revealSteps.length > 0) {
        // 全下后一次性发完 5 张太突兀：按翻牌 → 转牌 → 河牌逐段推送，最后再发结算。
        this.scheduleReveals(room, result, revealSteps, notice, true)
      } else {
        this.publish(room, eventType, { notice, result })
      }
      // 被移除者的 socket 放到最后关闭：先让他收到 unauthorized 与最后一次状态，
      // 否则客户端只看到「连接断开」，会一直重连到失败为止。
      kickedSocket?.close(4003, 'removed by host')
    } catch (error) {
      const code = error instanceof CommandError ? error.code : error instanceof EngineError ? this.mapEngineError(error) : 'internal'
      if (code === 'internal') {
        // 记录真实原因，但对外只给通用错误，避免泄露内部细节。
        this.logger.error('处理玩家动作失败', {
          roomId: room.id,
          playerId,
          command: command.type,
          detail: error,
        })
      }
      this.sendError(room, playerId, code, error instanceof Error ? error.message : undefined)
    }
  }

  /** 结算文案：第 N 手结算：昵称 +筹码（牌型）。 */
  private settlementNotice(room: RoomRuntime, settled: HandResultPublic): string {
    const winners = settled.winners.map((winner) => {
      const winnerMember = room.members.get(winner.playerId)
      const hand = winner.handName ? `（${winner.handName}）` : ''
      return `${winnerMember?.nickname ?? winner.playerId} +${winner.amount}${hand}`
    })
    return `第 ${settled.handNo} 手结算：${winners.join('、')}`
  }

  /**
   * 一手牌结束时写一行日志：`房间名 第 3 手结算：阿水 +120（两对（A 与 K）），底池 240`。
   * 同一手牌只写一次（handId 去重）：结算事件可能走主流程、逐张亮牌收尾、开下一手补发三条路径。
   */
  private logSettlement(room: RoomRuntime, settled: HandResultPublic): void {
    if (this.loggedSettlement.get(room.id) === settled.handId) return
    this.loggedSettlement.set(room.id, settled.handId)
    const winners = settled.winners.map((winner) => {
      const nickname = room.members.get(winner.playerId)?.nickname ?? winner.playerId
      const hand = winner.handName ? `（${winner.handName}）` : ''
      return `${nickname} +${String(winner.amount)}${hand}`
    })
    this.logger.info(
      `${room.name} 第 ${String(settled.handNo)} 手结算：${winners.join('、')}，底池 ${String(settled.potTotal)}`,
      { roomId: room.id, handNo: settled.handNo, potTotal: settled.potTotal },
    )
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
          this.scheduleNextHand(room)
          this.persist(room)
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

  private clearNextHand(room: RoomRuntime): void {
    if (room.nextHandTimer) clearTimeout(room.nextHandTimer)
    room.nextHandTimer = null
    room.nextHandDeadlineAt = null
  }

  /** 结算后自动开下一手；重启时沿用已保存的截止时间。0 秒表示手动开局。 */
  private scheduleNextHand(room: RoomRuntime, keepPersistedDeadline = false): void {
    const savedDeadline = room.nextHandDeadlineAt
    this.clearNextHand(room)
    if (room.nextHandSeconds === 0 || room.table.publicState().phase !== 'settlement') return
    const now = Date.now()
    const deadline = keepPersistedDeadline && savedDeadline !== null
      ? savedDeadline : now + room.nextHandSeconds * 1000
    room.nextHandDeadlineAt = deadline
    room.nextHandTimer = setTimeout(() => {
      void room.run(() => {
        if (this.rooms.get(room.id) !== room || room.nextHandDeadlineAt !== deadline || room.table.isHandRunning()) return
        if (!room.table.canStartHand()) {
          this.clearNextHand(room)
          this.bumpVersion(room)
          this.persist(room)
          this.publish(room, 'hand.state_changed')
          return
        }
        this.execute(room, room.hostPlayerId, { type: 'game.start', requestId: randomUUID() })
      })
    }, Math.max(0, deadline - now))
  }

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
    if (justSettled && settled) this.bankDepartedWinnings(room, settled)
    room.status = 'playing'
    const notice = `${member.nickname} 超时，系统自动${chosen.action === 'check' ? '过牌' : '弃牌'}`

    this.publishSystemChat(room, notice)
    this.bumpVersion(room)
    this.scheduleTurn(room)
    const steps = justSettled && settled ? this.revealStepsFor(settled, boardBefore) : []
    if (justSettled && steps.length === 0) this.scheduleNextHand(room)
    this.repo.transaction(() => this.writeState(room))
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
    this.syncScores(room)
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

  private freezeScore(room: RoomRuntime, playerId: string): void {
    const score = room.scores.get(playerId)
    if (!score) return
    score.banked += room.table.seatOf(playerId)?.stack ?? score.stack
    score.stack = 0
    score.net = score.banked - score.totalBuyIn
    score.seated = false
  }

  private bankDepartedWinnings(room: RoomRuntime, result: HandResultPublic): void {
    for (const winner of result.winners) {
      const score = room.scores.get(winner.playerId)
      const member = room.members.get(winner.playerId)
      if (score && (!member || member.pendingKickRemoval || member.seat === null)) {
        score.banked += winner.amount
      }
    }
  }

  private syncScores(room: RoomRuntime): void {
    for (const score of room.scores.values()) {
      const seat = room.table.seatOf(score.playerId)
      const member = room.members.get(score.playerId)
      score.seated = Boolean(member && !member.pendingKickRemoval && member.seat !== null && seat)
      if (score.seated && seat) score.stack = seat.stack
      score.net = score.banked + score.stack - score.totalBuyIn
    }
  }

  /** 公共状态：只包含所有人都能看到的信息，绝不携带他人底牌。 */
  private publicState(room: RoomRuntime): GameStatePublic {
    this.syncScores(room)
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
      buyInMin: room.minBuyIn,
      buyInMax: room.buyInMax,
      buyInStep: room.smallBlind,
      maxSeats: room.maxSeats,
      turnSeconds: room.turnSeconds,
      nextHandSeconds: room.nextHandSeconds,
      nextHandDeadlineAt: room.nextHandDeadlineAt,
      seats,
      scores: [...room.scores.values()].map((score) => ({ ...score })),
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
    return { playerId, seat, isHost: member?.isHost ?? false, holeCards, legalActions }
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

  /**
   * 移除玩家名单：过滤掉已经被踢、只是还在等本手结算的成员——
   * 他们此刻已经不在房间里了（凭证也失效了），再列出来只会让主持人重复操作。
   */
  private sendMembers(room: RoomRuntime, member: RoomMember): void {
    const members: RoomMemberPublic[] = [...room.members.values()]
      .filter((entry) => !entry.pendingKickRemoval)
      .map((entry) => ({
        playerId: entry.playerId,
        nickname: entry.nickname,
        seat: entry.seat,
        isHost: entry.playerId === room.hostPlayerId,
        connected: this.isConnected(entry),
      }))
    this.sendTo(member, {
      ...this.envelope(room, 'room.members', { members }),
      self: this.privateState(room, member.playerId),
    })
  }

  /**
   * 本手结算后真正删除「已被主持人移除」的成员。
   * 必须在引擎 finishHand() 之后调用：那时 pendingRemoval 的座位才从引擎里消失，
   * 公共状态与 socket 也随之清空。
   */
  private dropPendingKicks(room: RoomRuntime): void {
    for (const [playerId, entry] of [...room.members]) {
      if (!entry.pendingKickRemoval || room.table.seatOf(playerId)) continue
      room.members.delete(playerId)
      entry.socket?.close(4003, 'removed by host')
    }
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
