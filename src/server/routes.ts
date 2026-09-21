import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  type ErrorCode,
  type ErrorResponse,
  type RoomInfoResponse,
} from '../shared/protocol.ts'
import { CommandError, type RoomManager } from './rooms.ts'

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  room_not_found: 404,
  room_closed: 410,
  room_full: 409,
  rate_limited: 429,
}

/** 建房限流：同一 IP 在窗口内创建房间的次数上限（首版简单内存计数）。 */
const CREATE_WINDOW_MS = 10 * 60 * 1000
const CREATE_LIMIT = 20

function errorBody(code: ErrorCode, message: string): ErrorResponse {
  return { error: code, message, serverTime: Date.now() }
}

export async function registerHttpRoutes(app: FastifyInstance, manager: RoomManager): Promise<void> {
  const creations = new Map<string, { count: number; windowStart: number }>()

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
    app.log.error({ err: error }, 'HTTP 请求处理失败')
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
      return reply.code(201).send(manager.createRoom(parsed.data))
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
    try {
      return reply.code(201).send(manager.joinRoom(roomId, parsed.data.nickname))
    } catch (error) {
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
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      startingStack: room.startingStack,
    }
    return reply.send(info)
  })
}
