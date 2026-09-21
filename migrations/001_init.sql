-- 001_init.sql｜第 0 阶段基础表结构
-- 约定：所有时间为 Unix 毫秒（INTEGER）；所有筹码为整数 chips（无小数、不可兑换）。

CREATE TABLE IF NOT EXISTS rooms (
  room_id         TEXT PRIMARY KEY,
  room_name       TEXT    NOT NULL,
  host_player_id  TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'waiting',   -- waiting | playing | closed
  small_blind     INTEGER NOT NULL,
  big_blind       INTEGER NOT NULL,
  starting_stack  INTEGER NOT NULL,
  max_seats       INTEGER NOT NULL,
  turn_seconds    INTEGER NOT NULL DEFAULT 20,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  player_id       TEXT PRIMARY KEY,
  room_id         TEXT    NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  nickname        TEXT    NOT NULL,
  seat            INTEGER,                              -- NULL = 观战/未入座
  stack           INTEGER NOT NULL,
  is_host         INTEGER NOT NULL DEFAULT 0,
  ready           INTEGER NOT NULL DEFAULT 0,
  reconnect_hash  TEXT    NOT NULL,                     -- 重连凭证摘要（不存原文）
  joined_at       INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id, seat);

-- 服务端私有可恢复快照：包含牌堆与底牌，绝不整体下发客户端。
CREATE TABLE IF NOT EXISTS room_snapshots (
  room_id     TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  state_json  TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hand_results (
  hand_id      TEXT PRIMARY KEY,
  room_id      TEXT    NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  hand_no      INTEGER NOT NULL,
  board        TEXT    NOT NULL,
  pot          INTEGER NOT NULL,
  result_json  TEXT    NOT NULL,
  settled_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hand_results_room ON hand_results(room_id, hand_no);

-- 动作命令幂等凭据：同一 request_id 只生效一次。
CREATE TABLE IF NOT EXISTS command_receipts (
  request_id   TEXT PRIMARY KEY,
  room_id      TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  result_json  TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_receipts_created ON command_receipts(created_at);
