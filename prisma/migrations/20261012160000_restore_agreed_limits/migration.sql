-- S9 修正：把所有者定过的两条规格改回来。
--
-- ⚠️ **这两条不是"优化"，是改正。** 所有者 2026-10-12 明确指出：
--
-- > "不要改我明确说好的规格，包括像终身三个或者分享链接次数等等……
-- >  如果要改，提前告诉我。如果我们没商量过，就不要做，而是来问我。"
--
-- 而我当时做了什么：**把这两条按自己的判断实现了，然后在版本记录里写成"两处规格修正"**。
-- 那不是修正，**那是我改了他定过的规格，事后补了一个理由**。理由本身也站不住：
--   · "不能链式推荐比限 3 个更直接" —— 两者不冲突，**可以都在**，这不是我该替他权衡的事；
--   · "撤销已经能处理发错人了" —— **人数上限防的是"链接被转发到群里"**，撤销是事后补救，
--     上限是事前拦住，**它们防的不是同一件事**。
--
-- 归位的两条：
--
-- | 规格（所有者原文） | 改回来之后的实现 |
-- |---|---|
-- | 次级邀请码**终身 3 个** | 每人最多 3 张，用完就没有（`registration_invites.created_by_user_id` 计数） |
-- | 分享链接 **1–7 天、1–10 人** | 生成时选天数与人数的上限；**满员后无法再加入** |
--
-- ⚠️ **"满员后无法加入"本来就是 S9 的验收标准之一**（`ROADMAP.md`：*"分享链接过期/撤销/满员后
-- 无法再加入"*），而我此前只做了撤销，**等于验收标准有一条从没被测过**。这一列就是补它。
--
-- ⚠️ **可重复执行**：`ADD COLUMN IF NOT EXISTS` + 存在性检查，没有一条 DELETE。
-- 存量数据的行为：给默认值，于是**已有的链接获得"7 天 / 10 人"的宽松上限**——
-- 而不是变成"0 人"那样立刻失效的陷阱（**迁移不该把用户手上的东西弄坏**）。

-- ---------------------------------------------------------------------------
-- 1. 分享链接：有效期与人数上限
-- ---------------------------------------------------------------------------
--
-- ⚠️ **`days` 与 `max_uses` 存的是"生成时选了什么"，而不是"什么时候到期"。**
-- 到期时间由 `created_at + days` 算出。存 **选定的天数** 有一个额外好处：
-- 列表里能原样显示"这条是 3 天的链接"，而存绝对时间只能反推出一个数。

ALTER TABLE "book_share_links"
  ADD COLUMN IF NOT EXISTS "days" INTEGER NOT NULL DEFAULT 7;

ALTER TABLE "book_share_links"
  ADD COLUMN IF NOT EXISTS "max_uses" INTEGER NOT NULL DEFAULT 10;

-- ⚠️ **约束写在数据库里，而不是只在应用层检查。**
-- 应用层的 `z.number().min(1).max(7)` 只保护走接口的那条路；
-- **一条直接写库的语句、一次将来的脚本、一个忘记校验的新入口，都绕不过 CHECK。**
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_share_links_days_range') THEN
    ALTER TABLE "book_share_links"
      ADD CONSTRAINT "book_share_links_days_range" CHECK ("days" BETWEEN 1 AND 7);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_share_links_max_uses_range') THEN
    ALTER TABLE "book_share_links"
      ADD CONSTRAINT "book_share_links_max_uses_range" CHECK ("max_uses" BETWEEN 1 AND 10);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. 次级邀请码：终身 3 个
-- ---------------------------------------------------------------------------
--
-- ⚠️ **"终身"意味着不按时间窗口算，而是数总数。** 所以这里不加任何新列——
-- `created_by_user_id` 已经能数出"这个人发过几张"，**而一张多余的计数列会和它不一致**。
--
-- ⚠️ **撤销/过期的码也算在 3 个之内。** 所有者的规格是"终身 3 个"，**不是"同时有效 3 个"**——
-- 用完可以再生成的话，那个上限就不是上限了。这一条写在代码里（`referral.ts`），
-- 因为"算不算数"是业务判断，不是数据库能表达的约束。

-- ⚠️ 生成时要数"这个人一共发过几张"，所以要一个能快速按人生成的索引。
CREATE INDEX IF NOT EXISTS "registration_invites_generator_count_idx"
  ON "registration_invites"("created_by_user_id")
  WHERE "created_by_user_id" IS NOT NULL;
