-- S9 阶段三：协作者、通知与配额。
--
-- 三张表，对应所有者定下来的三件事：
--   1. `collaborators` —— 账号级的协作者关系（**双方同意**才成立一行）；
--   2. `notifications` —— 那条"等你处理"的消息（协作者申请 / 账本邀请 / 次级码提醒）；
--   3. `notification_quota` —— 每天能发多少条（对同一个人 5 条、总共 20 条）。
--
-- ⚠️ **"协作者"是账号级的，不是账本级的。** 所有者专门纠正过这一点：
-- A 与 B 共享账本 1、与 C 共享账本 2 时，**A 的协作者是 {B, C}** ——
-- **"好友指的就是一个账号所有协作者的集合"**。
--
-- ⚠️ **账目权限仍然只来自 `book_members`。** 协作者关系**不授予任何账目权限**——
-- 它只决定"我可以邀请谁"，以及"我总共在跟谁一起记账"。
--
-- ⚠️ **可重复执行**（与前一版同样的要求）。**所有约束都走存在性检查**：
-- `CREATE TABLE IF NOT EXISTS` 会跳过已存在的表，而紧跟其后的 `ADD CONSTRAINT`
-- 不会跳过——那是"第一次成功、第二次失败"的典型写法，而第二次往往发生在别人机器上。
--
-- ⚠️ **没有一条 DELETE。** 最坏的结果是多了几张空表，可以人工重跑。

-- ---------------------------------------------------------------------------
-- 1. `collaborators` —— 两个人之间的协作者关系
-- ---------------------------------------------------------------------------
--
-- ⚠️ **一行代表一段关系，而不是两次邀请。** 主键把两个账号按固定顺序排好
-- （`user_a < user_b`），所以 A 加 B 与 B 加 A 是**同一行**，不会出现"他那边显示是好友、
-- 我这边不是"的半个关系。也因为这个顺序，**这个表不记录"谁发起的"**——
-- 谁发起属于那条通知，不属于关系。
--
-- ⚠️ **需要双方同意**（所有者："加为协作者需要对方同意"），
-- 所以这一行只在**被邀请方点了同意**之后才写进来。**没有"待同意"的行**：
-- 未决定的事在那条通知里。两处都存会让它们迟早不一致（`教训.md` §8.7）。

CREATE TABLE IF NOT EXISTS "collaborators" (
  "user_a"     UUID          NOT NULL,
  "user_b"     UUID          NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "collaborators_pkey" PRIMARY KEY ("user_a", "user_b"),
  -- 自己不能是自己的协作者：挡掉"把编号填成自己"那种误操作。
  CONSTRAINT "collaborators_distinct" CHECK ("user_a" <> "user_b"),
  -- 顺序规范写进约束，而不是只写在注释里——**注释约束不了任何人，CHECK 可以。**
  CONSTRAINT "collaborators_ordered" CHECK ("user_a" < "user_b")
);

-- ---------------------------------------------------------------------------
-- 2. `notifications` —— 一条等某人处理的消息
-- ---------------------------------------------------------------------------
--
-- 三种类型（所有者定的三个来源）：
--
-- | kind | 含义 |
-- |---|---|
-- | `collaborator_request` | 有人请求加我为协作者 |
-- | `book_invite` | 有人邀请我进某本账（`book_id` 必填） |
-- | `referral_reminder` | 次级邀请码那条 7 天提醒（"点击确认可以自动添加邀请码生成者的好友"） |
--
-- ⚠️ **`book_id` 可空，而且这是有意义的**：协作者关系与次级码提醒都**不属于任何一本账**。
-- 借用一本假账本表示它们，会让"这条通知关于哪本账"变成一个需要解释的谎言。
--
-- ⚠️ **状态只有三种，`expired` 不在其中。** 过期由 `expires_at` 与当前时间比较得出，
-- **不落库**：一个需要定时任务去改的状态，会在任务没跑的那天变成错的。
--
-- ⚠️ **`message` 有长度上限**，因为它是**给别人看的自由文本**——
-- 没有上限的文本就是一条可以用来骚扰的通道。

