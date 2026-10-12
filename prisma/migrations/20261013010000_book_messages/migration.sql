-- S9.5 P8：账本内留言。
--
-- 所有者 2026-10-12 的规格：
--
-- > "它只属于当前账本，类似一个**小型群聊或留言板**：同一本账的成员可以看到公共留言；
-- >  成员可以发送文字；显示**发送者和发送时间**；**不提供私人聊天**；不需要复杂的**好友聊天体系**；
-- >  不必追求与专业聊天软件相同的功能完整度。"
--
-- > "我希望它更接近一个**围绕账本的公共讨论空间**。"
--
-- 明确不做（原话）：**消息撤回、表情包、语音聊天、在线状态、已读回执**。
--
-- ⚠️ **一张表就够，而且这是设计，不是省事。** 所有者把边界画得很清楚：没有私聊、没有好友体系、
-- 没有回执。**一张"账本 + 发送者 + 内容 + 时间"的表恰好表达了那个范围内的全部东西**；
-- 加一张会话表、加一个参与者表，就是在为一个他明确说不要的聊天系统搭骨架
-- （`教训.md` §8.13：他定过的边界不该被"顺手做完整"推走）。
--
-- ⚠️ **没有"已读"列，也没有"撤回"列。** 这不是还没做——所有者把它们列为**不需要**。
-- **加一列"以后可能会用"，就是让一个被划掉的功能以字段的形式活下来**
-- （`教训.md` §8.11：被否决的想法会藏进代码里）。
--
-- ⚠️ **可重复执行**：`CREATE TABLE IF NOT EXISTS` + 存在性检查的外键 + `CREATE INDEX IF NOT EXISTS`，
-- 没有一条 DELETE。

CREATE TABLE IF NOT EXISTS "book_messages" (
  "id"         UUID          NOT NULL DEFAULT gen_random_uuid(),
  -- ⚠️ 留言属于**一本账**，不属于两个人之间的会话。这就是"只属于当前账本"的落实。
  "book_id"    UUID          NOT NULL,
  "sender_id"  UUID          NOT NULL,
  -- ⚠️ **发送者名字的快照。** 改昵称不该改写历史留言的署名，注销账号也不该让留言变成无名氏
  -- ——与 `transaction_events.actor_name` 同一条理由。
  "sender_name" VARCHAR(64)  NOT NULL,
  -- ⚠️ **有长度上限。** 它是给别人看的自由文本；**没有上限的文本就是一条可以被用来刷屏的通道**，
  -- 而这个功能的目的是讨论账目，不是灌水。
  "body"       VARCHAR(500)  NOT NULL,
  -- ⚠️ **只有创建时间，没有编辑时间。** 留言不可编辑（所有者没要这个，而"已读/撤回"都被列为不需要）
  -- ——**一个永远不变的字段不需要两个同行的时间戳。**
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "book_messages_pkey" PRIMARY KEY ("id"),
  -- ⚠️ 空白留言不是留言。数据库层面挡掉"只打了几个空格就发送"。
  CONSTRAINT "book_messages_body_not_blank" CHECK (btrim("body") <> '')
);

-- ⚠️ **外键走循环 + 存在性检查**，与前几次迁移同一份写法——`CREATE TABLE IF NOT EXISTS` 会跳过
-- 已存在的表，**而紧跟其后的 `ADD CONSTRAINT` 不会跳过**。这一轮我已经在这上面栽过两次。
-- ⚠️ **`(VALUES …) AS t(tbl, name, definition)`——那层括号和别名不能省。**
-- 我的第一版写成 `SELECT * FROM VALUES (…)`，PostgreSQL 在 `(` 处报语法错误：
-- **裸的 `VALUES` 不能直接跟在 `FROM` 后面**，必须是一个带别名的子查询。
-- 而它的表现值得记住：**`CREATE TABLE` 成功了、外键一个都没建**——
-- 脚本以 `exit=3` 停下，所以没被当成成功，但如果只看"表在不在"就会以为迁移过了。
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('book_messages', 'book_messages_book_id_fkey',   'FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      -- ⚠️ `CASCADE`：账本被真的删掉时留言也该消失（留言只属于这本账，没有别的意义）。
      -- 注意这与 `transaction_events` 的 `SET NULL` 不同——那里的行是**独立的事实记录**，
      -- 而这里的一句"昨天买菜的 86 元记了吗"**离开那本账就没有意义**。
      ('book_messages', 'book_messages_sender_id_fkey', 'FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE')
    ) AS t(tbl, name, definition)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', item.tbl, item.name, item.definition);
    END IF;
  END LOOP;
END $$;

-- ⚠️ **主查询是"这本账最近的留言"**：按账本取、按时间倒序。一条索引就够。
CREATE INDEX IF NOT EXISTS "book_messages_book_time_idx"
  ON "book_messages"("book_id", "created_at" DESC);
