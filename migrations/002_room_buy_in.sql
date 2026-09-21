-- 002_room_buy_in.sql｜买入上限（房主在创建房间时自定义）
-- 与 room_snapshots 里的 buyInMax 保持一致：rooms 表这一列只用于运维查询与回填，
-- 房间运行时仍以快照为准（快照缺失时回落到 starting_stack）。
ALTER TABLE rooms ADD COLUMN buy_in_max INTEGER;
