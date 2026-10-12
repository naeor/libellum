-- S9 阶段四：次级邀请码要知道"是谁生成的"。
--
-- ⚠️ **为什么加这一列。** 次级邀请码的规格（所有者定的）是：
-- **不绑定任何账本**，它只产生"协作者关系"的入口；生成者可以选择"新用户注册后能否直接添加他"；
-- 注册当天起 7 天内提醒新用户。
--
-- 这三件事都需要**知道码是谁生成的**：
--   1. 没有生成者，注册之后没有任何东西可以提醒新用户去添加谁；
--   2. 没有生成者，就无法建立那条协作者关系；
--   3. 没有生成者，"他能加到谁"这个问题的答案不存在。
--
-- ⚠️ **注册码之前是匿名的，这是设计。** 批量生成的注册码只是一张门票，
-- **谁生成的这段关系并不重要**。次级邀请码不一样：**它本身是一段邀请关系的载体**，
-- 所以生成者是它的必要组成，而不是可选的附加信息。
--
-- ⚠️ **已有行保持 NULL**，所以这次迁移对现存的码**没有任何行为影响**：
-- 读到 NULL 就当作"没有生成者"，也就是"这不是一张次级码"——
-- 与今天完全一致。**迁移不改变旧数据的语义**，这条规矩在前几次迁移里都写明了。
--
-- ⚠️ **可重复执行**：`ADD COLUMN IF NOT EXISTS` 幂等，没有一条 DELETE。

ALTER TABLE "registration_invites"
  ADD COLUMN IF NOT EXISTS "created_by_user_id" UUID;

-- ---------------------------------------------------------------------------
-- 外键（幂等：存在就跳过）
-- ---------------------------------------------------------------------------
--
-- ⚠️ `ON DELETE SET NULL`，不是 CASCADE：**生成者注销账号，不应该把别人用过的邀请码删掉**。
-- 那张码是新账号**存在的凭证**——删了它，审计新账号"是怎么来的"就失去了依据。
-- 关系断了（协作者加不成），但历史留着。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'registration_invites_created_by_user_id_fkey') THEN
    ALTER TABLE "registration_invites"
      ADD CONSTRAINT "registration_invites_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ⚠️ **"这个人发出过哪些次级码"** —— 协作者页面与配额统计都要问，所以要索引。
CREATE INDEX IF NOT EXISTS "registration_invites_created_by_idx"
  ON "registration_invites"("created_by_user_id")
  WHERE "created_by_user_id" IS NOT NULL;
