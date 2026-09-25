import { z } from 'zod'
import type { ActionType, Card, Rank, Street, Suit } from './poker.ts'
import { NICKNAME_MAX, ROOM_NAME_MAX, ROOM_PASSWORD_DIGITS, TABLE_RULES } from './poker.ts'

/* ────────────────────────────── HTTP：健康检查 ────────────────────────────── */

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string(),
  node: z.string(),
  dbPath: z.string(),
  dbMigration: z.number().int(),
  rooms: z.number().int(),
  maxRooms: z.number().int(),
  uptimeSec: z.number().int(),
  serverTime: z.number().int(),
})
export type HealthResponse = z.infer<typeof HealthResponseSchema>

/* ────────────────────────────── 错误码 ────────────────────────────── */

export const ERROR_CODES = [
  'bad_request',
  'room_not_found',
  'room_full',
  'room_closed',
  'bad_password',
  'not_seated',
  'seat_taken',
  'not_host',
  'not_your_turn',
  'illegal_action',
  'stale_version',
  'hand_finished',
  'unauthorized',
  'rate_limited',
  'internal',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  bad_request: '请求格式不正确',
  room_not_found: '房间不存在或已解散',
  room_full: '房间已满',
  room_closed: '房间已关闭',
  bad_password: '房间密码错误，请检查后重试',
  not_seated: '你还没有入座',
  seat_taken: '该座位已被占用',
  not_host: '只有主持人可以执行该操作',
  not_your_turn: '还没轮到你行动',
  illegal_action: '当前不合法操作',
  stale_version: '状态已过期，正在重新同步',
  hand_finished: '本手牌已结束',
  unauthorized: '身份凭证无效，请重新加入',
  rate_limited: '操作过于频繁，请稍后再试',
  internal: '服务器内部错误',
}

export const ErrorResponseSchema = z.object({
  error: z.enum(ERROR_CODES),
  message: z.string(),
  serverTime: z.number().int(),
})
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

/** 服务器同时允许开放的房间数上限（可用 MAX_ROOMS 覆盖）。 */
export const DEFAULT_MAX_ROOMS = 10

/* ────────────────────────────── 房间与牌局公开状态 ────────────────────────────── */

export type RoomStatus = 'waiting' | 'playing' | 'closed'
export type HandPhase = 'waiting' | Street | 'showdown' | 'settlement'

/** 服务端给出的合法动作；amount 语义：call=需补筹码，bet/raise=目标总额，all_in=全部剩余。 */
export interface LegalAction {
  action: ActionType
  amount?: number
  min?: number
  max?: number
}

export interface SeatPublic {
  playerId: string
  seat: number
  nickname: string
  stack: number
  committedStreet: number
  committedHand: number
  folded: boolean
  allIn: boolean
  connected: boolean
  /** 是否参与当前这手牌（未入座/已离座/等待下一手为 false）。 */
  inHand: boolean
  isHost: boolean
  /** 已准备（保留字段：现在由主持人直接开局，客户端不再发送 room.ready）。 */
  ready: boolean
  /** 已离座但座位与筹码仍为本人保留（只有本人能坐回）。 */
  away: boolean
  isDealer: boolean
  isSmallBlind: boolean
  isBigBlind: boolean
  /** 手牌张数，仅用于渲染牌背；不含任何他人未公开信息。 */
  holeCardCount: number
  /** 仅在摊牌或主动亮牌后出现。 */
  revealedCards: Card[] | null
  lastAction: ActionType | null
}

export interface PotPublic {
  amount: number
  eligiblePlayerIds: string[]
}

export interface HandWinnerPublic {
  playerId: string
  amount: number
  handName: string | null
  bestFive: Card[]
  /** 第几个池（0 = 主池），用于展示边池分配。 */
  potIndex: number
}

export interface HandResultPublic {
  handId: string
  handNo: number
  board: Card[]
  potTotal: number
  showdown: boolean
  winners: HandWinnerPublic[]
  revealed: { playerId: string; cards: Card[]; handName: string }[]
}

/** 本桌累计虚拟筹码记录；离桌玩家仍保留。 */
export interface PlayerScorePublic {
  playerId: string
  nickname: string
  totalBuyIn: number
  buyInCount: number
  handsPlayed: number
  /** 离桌时带走的虚拟筹码累计。 */
  banked: number
  stack: number
  net: number
  seated: boolean
}

