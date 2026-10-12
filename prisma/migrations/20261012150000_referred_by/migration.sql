-- S9 阶段四：次级邀请码——"是谁邀请我进来的"。
--
-- 所有者的规格，逐条对应到这一列：
--
-- | 规格 | 这一列怎么支撑它 |
-- |---|---|
-- | 次级码**不绑定任何账本** | 它不写任何账本相关字段；这一列只指向一个人 |
-- | 它只产生"**协作者关系**"的入口 | 7 天提醒说"你可以把他加为协作者"，关系仍由**对方同意**才成立 |
-- | 生成者可选"新用户能否**直接添加**他" | 决定要不要在注册时**创建那条提醒**（见代码） |
-- | 从注册日起 **7 天**内提醒 | 提醒的 `expires_at` 由这一列 + 注册时间算出 |
--
-- ⚠️ **为什么存在用户上，而不是只存在邀请码上。**
-- 邀请码记录的是"这张码被谁用了"，而**提醒是发给新账号的、面向一个具体的人**。
-- 每次打开协作者页面都要问"有没有一条还没处理的次级码提醒"，如果答案要靠
-- `registration_invites` 反查（`used_by_user_id = 我`），那就把"我的注册来源"
-- 这件**关于我的事实**存在了一张关于码的表里。
--
-- ⚠️ **可空，且已有账号保持 NULL**——迁移不改变任何现有账号的行为（他们没有被推荐过）。
--
-- ⚠️ **可重复执行**：`ADD COLUMN IF NOT EXISTS`，没有一条 DELETE。

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "referred_by_user_id" UUID;

-- ⚠️ `ON DELETE SET NULL`，不是 CASCADE：**邀请人注销账号，不该把被邀请人的账号带走**。
-- 关系断了（提醒不再有意义），但"我曾经是被谁邀请来的"这段事实留着——
-- 它与 `registration_invites.used_by_user_id` 互为印证，是审计账号来源的两条独立线索。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_referred_by_user_id_fkey') THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_referred_by_user_id_fkey"
      FOREIGN KEY ("referred_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
