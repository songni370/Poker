import { buildApp } from './app.ts'
import { openDatabase, type DbHandle } from './db/index.ts'
import { createLogger, type LogLevel } from './logger.ts'

/**
 * 唯一的生产入口（单进程单端口）。
 *
 * 日志只保留「能让人看懂」的几行：启动就绪、数据库升级、建房、每手结算、房间回收、错误、关服。
 * 请求级日志（Fastify 默认每个请求两行）已在 app.ts 用 disableRequestLogging 关闭，
 * 需要更细的排查时用 `LOG_LEVEL=debug` 或直接看客户端/浏览器的报错。
 */

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 3000)

function resolveLevel(): LogLevel {
  const allowed: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']
  const value = process.env.LOG_LEVEL
  return allowed.includes(value as LogLevel) ? (value as LogLevel) : 'info'
}

const level = resolveLevel()
// 启动阶段的失败（数据库、端口）发生在 app 构建之前，所以这里单独建一个日志器。
const log = createLogger(level)

let handle: DbHandle
try {
  handle = openDatabase()
} catch (error) {
  log.error('数据库初始化失败，进程退出', { detail: error instanceof Error ? error.message : error })
  process.exit(1)
}

const { app, rooms } = await buildApp(handle, { logLevel: level })

// 只有真的执行了新迁移脚本才提示；普通重启不刷屏。
if (handle.appliedMigrations.length > 0) {
  log.info(`数据库已升级到版本 ${String(handle.migration)}（本次执行：${handle.appliedMigrations.join('、')}）`)
}

try {
  await app.listen({ host, port })
} catch (error) {
  log.error('端口监听失败，进程退出', { host, port, detail: error instanceof Error ? error.message : error })
  handle.close()
  process.exit(1)
}

log.info(
  `牌桌服务已就绪：http://${host}:${port}（网页 / API / WebSocket 同一端口）` +
    `｜数据库 ${handle.path}（版本 ${String(handle.migration)}）｜Node ${process.version}`,
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`收到 ${signal}，正在关闭服务`)
    rooms.closeAll()
    void app.close().then(() => {
      handle.close()
      process.exit(0)
    })
  })
}
