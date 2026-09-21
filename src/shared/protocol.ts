import { z } from 'zod'
import type { ActionType, Card, Rank, Street, Suit } from './poker.ts'
import { NICKNAME_MAX, ROOM_NAME_MAX, TABLE_RULES } from './poker.ts'

/* ────────────────────────────── HTTP：健康检查 ────────────────────────────── */

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string(),
  node: z.string(),
  dbPath: z.string(),
  dbMigration: z.number().int(),
  rooms: z.number().int(),
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
  /** 已准备（等待区用；主持人据此决定是否开局）。 */
  ready: boolean
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
  maxSeats: number
  turnSeconds: number
  /** 座位数组，下标即座位号，空位为 null。 */
  seats: (SeatPublic | null)[]
  buttonSeat: number | null
  actingPlayerId: string | null
  turnDeadlineAt: number | null
  lastResult: HandResultPublic | null
}

/** 只发给本人：底牌与合法动作。 */
export interface PrivateSelfState {
  playerId: string
  seat: number | null
  holeCards: Card[]
  legalActions: LegalAction[]
}

/* ────────────────────────────── 服务端 → 客户端事件 ────────────────────────────── */

export const SERVER_EVENT_TYPES = [
  'room.snapshot',
  'room.player_joined',
  'room.player_left',
  'hand.started',
  'hand.state_changed',
  'turn.started',
  'hand.settled',
  'room.error',
  'connection.recovered',
  'pong',
] as const
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number]

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
}

/* ────────────────────────────── 轻量消息（无房间状态） ────────────────────────────── */

export interface PongMessage {
  type: 'pong'
  eventId: string
  serverTime: number
}

/** 尚未进入房间时的错误（例如凭证无效），不带状态快照。 */
export interface LightErrorMessage {
  type: 'room.error'
  eventId: string
  serverTime: number
  error: { code: ErrorCode; message: string }
}

export type ServerMessage = ServerEvent | PongMessage | LightErrorMessage

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
})

export const LeaveSeatCommandSchema = z.object({
  type: z.literal('seat.leave'),
  requestId,
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

export const HeartbeatCommandSchema = z.object({
  type: z.literal('heartbeat'),
  requestId,
  clientTime: z.number().int(),
})

export const ClientCommandSchema = z.discriminatedUnion('type', [
  JoinCommandSchema,
  TakeSeatCommandSchema,
  LeaveSeatCommandSchema,
  ReadyCommandSchema,
  StartHandCommandSchema,
  ActionCommandSchema,
  HeartbeatCommandSchema,
])
export type ClientCommand = z.infer<typeof ClientCommandSchema>
export type ActionCommand = z.infer<typeof ActionCommandSchema>

/* ────────────────────────────── HTTP：建房 / 加房 ────────────────────────────── */

export const NicknameSchema = z
  .string()
  .trim()
  .min(1, '请填写昵称')
  .max(NICKNAME_MAX, `昵称最多 ${NICKNAME_MAX} 个字符`)

export const CreateRoomRequestSchema = z.object({
  nickname: NicknameSchema,
  roomName: z.string().trim().max(ROOM_NAME_MAX).optional(),
  maxSeats: z.number().int().min(TABLE_RULES.minSeats).max(TABLE_RULES.maxSeats).default(6),
})
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>

export const JoinRoomRequestSchema = z.object({ nickname: NicknameSchema })
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
  smallBlind: z.number().int(),
  bigBlind: z.number().int(),
  startingStack: z.number().int(),
})
export type RoomInfoResponse = z.infer<typeof RoomInfoResponseSchema>

/* 便于客户端渲染牌面时的辅助类型（保持与 shared/poker 一致）。 */
export type { ActionType, Card, Rank, Street, Suit }
