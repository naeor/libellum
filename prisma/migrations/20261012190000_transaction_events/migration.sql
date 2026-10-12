-- S9.5 P1：编辑历史的数据地基。
--
-- 所有者 2026-10-12 的设计：
--
-- > "编辑历史的主要目的**不是复杂的版本管理**，而是让用户能够明确知道：
-- >  **谁在什么时候，对哪一笔账目做了什么修改。**"
--
-- 他要看到的例子（这三条就是验收样板）：
--
-- > 「今天 14:32，naeor 将 **#000128** 午餐的金额从 ¥35 修改为 ¥38。」
-- > 「昨天 19:18，naeor **删除**了 **#000103** 出租车记录。」
-- > 「10 月 9 日 11:04，naeor **添加**了 **#000129** 超市购物记录。」
--
-- ⚠️ **为什么是一张新表，而不是扩展 `transactions.value_history`。**
--
-- `value_history` **已经存在**，但它是**为冲突判定设计的**：里面是"哪台设备把哪个字段从 A 改成了 B"
-- 的原始材料，读者是判定算法。而这一份的读者是**人**，要求是"简洁、易读"。
--
-- 所有者明确说了"**不是复杂的版本管理**"和"**不要变成复杂的数据库日志界面**"——
-- 把两种用途塞进同一个字段，就要让"给机器比较"和"给人阅读"共用一套结构，
-- **它们迟早互相牵制**（`教训.md` §8.12：一个判断在两处实现，结果不一致）。
--
-- ⚠️ **四列，四个判断，每一个都有理由：**

CREATE TABLE IF NOT EXISTS "transaction_events" (
  "id"             UUID          NOT NULL DEFAULT gen_random_uuid(),

  -- 哪本账。**必填**：历史永远属于一本账，跨账本的历史是不存在的概念。
  "book_id"        UUID          NOT NULL,

  -- ⚠️ **可空，而且这是整张表最重要的一个决定。**
  --
  -- 账目被删掉之后，**它的历史必须还在**——"我上周删了哪一笔"正是历史要回答的问题之一，
  -- **而一个 `ON DELETE CASCADE` 会让删除操作把证据一起删掉**。
  -- 所有者要看到的那三条例子里，就有一条是"删除了 #000103"。
  --
  -- ⚠️ 注意 `transaction_conflicts` 用的是 `CASCADE`，**这里刻意不同**：
  -- 冲突记录是账目的附属物（账目没了，冲突也就无从谈起），
  -- **而历史是一条独立的事实记录**——两者长得像，语义相反。
  "transaction_id" UUID,

  -- ⚠️ 账目编号的**快照**。账目被删除后 `transaction_id` 会变成 NULL，
  -- 而"#000103"这个字符串必须还能显示出来，否则那条历史就无法被指认。
  -- 编号本身不可变（1.09.20 保证），所以快照不会与真值漂移。
  "transaction_seq" INTEGER,

  -- 谁做的。**可空**：成员注销账号后事件仍在（`ON DELETE SET NULL`），
  -- 而事件里已经存了当时的显示名快照，所以名字不会丢。
  "actor_id"       UUID,
  "actor_name"     VARCHAR(64),

  -- ⚠️ 五种，且**没有"恢复"之外的含糊值**。
  --   created / updated / deleted —— 账目的三种变化（所有者列出的）
  --   restored                   —— 可选的恢复功能，**作为一次新的修改被记录**
  --   member_changed             —— 成员加入/退出/权限变动，所有者说"可以适当展示"
  "kind"           VARCHAR(24)   NOT NULL,

  -- ⚠️ **改了哪些字段、前后各是什么。** JSONB 而不是多列，因为字段集合会变
  -- （今天只有金额/分类/备注，明天可能加上标签）。
  -- 形状：`{ "amountCents": { "from": 3500, "to": 3800 }, … }`
  -- 删除与新增时可以为 NULL——那两种事件的"前后"由 kind 本身说清楚了。
  "changes"        JSONB,

  -- ⚠️ **事件发生的时间**（服务器时间）。用它排序，不用 `created_at` 之外的任何东西——
  -- 一个排序字段就够，多一个就会有两个说不清的先后。
  "occurred_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "transaction_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transaction_events_kind_known"
    CHECK ("kind" IN ('created', 'updated', 'deleted', 'restored', 'member_changed'))
);

-- ⚠️ **外键走循环 + 存在性检查，与前几次迁移同一份写法。**
--
-- `CREATE TABLE IF NOT EXISTS` 会跳过已存在的表，**而紧跟其后的 `ADD CONSTRAINT` 不会跳过**——
-- 那是"第一次成功、第二次失败"的典型写法，而第二次往往发生在别人的机器上。
-- 这一轮我已经在另一个迁移里犯过一次同样的错，所以这里直接用循环。
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('transaction_events', 'transaction_events_book_id_fkey',        'FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      -- ⚠️ `SET NULL`，不是 CASCADE：**删除一笔账目，不能把它的历史一起删掉。**
      ('transaction_events', 'transaction_events_transaction_id_fkey', 'FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE'),
      -- ⚠️ 同上：**成员注销账号后，他做过的事仍然是事实。**
      ('transaction_events', 'transaction_events_actor_id_fkey',       'FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE')
    ) AS t(tbl, name, definition)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', item.tbl, item.name, item.definition);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 索引
-- ---------------------------------------------------------------------------
--
-- ⚠️ **主查询是"这本账最近发生了什么"**：按账本取、按时间倒序。就是这一条。
CREATE INDEX IF NOT EXISTS "transaction_events_book_time_idx"
  ON "transaction_events"("book_id", "occurred_at" DESC);

-- ⚠️ **第二个查询是"这一笔账经历过什么"**：从账目详情点进它的历史。
CREATE INDEX IF NOT EXISTS "transaction_events_transaction_idx"
  ON "transaction_events"("transaction_id")
  WHERE "transaction_id" IS NOT NULL;
