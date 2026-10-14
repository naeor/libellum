-- S11：账本可以改名，所以历史里多一种事件。
--
-- 所有者 2026-10-13 要求开始页的齿轮面板里能重命名账本，并附带一个条件：
--
-- > "**仅对现有权限模型允许修改账本名称的用户开放**……不允许无权限用户绕过前端限制修改账本。"
-- > "如果项目目前没有正式的重命名能力，**不要擅自设计未经确认的后端权限规则**。先核实现有模型，说明缺失部分。"
--
-- 核实结果：后端**没有** rename 路由。权限沿用现成的 `requireBookForWrite`
-- （与邀请同一把锁：viewer 会被拒），没有新造规则。
--
-- ⚠️ **本迁移只放宽一条 CHECK 约束，不动任何数据。**
--
-- 为什么必须迁移：`transaction_events` 上有一条
-- `transaction_events_kind_known`，逐字列举了允许的事件类型。改名要写 `book_changed`，
-- **不在这张名单里，插入会被数据库直接拒绝**——这正是那条约束存在的意义：
-- 一个拼错的事件类型不会安静地写进历史、等到几天后在历史页面上崩掉。
--
-- ⚠️ **所以"增加一种事件"是一次迁移，这是刻意的代价**：
-- 一本账能记录哪些事，是一个决定，不是一个字符串。
--
-- ⚠️ **可重复执行**：先 DROP IF EXISTS 再 ADD。

ALTER TABLE "transaction_events" DROP CONSTRAINT IF EXISTS "transaction_events_kind_known";

ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_kind_known"
  CHECK (kind IN ('created', 'updated', 'deleted', 'restored', 'member_changed', 'book_changed'));
