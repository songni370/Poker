import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ROOM_ID_DIGITS } from '../shared/poker.ts'
import type { HandResultPublic, RoomStatus } from '../shared/protocol.ts'

export interface RoomRecord {
  roomId: string
  roomName: string
  hostPlayerId: string
  status: RoomStatus
  smallBlind: number
  bigBlind: number
  startingStack: number
  /** 房主自定义的买入上限（老库为 NULL，调用方回落到 startingStack）。 */
  buyInMax?: number
  /** 初始筹码（上桌最低买入）。老记录没有该列时为 null。 */
  minBuyIn?: number
  maxSeats: number
  turnSeconds: number
  nextHandSeconds: number
}

export interface PlayerRecord {
  playerId: string
  roomId: string
  nickname: string
  seat: number | null
  stack: number
  isHost: boolean
  ready: boolean
  reconnectHash: string
}

/**
 * 房间号：纯数字（默认 6 位且首位非 0），方便口头或短信传达。
 * `isTaken` 由调用方查仓储给出：历史房间一直占着房间号主键，撞上就得重摇。
 */
export function newRoomId(isTaken: (roomId: string) => boolean = () => false): string {
  const min = 10 ** (ROOM_ID_DIGITS - 1)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = String(randomInt(min, min * 10))
    if (!isTaken(candidate)) return candidate
  }
  throw new Error('房间号分配失败：连续 50 次都撞上已有房间')
}

export function newPlayerId(): string {
  return randomBytes(8).toString('base64url')
}

/** 重连凭证只在创建时下发一次，数据库只保存摘要。 */
export function newReconnectToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/** 六位密码熵较低，SQLite 只保存带随机盐的 scrypt 摘要。 */
export function hashRoomPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export function roomPasswordMatches(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex || !/^[\da-f]{32}$/.test(saltHex) || !/^[\da-f]{64}$/.test(hashHex)) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return timingSafeEqual(actual, expected)
}

