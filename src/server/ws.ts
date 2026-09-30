import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { ClientCommandSchema, ERROR_MESSAGES, type ErrorCode, type LightErrorMessage } from '../shared/protocol.ts'
import type { RoomManager } from './rooms.ts'
import type { Logger } from './logger.ts'

const WINDOW_MS = 5000
const MAX_MESSAGES_PER_WINDOW = 60

/** WebSocket 入口：/ws，与 HTTP 同端口同进程。 */
export async function registerWebSocketRoutes(
  app: FastifyInstance,
  manager: RoomManager,
  logger: Logger,
): Promise<void> {
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } })

  app.get('/ws', { websocket: true }, (socket) => {
    let session: { roomId: string; playerId: string } | null = null
    let windowStart = Date.now()
    let messageCount = 0

    const sendRaw = (payload: unknown): void => {
      if (socket.readyState === 1) socket.send(JSON.stringify(payload))
    }

    const sendError = (code: ErrorCode): void => {
      const message: LightErrorMessage = {
        type: 'room.error',
        eventId: randomUUID(),
        serverTime: Date.now(),
        error: { code, message: ERROR_MESSAGES[code] },
      }
      sendRaw(message)
    }

    socket.on('message', (raw: { toString(): string }) => {
      const now = Date.now()
      if (now - windowStart > WINDOW_MS) {
        windowStart = now
        messageCount = 0
      }
      messageCount += 1
      if (messageCount > MAX_MESSAGES_PER_WINDOW) {
        sendError('rate_limited')
        return
      }

      let payload: unknown
      try {
        payload = JSON.parse(raw.toString())
      } catch {
        sendError('bad_request')
        return
      }

      const parsed = ClientCommandSchema.safeParse(payload)
      if (!parsed.success) {
        sendError('bad_request')
        return
      }
      const command = parsed.data

      if (command.type === 'room.join') {
        const failure = manager.attach(command.roomId, command.playerId, command.reconnectToken, socket)
        if (failure) {
          sendError(failure)
          return
        }
        session = { roomId: command.roomId, playerId: command.playerId }
        return
      }

      if (!session) {
        sendError('unauthorized')
        return
      }
      void manager.handleCommand(session.roomId, session.playerId, command).catch((error: unknown) => {
        logger.error('处理客户端命令失败', {
          roomId: session?.roomId,
          playerId: session?.playerId,
          command: command.type,
          detail: error,
        })
      })
    })

    socket.on('close', () => {
      if (session) manager.detach(session.roomId, session.playerId, socket)
    })
    socket.on('error', () => {
      if (session) manager.detach(session.roomId, session.playerId, socket)
    })
  })
}
