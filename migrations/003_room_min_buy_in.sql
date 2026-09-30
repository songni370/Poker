-- 003_room_min_buy_in.sql｜初始筹码（玩家上桌最低买入）
-- 与 002 的 buy_in_max 对称：rooms 表这一列只用于运维查询与回填，
-- 房间运行时仍以 room_snapshots 为准（老快照没有该字段时回落到 2000）。
ALTER TABLE rooms ADD COLUMN min_buy_in INTEGER;
