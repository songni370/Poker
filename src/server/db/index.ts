import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 迁移目录：src/server/db/ 与 dist/server/db/ 向上三级都正好是项目根目录。 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url))

export interface DbHandle {
  db: DatabaseSync
  path: string
  /** 已应用的最高迁移版本号，用于启动日志与 /api/health。 */
  migration: number
  /** 本次启动真正执行的迁移文件名；空数组表示数据库已是最新（正常重启）。 */
  appliedMigrations: string[]
  close(): void
}

interface MigrationRow {
  version: number
}

/**
 * 打开（必要时创建）SQLite 数据库并执行幂等、版本化迁移。
 * 迁移失败直接抛错，由调用方终止启动——不允许带着半迁移状态对外服务。
 */
export function openDatabase(dbPath = process.env.DATABASE_PATH ?? './data/poker.sqlite'): DbHandle {
  const absolute = resolve(dbPath)
  mkdirSync(dirname(absolute), { recursive: true })

  const db = new DatabaseSync(absolute)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')

  const result = migrate(db)
  return {
    db,
    path: absolute,
    migration: result.migration,
    appliedMigrations: result.applied,
    close: () => db.close(),
  }
}

function migrate(db: DatabaseSync): { migration: number; applied: string[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  )`)

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as unknown as MigrationRow[]).map((r) =>
      Number(r.version),
    ),
  )

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  let highest = applied.size > 0 ? Math.max(...applied) : 0
  const executed: string[] = []

  for (const file of files) {
    const version = Number(file.split('_')[0])
    if (!Number.isInteger(version) || version <= 0) {
      throw new Error(`迁移文件名不合规（需 NNN_name.sql）：${file}`)
    }
    if (applied.has(version)) {
      highest = Math.max(highest, version)
      continue
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        version,
        file,
        Date.now(),
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`迁移失败 ${file}`, { cause: error })
    }
    executed.push(file)
    highest = Math.max(highest, version)
  }

  return { migration: highest, applied: executed }
}
