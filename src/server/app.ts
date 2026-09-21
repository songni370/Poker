import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DbHandle } from './db/index.ts'
import { Repo } from './repo.ts'
import { RoomManager } from './rooms.ts'
import { DEFAULT_MAX_ROOMS } from '../shared/protocol.ts'
import { registerHttpRoutes } from './routes.ts'
import { registerWebSocketRoutes } from './ws.ts'
import { HealthResponseSchema, type HealthResponse, type ErrorResponse } from '../shared/protocol.ts'

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const SERVICE_NAME = 'poker-room'

const loggerOptions: FastifyServerOptions['logger'] = {
  level: process.env.LOG_LEVEL ?? 'info',
  // 日志脱敏：不记录凭证类请求头；底牌等敏感字段由业务层保证不入日志。
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    remove: true,
  },
}

export interface BuildAppOptions {
  clientDir?: string
  /** 同时开放的房间上限，默认取 MAX_ROOMS 或 3。 */
  maxRooms?: number
}

export interface BuiltApp {
  app: FastifyInstance
  rooms: RoomManager
}

/** 构建单进程应用：HTTP API + WebSocket + 前端静态资源，全部同端口。 */
export async function buildApp(handle: DbHandle, options: BuildAppOptions = {}): Promise<BuiltApp> {
  const app = Fastify({ logger: loggerOptions, bodyLimit: 64 * 1024 })
  const clientDir = resolve(options.clientDir ?? process.env.CLIENT_DIR ?? 'dist/client')
  const version = packageVersion()
  const startedAt = Date.now()

  const repo = new Repo(handle.db)
  const rooms = new RoomManager(repo, options.maxRooms ?? Number(process.env.MAX_ROOMS ?? DEFAULT_MAX_ROOMS))
  rooms.startSweeper()
  // 第 4 阶段：进程重启后从 SQLite 快照恢复未关闭房间（含牌局与牌堆位置）。
  const recovery = rooms.restoreRooms()
  if (recovery.restored > 0 || recovery.discarded > 0) {
    app.log.info(
      { restored: recovery.restored, discarded: recovery.discarded },
      '房间恢复完成（restored=从快照恢复，discarded=快照不可用被安全关闭）',
    )
  }

  const notFound = (message: string): ErrorResponse => ({ error: 'bad_request', message, serverTime: Date.now() })

  app.get('/api/health', async (): Promise<HealthResponse> =>
    HealthResponseSchema.parse({
      ok: true,
      service: SERVICE_NAME,
      version,
      node: process.version,
      dbPath: handle.path,
      dbMigration: handle.migration,
      rooms: rooms.roomCount(),
      maxRooms: rooms.roomLimit(),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      serverTime: Date.now(),
    }),
  )

  await registerHttpRoutes(app, rooms)

  if (existsSync(join(clientDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: clientDir, index: ['index.html'] })
    // SPA 路由 fallback；/api 与 /ws 不落到 index.html。
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
        return reply.code(404).send(notFound('接口不存在'))
      }
      return reply.sendFile('index.html')
    })
  } else {
    app.log.warn({ clientDir }, '前端尚未构建（dist/client/index.html 不存在），仅提供 API')
    app.setNotFoundHandler((_request, reply) =>
      reply.code(503).send({ error: 'internal', message: '前端未构建：请先执行 npm run build', serverTime: Date.now() }),
    )
  }

  await registerWebSocketRoutes(app, rooms)

  return { app, rooms }
}
