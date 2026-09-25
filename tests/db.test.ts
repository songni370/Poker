import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/server/db/index.ts'

const REQUIRED_TABLES = [
  'schema_migrations',
  'rooms',
  'players',
  'room_snapshots',
  'hand_results',
  'command_receipts',
]

test('首次启动自动建库并迁移；再次打开幂等且保留数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poker-db-'))
  const dbPath = join(dir, 'nested', 'poker.sqlite')

  const first = openDatabase(dbPath)
  assert.equal(first.migration, 4, '迁移版本应为 4（新增自动下一手间隔）')

  const tables = (first.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as {
    name: string
  }[]).map((row) => row.name)
  for (const table of REQUIRED_TABLES) {
    assert.ok(tables.includes(table), `缺少表：${table}`)
  }

  const journal = first.db.prepare('PRAGMA journal_mode').get() as unknown as { journal_mode: string }
  assert.equal(journal.journal_mode, 'wal', '应启用 WAL')
  const fk = first.db.prepare('PRAGMA foreign_keys').get() as unknown as { foreign_keys: number }
  assert.equal(Number(fk.foreign_keys), 1, '应启用外键')

  const now = Date.now()
  first.db
    .prepare(
      `INSERT INTO rooms (room_id, room_name, host_player_id, status, small_blind, big_blind,
        starting_stack, max_seats, turn_seconds, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('room_test', '测试房', 'player_test', 'waiting', 10, 20, 2000, 6, 20, now, now)
  first.close()

  // 第二次打开：不重复迁移，数据保留。
  const second = openDatabase(dbPath)
  assert.equal(second.migration, 4)
  const roomCount = second.db.prepare('SELECT COUNT(*) AS c FROM rooms').get() as unknown as { c: number }
  assert.equal(Number(roomCount.c), 1, '重启后房间数据应保留')
  const migrationCount = second.db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as unknown as {
    c: number
  }
  assert.equal(Number(migrationCount.c), 4, '迁移不应重复执行')
  const room = second.db.prepare('SELECT next_hand_seconds FROM rooms WHERE room_id = ?').get('room_test') as
    { next_hand_seconds: number }
  assert.equal(room.next_hand_seconds, 0, '老房间默认保持手动开局')
  second.close()

  rmSync(dir, { recursive: true, force: true })
})