/** SQLite 仓储：房间、玩家、手牌结算与幂等凭据。 */
export class Repo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** 关键写入必须走事务：先落库再对外发布成功状态。 */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  insertRoom(room: RoomRecord): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO rooms (room_id, room_name, host_player_id, status, small_blind, big_blind,
           starting_stack, buy_in_max, min_buy_in, max_seats, turn_seconds, next_hand_seconds, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        room.roomId,
        room.roomName,
        room.hostPlayerId,
        room.status,
        room.smallBlind,
        room.bigBlind,
        room.startingStack,
        room.buyInMax ?? null,
        room.minBuyIn ?? null,
        room.maxSeats,
        room.turnSeconds,
        room.nextHandSeconds,
        now,
        now,
      )
  }

  setRoomStatus(roomId: string, status: RoomStatus): void {
    this.db.prepare('UPDATE rooms SET status = ?, updated_at = ? WHERE room_id = ?').run(status, Date.now(), roomId)
  }

  setRoomHost(roomId: string, playerId: string): void {
    this.db.prepare('UPDATE rooms SET host_player_id = ?, updated_at = ? WHERE room_id = ?').run(playerId, Date.now(), roomId)
    this.db.prepare('UPDATE players SET is_host = CASE WHEN player_id = ? THEN 1 ELSE 0 END WHERE room_id = ?').run(playerId, roomId)
  }

  updateRoomConfig(room: { id: string; turnSeconds: number; nextHandSeconds: number }): void {
    this.db.prepare('UPDATE rooms SET turn_seconds = ?, next_hand_seconds = ?, updated_at = ? WHERE room_id = ?')
      .run(room.turnSeconds, room.nextHandSeconds, Date.now(), room.id)
  }

  /** 房间号是否已被占用（含已关闭的历史房间）：room_id 是主键，重号会让建房写库失败。 */
  roomExists(roomId: string): boolean {
    return this.db.prepare('SELECT 1 FROM rooms WHERE room_id = ?').get(roomId) !== undefined
  }

  upsertPlayer(player: PlayerRecord): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO players (player_id, room_id, nickname, seat, stack, is_host, ready, reconnect_hash, joined_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
           seat = excluded.seat, stack = excluded.stack, is_host = excluded.is_host,
           ready = excluded.ready, last_seen_at = excluded.last_seen_at`,
      )
      .run(
        player.playerId,
        player.roomId,
        player.nickname,
        player.seat,
        player.stack,
        player.isHost ? 1 : 0,
        player.ready ? 1 : 0,
        player.reconnectHash,
        now,
        now,
      )
  }

  removePlayer(playerId: string): void {
    this.db.prepare('DELETE FROM players WHERE player_id = ?').run(playerId)
  }

  /** 手牌结算按 hand_id 幂等写入，重复结算不会产生第二条记录。 */
  saveHandResult(roomId: string, result: HandResultPublic): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO hand_results (hand_id, room_id, hand_no, board, pot, result_json, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(result.handId, roomId, result.handNo, result.board.join(' '), result.potTotal, JSON.stringify(result), Date.now())
  }

  /** 可恢复快照：每房一行，随命令在同一事务内覆盖写入。 */
  saveSnapshot(roomId: string, version: number, stateJson: string): void {
    this.db
      .prepare(
        `INSERT INTO room_snapshots (room_id, version, state_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET
           version = excluded.version, state_json = excluded.state_json, updated_at = excluded.updated_at`,
      )
      .run(roomId, version, stateJson, Date.now())
  }

  /** 启动时读取未关闭房间的快照用于恢复。state_json 只允许服务端读取。 */
  loadSnapshots(): { room_id: string; state_json: string }[] {
    return this.db
      .prepare(
        `SELECT s.room_id AS room_id, s.state_json AS state_json
           FROM room_snapshots s
           JOIN rooms r ON r.room_id = s.room_id
          WHERE r.status <> 'closed'`,
      )
      .all() as unknown as { room_id: string; state_json: string }[]
  }

  /** 恢复房间时载入最近的手牌结算（旧→新）。 */
  recentHandResults(roomId: string, limit: number): HandResultPublic[] {
    const rows = this.db
      .prepare('SELECT result_json FROM hand_results WHERE room_id = ? ORDER BY settled_at DESC LIMIT ?')
      .all(roomId, limit) as unknown as { result_json: string }[]
    return rows
      .map((row) => {
        try {
          return JSON.parse(row.result_json) as HandResultPublic
        } catch {
          return null
        }
      })
      .filter((entry): entry is HandResultPublic => entry !== null)
      .reverse()
  }

  deleteSnapshot(roomId: string): void {
    this.db.prepare('DELETE FROM room_snapshots WHERE room_id = ?').run(roomId)
  }

  /** 命令幂等：同一个 requestId 只生效一次。 */
  hasReceipt(requestId: string): boolean {
    const row = this.db.prepare('SELECT 1 AS found FROM command_receipts WHERE request_id = ?').get(requestId)
    return row !== undefined
  }

  saveReceipt(requestId: string, roomId: string, playerId: string, action: string, resultJson: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO command_receipts (request_id, room_id, player_id, action, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(requestId, roomId, playerId, action, resultJson, Date.now())
  }

  /** 清理过期幂等凭据，避免无限增长。 */
  pruneReceipts(keepMs = 24 * 60 * 60 * 1000): void {
    this.db.prepare('DELETE FROM command_receipts WHERE created_at < ?').run(Date.now() - keepMs)
  }

  openRoomCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM rooms WHERE status <> 'closed'").get() as
      | { c: number | bigint }
      | undefined
    return Number(row?.c ?? 0)
  }

  /** 启动时列出未关闭房间：第 3 阶段仅提示，快照恢复在第 4 阶段实现。 */
  openRoomIds(): string[] {
    const rows = this.db.prepare("SELECT room_id FROM rooms WHERE status <> 'closed'").all() as unknown as {
      room_id: string
    }[]
    return rows.map((row) => row.room_id)
  }
}
