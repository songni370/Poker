import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  type ErrorCode,
  type ErrorResponse,
  type RoomInfoResponse,
} from '../shared/protocol.ts'
import { CommandError, type RoomManager } from './rooms.ts'
import type { Logger } from './logger.ts'

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  bad_request: 400,
  bad_password: 403,
  unauthorized: 401,
  room_not_found: 404,
  room_closed: 410,
  room_full: 409,
  rate_limited: 429,
}

/** 建房限流：同一 IP 在窗口内创建房间的次数上限（首版简单内存计数）。 */
const CREATE_WINDOW_MS = 10 * 60 * 1000
const CREATE_LIMIT = 20
const PASSWORD_FAILURE_LIMIT = 5

function errorBody(code: ErrorCode, message: string): ErrorResponse {
  return { error: code, message, serverTime: Date.now() }
}

export async function registerHttpRoutes(
  app: FastifyInstance,
  manager: RoomManager,
  logger: Logger,
): Promise<void> {
  const creations = new Map<string, { count: number; windowStart: number }>()
  const passwordFailures = new Map<string, { count: number; windowStart: number }>()

  const overCreateLimit = (ip: string): boolean => {
    const now = Date.now()
    const entry = creations.get(ip)
    if (!entry || now - entry.windowStart > CREATE_WINDOW_MS) {
      creations.set(ip, { count: 1, windowStart: now })
      return false
    }
    entry.count += 1
    return entry.count > CREATE_LIMIT
  }

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof CommandError) {
      return reply.code(STATUS_BY_CODE[error.code] ?? 400).send(errorBody(error.code, error.message))
    }
    // 只有真正的意外才进 error 级日志，并且带上「哪个请求」——否则排查时不知道是谁触发的。
    logger.error('HTTP 请求处理失败', { method: reply.request.method, url: reply.request.url, detail: error })
    return reply.code(500).send(errorBody('internal', '服务器内部错误'))
  }

  app.post('/api/rooms', async (request, reply) => {
    if (overCreateLimit(request.ip)) {
      return reply.code(429).send(errorBody('rate_limited', '创建房间过于频繁，请稍后再试'))
    }
    const parsed = CreateRoomRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(errorBody('bad_request', parsed.error.issues[0]?.message ?? '请求格式不正确'))
    }
    try {
      const credentials = manager.createRoom(parsed.data)
      // 「谁开了哪一桌」是最有用的一条业务日志：房间号就是邀请链接里的那串。
      // 座位数取房间实际值（请求里的 maxSeats 已被忽略，直接用请求值会打成 undefined）。
      logger.info(
        `建房「${parsed.data.roomName?.trim() || '未命名牌局'}」房主 ${parsed.data.nickname}，${String(credentials.maxSeats)} 人桌，房间号 ${credentials.roomId}`,
        { roomId: credentials.roomId, maxSeats: credentials.maxSeats },
      )
      return reply.code(201).send(credentials)
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.post('/api/rooms/:roomId/join', async (request, reply) => {
    const roomId = (request.params as { roomId?: string }).roomId ?? ''
    const parsed = JoinRoomRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(errorBody('bad_request', parsed.error.issues[0]?.message ?? '请求格式不正确'))
    }
    const key = `${request.ip}:${roomId}`
    const failures = passwordFailures.get(key)
    if (failures && Date.now() - failures.windowStart < CREATE_WINDOW_MS && failures.count >= PASSWORD_FAILURE_LIMIT) {
      return reply.code(429).send(errorBody('rate_limited', '密码尝试次数过多，请 10 分钟后重试'))
    }
    try {
      const credentials = manager.joinRoom(roomId, parsed.data.nickname, parsed.data.password)
      passwordFailures.delete(key)
      return reply.code(201).send(credentials)
    } catch (error) {
      if (error instanceof CommandError && error.code === 'bad_password') {
        const active = passwordFailures.get(key)
        passwordFailures.set(
          key,
          active && Date.now() - active.windowStart < CREATE_WINDOW_MS
            ? { count: active.count + 1, windowStart: active.windowStart }
            : { count: 1, windowStart: Date.now() },
        )
      }
      return fail(reply, error)
    }
  })

  /** 邀请链接落地页的房间预检：只返回公开信息，不泄露任何玩家凭证。 */
  app.get('/api/rooms/:roomId', async (request, reply) => {
    const roomId = (request.params as { roomId?: string }).roomId ?? ''
    const room = manager.get(roomId)
    if (!room) return reply.code(404).send(errorBody('room_not_found', '房间不存在或已解散'))
    const info: RoomInfoResponse = {
      roomId: room.id,
      roomName: room.name,
      status: room.status,
      seated: room.seatedCount(),
      maxSeats: room.maxSeats,
      buyInMin: room.minBuyIn,
      buyInMax: room.buyInMax,
      buyInStep: room.smallBlind,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      startingStack: room.startingStack,
      turnSeconds: room.turnSeconds,
      nextHandSeconds: room.nextHandSeconds,
    }
    return reply.send(info)
  })
}
