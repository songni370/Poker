// 单进程部署自检（规格书第 5 阶段）。
// 在目标服务器上运行即可，只依赖 Node 内置能力（fetch / WebSocket），不需要浏览器、不装任何东西：
//   node scripts/deploy-check.mjs            # 默认检查 http://127.0.0.1:3000
//   BASE_URL=https://poker.example.com node scripts/deploy-check.mjs
//
// 检查项：
//   1) /api/health 返回 ok，并报告迁移版本与数据库路径
//   2) 同一端口提供网页（text/html）
//   3) SPA 深链回落到 index.html，而 /api 未知路径不回落到页面
//   4) 同一端口 WebSocket 可握手（/ws）
//   5) 不存在外部服务依赖：进程环境里不应出现 Redis / MySQL / PostgreSQL 相关配置
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`
const results = []

function record(pass, label, detail = '') {
  results.push(pass)
  console.log(`${pass ? '  ✔' : '  ✖'} ${label}${detail ? `：${detail}` : ''}`)
}

async function main() {
  console.log(`单进程部署自检：${BASE}`)

  // 1) 健康检查
  let health
  try {
    const response = await fetch(`${BASE}/api/health`)
    health = await response.json()
    record(response.ok && health.ok === true, '健康检查 /api/health', `HTTP ${response.status} migration=${health.dbMigration}`)
    record(
      typeof health.dbPath === 'string' && health.dbPath.length > 0,
      '数据库为本地文件（无需独立数据库服务）',
      health.dbPath,
    )
    record(typeof health.version === 'string', '报告服务版本', `v${health.version} · Node ${health.node}`)
  } catch (error) {
    record(false, '健康检查 /api/health', error instanceof Error ? error.message : String(error))
    console.log('\n结论：失败（服务未就绪，后续检查跳过）')
    process.exit(1)
  }

  // 2) 同端口网页
  const home = await fetch(`${BASE}/`)
  const homeType = home.headers.get('content-type') ?? ''
  record(home.ok && homeType.includes('text/html'), '同一端口提供网页', `HTTP ${home.status} ${homeType}`)

  // 3) SPA 回落与 API 边界
  const deepLink = await fetch(`${BASE}/table/deploy-check-room`)
  record(deepLink.ok, 'SPA 深链回落', `HTTP ${deepLink.status}`)
  const apiMiss = await fetch(`${BASE}/api/does-not-exist`)
  record(apiMiss.status === 404, '/api 未知路径不回落到页面', `HTTP ${apiMiss.status}`)

  // 4) 同端口 WebSocket
  const wsUrl = `${BASE.replace(/^http/, 'ws')}/ws`
  const upgraded = await new Promise((resolve) => {
    const socket = new WebSocket(wsUrl)
    const timer = setTimeout(() => resolve(false), 5000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      socket.close()
      resolve(true)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  record(upgraded, '同一端口 WebSocket 握手 /ws', wsUrl)

  // 5) 外部服务依赖
  const envKeys = Object.keys(process.env).filter((key) =>
    /^(REDIS|MYSQL|MARIADB|POSTGRES|PG|MONGO|RABBITMQ)/i.test(key),
  )
  record(envKeys.length === 0, '无 Redis / MySQL / PostgreSQL 等外部服务配置', envKeys.join(', ') || '未发现')

  const failed = results.filter((pass) => !pass).length
  console.log(`\n结论：${failed === 0 ? '通过' : `失败（${String(failed)} 项未通过）`}（共 ${String(results.length)} 项检查）`)
  if (failed > 0) process.exit(1)
  await sleep(50)
}

main().catch((error) => {
  console.error(`✖ 自检异常：${error.message}`)
  process.exit(1)
})
