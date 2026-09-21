import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { HandResultPublic, RoomStatus } from '../shared/protocol.ts'

export interface RoomRecord {
  roomId: string
  roomName: string
  hostPlayerId: string
  status: RoomStatus
  smallBlind: number
  bigBlind: number
  startingStack: number
  maxSeats: number
  turnSeconds: number
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

/** 房间 ID 短且随机不可枚举；邀请链接可安全分享。 */
export function newRoomId(): string {
  return randomBytes(8).toString('base64url')
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
           starting_stack, max_seats, turn_seconds, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        room.roomId,
        room.roomName,
        room.hostPlayerId,
        room.status,
        room.smallBlind,
        room.bigBlind,
        room.startingStack,
        room.maxSeats,
        room.turnSeconds,
        now,
        now,
      )
  }

  setRoomStatus(roomId: string, status: RoomStatus): void {
    this.db.prepare('UPDATE rooms SET status = ?, updated_at = ? WHERE room_id = ?').run(status, Date.now(), roomId)
  }

  upsertPlayer(player: PlayerRecord): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO players (player_id, room_id, nickname, seat, stack, is_host, ready, reconnect_hash, joined_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
           seat = excluded.seat, stack = excluded.stack, ready = excluded.ready, last_seen_at = excluded.last_seen_at`,
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
