-- S9 阶段四：分享链接与次级邀请码。
--
-- 两件事，所有者都给了明确规格：
--
-- | 功能 | 规格 |
-- |---|---|
-- | 分享链接 | **只存哈希**；可撤销；可重新生成（旧的自动失效）；**不占通知配额** |
-- | 次级邀请码 | **不绑定任何账本**；只产生"协作者关系"的入口；生成者可选"新用户能否直接添加他"；注册当天起 7 天提醒 |
--
-- ⚠️ **可重复执行**（与前两次同样的要求）：`ADD COLUMN IF NOT EXISTS`、
-- `CREATE TABLE IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`，**没有一条 DELETE**。

-- ---------------------------------------------------------------------------
-- 1. 分享链接：`book_share_links`
-- ---------------------------------------------------------------------------
--
-- ⚠️ **只存哈希，永远不存明文。** 链接的明文只在"生成"那一次返回给生成者，之后服务端
-- **再也拿不到它**——所以即使数据库被完整读走，也不能用它打开别人的账本。
-- 这与恢复码、会话令牌是同一条规矩。
--
-- ⚠️ **哈希不需要加盐、不需要慢哈希。** 令牌是**服务端生成的 256 位随机值**，
-- 不是人选的密码——没有字典可以猜，所以慢哈希只会让每次打开链接都变慢。
-- 这与 `password_hash` 的处境正好相反（那个必须慢），理由写在
-- `auth/` 里，两者不能互换。
--
-- ⚠️ **一行一条链接，而不是一行一本账。** 所有者要求"可以撤销"并且"可以重新生成，
-- 旧的自动失效"——这两件事都要求**同一本账同时存在多条链接**（旧的已撤销、新的生效中），
-- 用一本书一行的写法做不到，除非再加一张历史表。

CREATE TABLE IF NOT EXISTS "book_share_links" (
  "id"         UUID          NOT NULL DEFAULT gen_random_uuid(),
  -- ⚠️ 存哈希，列名就说清楚，避免有人后来往这一列塞明文。
  "token_hash" VARCHAR(64)   NOT NULL,
  "book_id"    UUID          NOT NULL,
  "created_by" UUID          NOT NULL,
  -- 用链接加入的人拿到什么权限：所有者明确的 "viewer 或 editor"。
  "role"       VARCHAR(16)   NOT NULL DEFAULT 'viewer',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 可空＝仍然有效；非空＝已撤销，**且保留是谁、什么时候撤销的**。
  "revoked_at" TIMESTAMPTZ(6),
  "revoked_by" UUID,
  -- 只增不减的使用计数，用来让生成者看见"这条链接被用过几次"。
  "use_count"  INTEGER       NOT NULL DEFAULT 0,
  "last_used_at" TIMESTAMPTZ(6),
  CONSTRAINT "book_share_links_pkey" PRIMARY KEY ("id"),
  -- ⚠️ 哈希唯一：两条链接撞上同一个哈希意味着一条能打开另一条的账本。
  CONSTRAINT "book_share_links_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "book_share_links_role_known" CHECK ("role" IN ('editor', 'viewer')),
  CONSTRAINT "book_share_links_use_count_non_negative" CHECK ("use_count" >= 0)
);

-- ⚠️ **撤销是"能重新生成"的前提，所以按账本查有效链接必须走索引**：
-- 每次打开一条链接都要问"这个哈希对应哪一本账、还在不在有效期"。
CREATE INDEX IF NOT EXISTS "book_share_links_book_active_idx"
  ON "book_share_links"("book_id", "revoked_at");

-- ---------------------------------------------------------------------------
-- 2. 次级邀请码：`registration_invites` 加一列
-- ---------------------------------------------------------------------------
--
-- ⚠️ **这一列表述的是"生成者的选择"，而不是"新用户的权限"。**
-- 所有者的原话：次级码的生成者**可以选择**"新用户注册后能否直接添加他为协作者"。
-- 这个选择在**生成邀请码那一刻**就定下来，所以要存在码上，而不是存在用户上——
-- 同一个人可能生成多张码，而每张可以是不同的选择。
--
-- ⚠️ 默认 `false`（不能直接添加）。**默认值选"更保守的那个"**：一个忘了设置的码
-- 不会让陌生人一键成为协作者的入口，而生成者想放开时只要勾一下。
--
-- ⚠️ 账本列保持为空是**设计**，不是遗漏：所有者的规格是
-- **"次级邀请码不与任何账本绑定"**。用码加入的人得到的只是"协作者关系的入口"，
-- 想进某本账要另走账本邀请——那一步仍然需要双方同意。

ALTER TABLE "registration_invites"
  ADD COLUMN IF NOT EXISTS "allows_direct_collaborator" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 外键（幂等：存在就跳过）
-- ---------------------------------------------------------------------------
--
-- ⚠️ 与上一版同一份循环写法。**漏掉外键不会立刻出错**——只是账本被删掉之后留下一堆
-- 指向不存在账本的链接，而那些链接的 `token_hash` 仍然唯一、仍然"有效"。
-- 这类缺陷在删除操作真的发生之前完全看不见。

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('book_share_links', 'book_share_links_book_id_fkey',       'FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('book_share_links', 'book_share_links_created_by_fkey',    'FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      -- 撤销者被删除时置空，而不是删掉链接：**链接的历史不该因为撤销的人注销而消失**。
      ('book_share_links', 'book_share_links_revoked_by_fkey',    'FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE')
    ) AS t(tbl, name, definition)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', item.tbl, item.name, item.definition);
    END IF;
  END LOOP;
END $$;
