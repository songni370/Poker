import { buildApp } from './app.ts'
import { openDatabase, type DbHandle } from './db/index.ts'

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 3000)

let handle: DbHandle
try {
  handle = openDatabase()
} catch (error) {
  console.error('[startup] 数据库初始化/迁移失败，进程终止：', error instanceof Error ? error.message : error)
  process.exit(1)
}

const { app, rooms } = await buildApp(handle)

try {
  await app.listen({ host, port })
} catch (error) {
  app.log.error(error, '[startup] 监听失败，进程终止')
  handle.close()
  process.exit(1)
}

app.log.info(
  { url: `http://${host}:${port}`, dbPath: handle.path, migration: handle.migration, node: process.version },
  'Poker Room 启动完成（单进程单端口：网页 + HTTP API + WebSocket）',
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`收到 ${signal}，正在关闭`)
    rooms.closeAll()
    void app.close().then(() => {
      handle.close()
      process.exit(0)
    })
  })
}
