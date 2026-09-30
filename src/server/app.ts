import Fastify, { type FastifyInstance } from 'fastify'
import { pino } from 'pino'
import fastifyStatic from '@fastify/static'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DbHandle } from './db/index.ts'
import { Repo } from './repo.ts'
import { RoomManager } from './rooms.ts'
import { createLogger, textLogStream, type LogLevel } from './logger.ts'
import { QuietRequestLogger } from './log-controller.ts'
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

/** 把日志级别字符串收敛到已知取值；非法值退回默认 info。 */
function normalizeLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  const allowed: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']
  return allowed.includes(value as LogLevel) ? (value as LogLevel) : fallback
}

export interface BuildAppOptions {
  clientDir?: string
  /** 同时开放的房间上限，默认取 MAX_ROOMS 或 10。 */
  maxRooms?: number
  /** 掉线宽限期（毫秒），测试里可传极小值验证「超时自动释放座位」。 */
  seatReleaseMs?: number
  /**
   * 日志级别：默认取 LOG_LEVEL（缺省 info）；测试里传 'silent' 让 `node --test` 输出保持干净。
   */
  logLevel?: LogLevel
}

export interface BuiltApp {
  app: FastifyInstance
  rooms: RoomManager
}

/** 构建单进程应用：HTTP API + WebSocket + 前端静态资源，全部同端口。 */
export async function buildApp(handle: DbHandle, options: BuildAppOptions = {}): Promise<BuiltApp> {
  // 日志策略见 logger.ts：
  //   - 关闭 Fastify 的「每个请求两行」噪声（QuietRequestLogger）；
  //   - Pino 与业务日志统一输出精简文本；
  //   - 只保留启动 / 数据库升级 / 建房 / 每手结算 / 房间回收 / 关服 + 错误。
  const level = normalizeLogLevel(
    options.logLevel ?? process.env.LOG_LEVEL,
    options.logLevel === undefined && process.env.NODE_ENV === 'test' ? 'silent' : 'info',
  )
  const logger = createLogger(level)

  const app = Fastify({
    logger: {
      level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.epochTime,
      stream: textLogStream,
      // 日志脱敏：不记录凭证类请求头；底牌等敏感字段由业务层保证不入日志。
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        remove: true,
      },
    },
    logController: new QuietRequestLogger(),
    bodyLimit: 64 * 1024,
  })
  const clientDir = resolve(options.clientDir ?? process.env.CLIENT_DIR ?? 'dist/client')
  const version = packageVersion()
  const startedAt = Date.now()

  const repo = new Repo(handle.db)
  const rooms = new RoomManager(repo, {
    maxRooms: options.maxRooms ?? Number(process.env.MAX_ROOMS ?? DEFAULT_MAX_ROOMS),
    ...(options.seatReleaseMs === undefined ? {} : { seatReleaseMs: options.seatReleaseMs }),
    logger,
  })
  rooms.startSweeper()
  // 第 4 阶段：进程重启后从 SQLite 快照恢复未关闭房间（含牌局与牌堆位置）。
  const recovery = rooms.restoreRooms()
  if (recovery.restored > 0 || recovery.discarded > 0) {
    logger.info(
      `已从数据库恢复 ${String(recovery.restored)} 个未结束的房间` +
        (recovery.discarded > 0 ? `，另有 ${String(recovery.discarded)} 个快照损坏的房间被关闭` : ''),
      { restored: recovery.restored, discarded: recovery.discarded },
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

  await registerHttpRoutes(app, rooms, logger)

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
    logger.warn(`前端尚未构建（${clientDir}/index.html 不存在），当前只提供 API`, { clientDir })
    app.setNotFoundHandler((_request, reply) =>
      reply.code(503).send({ error: 'internal', message: '前端未构建：请先执行 npm run build', serverTime: Date.now() }),
    )
  }

  await registerWebSocketRoutes(app, rooms, logger)

  return { app, rooms }
}