/** 下发给所有玩家的公共状态：绝不含他人未公开底牌。 */
export interface GameStatePublic {
  roomId: string
  roomName: string
  status: RoomStatus
  version: number
  handId: string | null
  handNo: number
  phase: HandPhase
  street: Street | null
  board: Card[]
  pots: PotPublic[]
  potTotal: number
  currentBet: number
  minRaise: number
  smallBlind: number
  bigBlind: number
  startingStack: number
  /** 本桌买入范围与步进（房主在创建房间时定上限）。 */
  buyInMin: number
  buyInMax: number
  buyInStep: number
  maxSeats: number
  turnSeconds: number
  nextHandSeconds: number
  nextHandDeadlineAt: number | null
  /** 座位数组，下标即座位号，空位为 null。 */
  seats: (SeatPublic | null)[]
  scores: PlayerScorePublic[]
  buttonSeat: number | null
  actingPlayerId: string | null
  turnDeadlineAt: number | null
  lastResult: HandResultPublic | null
}

/** 只发给本人：底牌与合法动作。 */
export interface PrivateSelfState {
  playerId: string
  seat: number | null
  isHost?: boolean
  holeCards: Card[]
  legalActions: LegalAction[]
}

/* ────────────────────────────── 聊天与手牌历史 ────────────────────────────── */

export const CHAT_MAX_LENGTH = 200
/** 每个房间保留的聊天条数与手牌历史条数。 */
export const CHAT_HISTORY_LIMIT = 50
export const HAND_HISTORY_LIMIT = 20

export type ChatMessageKind = 'user' | 'system'

export interface ChatMessage {
  id: string
  /** user = 玩家发言；system = 房间事件（入座/开局/超时/结算…），由服务端写入。 */
  kind: ChatMessageKind
  playerId: string
  nickname: string
  text: string
  at: number
  /** 被 @ 到的玩家 id（服务端按昵称解析并校验，客户端据此高亮与提醒）。 */
  mentions?: string[]
}

/* ────────────────────────────── 服务端 → 客户端事件 ────────────────────────────── */

export const SERVER_EVENT_TYPES = [
  'room.snapshot',
  'room.player_joined',
  'room.player_left',
  'room.configured',
  'hand.started',
  'hand.state_changed',
  'turn.started',
  'hand.settled',
  'room.error',
  /** 房间成员名单：只回给主持人（「移除玩家」弹窗的数据源），不是公共状态。 */
  'room.members',
  'connection.recovered',
  'pong',
] as const
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number]

/**
 * 房间成员（含旁观者）。
 *
 * 与 GameStatePublic.seats 的区别：seats 只描述牌桌上的座位，
 * 旁观者根本没有条目；主持人要「移除某人」就必须能看到全部成员，
 * 所以这份名单只在需要时单独回给主持人，不进公共状态快照。
 */
export interface RoomMemberPublic {
  playerId: string
  nickname: string
  /** 座位号；旁观者为 null。 */
  seat: number | null
  isHost: boolean
  connected: boolean
}

/**
 * 统一事件信封：每次推送都带完整公共状态与本人私有状态，
 * 客户端只需整体替换本地快照（重连/丢包/乱序都收敛到同一份服务端真相）。
 */
export interface ServerEvent {
  type: ServerEventType
  eventId: string
  roomId: string
  handId: string | null
  version: number
  serverTime: number
  state: GameStatePublic
  self: PrivateSelfState
  /** 仅 hand.settled 携带。 */
  result?: HandResultPublic
  /** 仅 room.error 携带。 */
  error?: { code: ErrorCode; message: string }
  /** 系统提示文案（如「XX 加入了房间」）。 */
  notice?: string
  /** 仅 room.snapshot / connection.recovered 携带：最近聊天记录。 */
  chatHistory?: ChatMessage[]
  /** 仅 room.snapshot / connection.recovered 携带：最近手牌历史。 */
  handHistory?: HandResultPublic[]
  /** 仅 room.members 携带：房间成员名单（只发给主持人）。 */
  members?: RoomMemberPublic[]
}

