// 开发入口：单命令并行启动「Fastify 服务端(3000)」与「Vite 客户端(5173)」。
// 生产环境不使用本脚本：只有一个进程 `node dist/server/index.js`。
import { spawn } from 'node:child_process'

const procs = [
  ['server', ['--watch', '--env-file-if-exists=.env', 'src/server/index.ts']],
  ['client', ['node_modules/vite/bin/vite.js']],
].map(([name, args]) => {
  const p = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } })
  p.on('exit', (code) => {
    console.error(`[dev] ${name} 已退出 (code=${code})`)
    for (const other of procs) other.kill()
    process.exit(code ?? 1)
  })
  return p
})

process.on('SIGINT', () => {
  for (const p of procs) p.kill()
  process.exit(0)
})
