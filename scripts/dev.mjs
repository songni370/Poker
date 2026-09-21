// 开发入口：单命令并行启动「Fastify 服务端(3000)」与「Vite 客户端(5173)」。
// 生产环境不使用本脚本：只有一个进程 `node dist/server/index.js`。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

// 在这里统一加载 .env（而不是给 node 传 --env-file-if-exists）：
// --watch 会 fork 子进程，父子各解析一次，同一个提示会重复打印两遍，误导使用者。
if (existsSync('.env')) process.loadEnvFile('.env')

const commands = [
  ['server', ['--watch', 'src/server/index.ts']],
  ['client', ['node_modules/vite/bin/vite.js']],
]

let shuttingDown = false
const procs = commands.map(([name, args]) => {
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  })
  child.on('exit', (code) => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`[dev] ${name} 已退出（code=${code}），停止另一个进程`)
    for (const other of procs) other.kill()
    process.exit(code ?? 1)
  })
  return child
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shuttingDown = true
    for (const child of procs) child.kill()
    process.exit(0)
  })
}