/* ────────────────────────────── 轻量消息（无房间状态） ────────────────────────────── */

export interface PongMessage {
  type: 'pong'
  eventId: string
  serverTime: number
}

/**
 * 一条新聊天。**不携带任何对局状态**：聊天不是状态推送，
 * 否则消息会抢在结算/亮牌事件之前把牌面带出去，也会打乱逐张亮牌的时序。
 */
export interface ChatMessageEvent {
  type: 'chat.message'
  eventId: string
  serverTime: number
  message: ChatMessage
}

/** 尚未进入房间时的错误（例如凭证无效），不带状态快照。 */
export interface LightErrorMessage {
  type: 'room.error'
  eventId: string
  serverTime: number
  error: { code: ErrorCode; message: string }
}

export type ServerMessage = ServerEvent | PongMessage | LightErrorMessage | ChatMessageEvent

/* ────────────────────────────── 客户端 → 服务端命令（校验边界） ────────────────────────────── */

const requestId = z.string().min(1).max(64)

export const JoinCommandSchema = z.object({
  type: z.literal('room.join'),
  requestId,
  roomId: z.string().min(1).max(32),
  playerId: z.string().min(1).max(64),
  reconnectToken: z.string().min(1).max(128),
})

export const TakeSeatCommandSchema = z.object({
  type: z.literal('seat.take'),
  requestId,
  seat: z.number().int().min(0).max(TABLE_RULES.maxSeats - 1),
  /** 首次入座或结算后 0 筹码重新买入；坐回有筹码的保留座位时忽略。 */
  buyIn: z.number().int().positive().max(TABLE_RULES.maxBuyInLimit).optional(),
})

export const LeaveSeatCommandSchema = z.object({
  type: z.literal('seat.leave'),
  requestId,
})

/** 退出房间：释放座位并离开（与「离座」不同，离座只保留座位）。 */
export const LeaveRoomCommandSchema = z.object({
  type: z.literal('room.leave'),
  requestId,
})

/**
 * 主持人移除玩家：释放目标座位并把他请出房间。
 * 与 room.leave 的区别只在「谁发起」：语义同样是退出房间，因此座位释放规则完全一致
 * （手牌中先弃牌，等本手结算后再让出座位）。主持人不能移除自己。
 */
export const KickPlayerCommandSchema = z.object({
  type: z.literal('room.kick'),
  requestId,
  playerId: z.string().min(1).max(64),
})

/** 取房间成员名单（含旁观者）；只有主持人会收到内容，其他成员收到 not_host。 */
export const ListMembersCommandSchema = z.object({
  type: z.literal('room.members'),
  requestId,
})

export const ConfigureRoomCommandSchema = z.object({
  type: z.literal('room.configure'),
  requestId,
  turnSeconds: z.number().int().min(TABLE_RULES.minTurnSeconds).max(TABLE_RULES.maxTurnSeconds),
  nextHandSeconds: z.number().int().min(0).max(TABLE_RULES.maxNextHandSeconds),
})

/** 准备/取消准备：首版仅主持人可开局，准备状态用于提示。 */
export const ReadyCommandSchema = z.object({
  type: z.literal('room.ready'),
  requestId,
  ready: z.boolean(),
})

export const StartHandCommandSchema = z.object({
  type: z.literal('game.start'),
  requestId,
})

export const ActionCommandSchema = z.object({
  type: z.literal('game.action'),
  requestId,
  handId: z.string().min(1).max(64),
  expectedVersion: z.number().int().nonnegative(),
  action: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'all_in']),
  amount: z.number().int().nonnegative().optional(),
})

export const ChatSendCommandSchema = z.object({
  type: z.literal('chat.send'),
  requestId,
  text: z.string().trim().min(1).max(CHAT_MAX_LENGTH),
})

export const HeartbeatCommandSchema = z.object({
  type: z.literal('heartbeat'),
  requestId,
  clientTime: z.number().int(),
})