CREATE TABLE IF NOT EXISTS "notifications" (
  "id"           UUID          NOT NULL DEFAULT gen_random_uuid(),
  "recipient_id" UUID          NOT NULL,
  "sender_id"    UUID          NOT NULL,
  "book_id"      UUID,
  "kind"         VARCHAR(32)   NOT NULL,
  "message"      VARCHAR(200),
  "status"       VARCHAR(16)   NOT NULL DEFAULT 'pending',
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"   TIMESTAMPTZ(6) NOT NULL,
  "read_at"      TIMESTAMPTZ(6),
  "decided_at"   TIMESTAMPTZ(6),
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notifications_kind_known"
    CHECK ("kind" IN ('collaborator_request', 'book_invite', 'referral_reminder')),
  CONSTRAINT "notifications_status_known"
    CHECK ("status" IN ('pending', 'accepted', 'declined')),
  -- 自己给自己发通知只会出现在程序出错的时候。
  CONSTRAINT "notifications_distinct" CHECK ("recipient_id" <> "sender_id")
);

-- ---------------------------------------------------------------------------
-- 3. `notification_quota` —— 每天能发多少条
-- ---------------------------------------------------------------------------
--
-- 所有者定的两个上限，以及它们各自要防的东西：
--
-- | 上限 | 防的是什么 |
-- |---|---|
-- | 对**同一个**账号每天 5 条 | 反复骚扰同一个人 |
-- | 对**所有**账号每天 20 条 | 群发骚扰 |
--
-- **分享链接不算**（所有者："分享链接不算"）——链接是被邀请人自己点开的，
-- 不是推给他的消息，算进来会挤占真正的通知额度。
--
-- ⚠️ **按 (人, 目标, 日期) 聚合，而不是一条通知一行。** 每次发送都要原子地
-- "检查并加一"，聚合行让这件事成为**一条 UPDATE**：
-- `SET used = used + 1 WHERE used < limit` —— 影响 0 行就是超限。
-- 一行一计数则要先 COUNT 再 INSERT，而中间那段时间**正是两个人同时发第 5 条的时刻**。
--
-- ⚠️ **`subject_id` 用全零 UUID 表示"总计"那一行，而不是 NULL。**
-- PostgreSQL 的唯一索引把 NULL 看作互不相等，用 NULL 会让总计那行**约束不住重复**，
-- 于是并发下会出现两行总计，各自数到 5 却互不知情。

CREATE TABLE IF NOT EXISTS "notification_quota" (
  "user_id"    UUID          NOT NULL,
  "subject_id" UUID          NOT NULL,
  "day"        DATE          NOT NULL,
  "used"       INTEGER       NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_quota_pkey" PRIMARY KEY ("user_id", "subject_id", "day"),
  CONSTRAINT "notification_quota_non_negative" CHECK ("used" >= 0)
);

-- ---------------------------------------------------------------------------
-- 外键与索引（全部幂等）
-- ---------------------------------------------------------------------------

-- ⚠️ **每次执行都是同一份清单**，所以重跑只会报告"已存在"。
-- 写成循环而不是十段 `ALTER TABLE`，是因为**下一次改这张表的人只需要改一行数据**，
-- 而不是在一堆相似的语句里找哪一段漏了。
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('collaborators',       'collaborators_user_a_fkey',      'FOREIGN KEY ("user_a") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('collaborators',       'collaborators_user_b_fkey',      'FOREIGN KEY ("user_b") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('notifications',       'notifications_recipient_id_fkey','FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('notifications',       'notifications_sender_id_fkey',   'FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      -- 账本被删掉时通知消失；**账本只是被弃置时它还在**（弃置不是删除）。
      ('notifications',       'notifications_book_id_fkey',     'FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('notification_quota',  'notification_quota_user_id_fkey','FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE')
    ) AS t(tbl, name, definition)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', item.tbl, item.name, item.definition);
    END IF;
  END LOOP;
END $$;

-- "我的所有协作者"要按两个方向查（我可能是 a 也可能是 b），所以第二个方向也要索引；
-- 主键已经覆盖了第一个方向。
CREATE INDEX IF NOT EXISTS "collaborators_user_b_idx" ON "collaborators"("user_b");

-- 收件箱：按人取未决的、按时间倒序——这是铃铛每次都要跑的查询。
CREATE INDEX IF NOT EXISTS "notifications_recipient_status_idx"
  ON "notifications"("recipient_id", "status", "created_at");

-- 去重与撤销都要问"这个发件人对这个收件人、关于这本账，有没有一条还在等着的"。
CREATE INDEX IF NOT EXISTS "notifications_sender_recipient_book_idx"
  ON "notifications"("sender_id", "recipient_id", "book_id");
