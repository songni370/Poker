// SQLite 备份与恢复演练（规格书第 5 阶段）。
//
// 演练全过程使用**独立数据库**，不触碰 data/poker.sqlite：
//   1) 启动真实服务并建房（走真实写入路径，产生 rooms / players / room_snapshots 数据）
//   2) 用 SQLite 官方热备份方式 VACUUM INTO 生成备份文件
//   3) 校验备份完整性，并比对关键表行数
//   4) 删除原库，模拟数据丢失
//   5) 从备份恢复并重启服务，确认房间仍可访问（证明恢复出来的库是「能用」的，不只是文件复制成功）
//
// 用法：node scripts/backup-drill.mjs
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.env.DRILL_PORT ?? 3400)
const BASE = `http://127.0.0.1:${PORT}`
const LIVE_DB = resolve(process.env.DRILL_DB ?? 'data/backup-drill.sqlite')
const BACKUP_DIR = resolve('data/backups')

const steps = []
function ok(label, detail) {
  steps.push(`  ✔ ${label}${detail ? `：${detail}` : ''}`)
  console.log(`  ✔ ${label}${detail ? `：${detail}` : ''}`)
}
function fail(label, detail) {
  console.error(`  ✖ ${label}${detail ? `：${detail}` : ''}`)
  process.exitCode = 1
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok) return await response.json()
    } catch {
      // 还没起来
    }
    await sleep(150)
  }
  throw new Error('服务未在预期时间内就绪')
}

async function startServer() {
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), DATABASE_PATH: LIVE_DB, NODE_ENV: 'production' },
    stdio: 'ignore',
    detached: true,
  })
  await waitForHealth()
  return child
}

async function stopServer(child) {
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await sleep(400)
}

/** 只读统计：房间、玩家、快照、结算记录。 */
function counts(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const one = (sql) => Number((db.prepare(sql).get() ?? {}).c ?? 0)
    return {
      rooms: one('SELECT COUNT(*) AS c FROM rooms'),
      players: one('SELECT COUNT(*) AS c FROM players'),
      snapshots: one('SELECT COUNT(*) AS c FROM room_snapshots'),
      hands: one('SELECT COUNT(*) AS c FROM hand_results'),
      migrations: one('SELECT COUNT(*) AS c FROM schema_migrations'),
    }
  } finally {
    db.close()
  }
}

function integrity(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('PRAGMA integrity_check').get()
    return String(Object.values(row ?? {})[0] ?? 'unknown')
  } finally {
    db.close()
  }
}

async function main() {
  console.log('SQLite 备份 / 恢复演练')
  console.log(`  主库：${LIVE_DB}`)
  mkdirSync(BACKUP_DIR, { recursive: true })
  rmSync(LIVE_DB, { force: true })
  rmSync(`${LIVE_DB}-wal`, { force: true })
  rmSync(`${LIVE_DB}-shm`, { force: true })

  // 1) 产生真实数据
  let server = await startServer()
  const created = await (
    await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: '演练房主', roomName: '备份演练房', maxSeats: 3 }),
    })
  ).json()
  const roomInfo = await (await fetch(`${BASE}/api/rooms/${created.roomId}`)).json()
  ok('通过真实服务建房', `roomId=${created.roomId} status=${roomInfo.status}`)
  await stopServer(server)

  const before = counts(LIVE_DB)
  ok('备份前统计', JSON.stringify(before))
  if (before.rooms < 1 || before.snapshots < 1 || before.migrations < 1) {
    fail('备份前数据不完整', '至少应有 rooms / room_snapshots / schema_migrations 各一行')
    return
  }

  // 2) 热备份（WAL 模式下安全，不需要停服）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(BACKUP_DIR, `poker-${stamp}.sqlite`)
  const writer = new DatabaseSync(LIVE_DB)
  try {
    writer.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
  } finally {
    writer.close()
  }
  ok('VACUUM INTO 热备份完成', backupPath)
  if (!existsSync(backupPath)) {
    fail('备份文件未生成')
    return
  }

  // 3) 校验备份
  const backupIntegrity = integrity(backupPath)
  if (backupIntegrity !== 'ok') {
    fail('备份完整性校验未通过', backupIntegrity)
    return
  }
  ok('备份完整性校验', 'PRAGMA integrity_check = ok')
  const backupCounts = counts(backupPath)
  const same = JSON.stringify(before) === JSON.stringify(backupCounts)
  if (!same) {
    fail('备份与原库行数不一致', `${JSON.stringify(before)} vs ${JSON.stringify(backupCounts)}`)
    return
  }
  ok('备份与原库行数一致', JSON.stringify(backupCounts))

  // 4) 模拟数据丢失
  rmSync(LIVE_DB, { force: true })
  rmSync(`${LIVE_DB}-wal`, { force: true })
  rmSync(`${LIVE_DB}-shm`, { force: true })
  ok('已删除主库文件（模拟数据丢失）', `存在=${String(existsSync(LIVE_DB))}`)

  // 5) 从备份恢复并让服务真正跑起来
  mkdirSync(dirname(LIVE_DB), { recursive: true })
  copyFileSync(backupPath, LIVE_DB)
  ok('已从备份恢复主库', `${counts(LIVE_DB).rooms} 个房间`)

  server = await startServer()
  const restoredInfo = await fetch(`${BASE}/api/rooms/${created.roomId}`)
  const restoredBody = await restoredInfo.json()
  if (restoredInfo.status !== 200) {
    fail('恢复后房间不可访问', `HTTP ${restoredInfo.status}`)
  } else {
    ok('恢复后房间可访问', `HTTP 200 roomName=${restoredBody.roomName ?? '?'} status=${restoredBody.status ?? '?'}`)
  }
  const health = await waitForHealth()
  ok('恢复后服务健康', `dbMigration=${health.dbMigration} rooms=${health.rooms}`)
  await stopServer(server)

  console.log(`\n演练结论：${process.exitCode === 1 ? '失败' : '通过'}（共 ${steps.length} 项检查）`)
  console.log('提示：生产环境请把 data/backups/ 定期复制到异机；升级流程严禁删除 data/。')
}

main().catch((error) => {
  console.error(`✖ 演练异常：${error.message}`)
  process.exit(1)
})