export const ClientCommandSchema = z.discriminatedUnion('type', [
  JoinCommandSchema,
  TakeSeatCommandSchema,
  LeaveSeatCommandSchema,
  LeaveRoomCommandSchema,
  KickPlayerCommandSchema,
  ListMembersCommandSchema,
  ConfigureRoomCommandSchema,
  ReadyCommandSchema,
  StartHandCommandSchema,
  ChatSendCommandSchema,
  ActionCommandSchema,
  HeartbeatCommandSchema,
])
export type ClientCommand = z.infer<typeof ClientCommandSchema>
export type ChatSendCommand = z.infer<typeof ChatSendCommandSchema>
export type ActionCommand = z.infer<typeof ActionCommandSchema>

/* ────────────────────────────── HTTP：建房 / 加房 ────────────────────────────── */

export const NicknameSchema = z
  .string()
  .trim()
  .min(1, '请填写昵称')
  .max(NICKNAME_MAX, `昵称最多 ${NICKNAME_MAX} 个字符`)

export const CreateRoomRequestSchema = z.object({
  nickname: NicknameSchema,
  password: z.string().regex(new RegExp(`^\\d{${ROOM_PASSWORD_DIGITS}}$`), `房间密码必须是 ${ROOM_PASSWORD_DIGITS} 位数字`),
  roomName: z.string().trim().max(ROOM_NAME_MAX).optional(),
  /**
   * 座位数：产品上固定 9 人桌（大厅不再让房主选），这个字段保留只是为了兼容旧客户端与既有测试，
   * 服务端一律收敛到 `TABLE_RULES.maxSeats`。
   */
  maxSeats: z.number().int().min(TABLE_RULES.minSeats).max(TABLE_RULES.maxSeats).optional(),
  /** 房主设置的盲注；旧客户端省略时沿用 10/20。 */
  smallBlind: z.number().int().min(1).max(TABLE_RULES.maxBigBlind - 1).optional(),
  bigBlind: z.number().int().min(2).max(TABLE_RULES.maxBigBlind).optional(),
  turnSeconds: z.number().int().min(TABLE_RULES.minTurnSeconds).max(TABLE_RULES.maxTurnSeconds).optional(),
  nextHandSeconds: z.number().int().min(0).max(TABLE_RULES.maxNextHandSeconds).optional(),
  /**
   * 初始筹码：玩家上桌**最低**要买入多少（默认 2000）。
   * 步进为小盲，允许范围 minBuyInFloor–maxBuyInLimit。
   */
  minBuyIn: z
    .number()
    .int()
    .min(TABLE_RULES.minBuyInFloor)
    .max(TABLE_RULES.maxBuyInLimit)
    .optional(),
  /** 买入上限：一次最多带多少上桌（默认 5000），不得小于初始筹码。 */
  buyInMax: z
    .number()
    .int()
    .min(TABLE_RULES.minBuyInFloor)
    .max(TABLE_RULES.maxBuyInLimit)
    .optional(),
})
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>

export const JoinRoomRequestSchema = z.object({
  nickname: NicknameSchema,
  password: z.string().regex(new RegExp(`^\\d{${ROOM_PASSWORD_DIGITS}}$`), `房间密码必须是 ${ROOM_PASSWORD_DIGITS} 位数字`),
})
export type JoinRoomRequest = z.infer<typeof JoinRoomRequestSchema>

export interface RoomCredentials {
  roomId: string
  roomName: string
  playerId: string
  nickname: string
  isHost: boolean
  /** 重连凭证：只下发给本人，用于断线回桌与刷新恢复。 */
  reconnectToken: string
  maxSeats: number
}

/** 房间存在性预检（邀请链接落地页用，不泄露房间细节）。 */
export const RoomInfoResponseSchema = z.object({
  roomId: z.string(),
  roomName: z.string(),
  status: z.enum(['waiting', 'playing', 'closed']),
  seated: z.number().int(),
  maxSeats: z.number().int(),
  buyInMin: z.number().int(),
  buyInMax: z.number().int(),
  buyInStep: z.number().int(),
  smallBlind: z.number().int(),
  bigBlind: z.number().int(),
  startingStack: z.number().int(),
  turnSeconds: z.number().int(),
  nextHandSeconds: z.number().int(),
})
export type RoomInfoResponse = z.infer<typeof RoomInfoResponseSchema>

/* 便于客户端渲染牌面时的辅助类型（保持与 shared/poker 一致）。 */
export type { ActionType, Card, Rank, Street, Suit }
