-- S11 第一阶段：彻底移除**账号级协作者**系统。
--
-- 所有者 2026-10-13 的正式决定：
--
-- > "**不再要求用户先发送「添加协作者申请」、等待对方同意，然后才能发送账本邀请。**"
-- >
-- > "**请求把当前账本中有权限的用户统一称为「成员」。**"
-- >
-- > "**允许彻底废弃旧账号级协作者系统**……项目目前尚未公开上线，现有数据均属于开发及测试用途。"
--
-- 所以这不是"把旧系统藏起来"，而是**真的删掉它**——所有者点名要求：
-- *"这次应当真正消除旧的双重确认流程，而不只是把旧协作者系统隐藏起来。"*
--
-- ⚠️ **一条账号级协作者关系从来不授予任何账本权限**（权限只来自 `book_members`），
-- 所以删掉这张表**不会改变任何人能看到哪本账**。这正是它可以直接删的原因。
--
-- ⚠️ **但它会被"顺手"当成邀请的前置条件**——而新的模型里，账本就像群聊：
-- **邀请属于账本，不需要先在账号层面建立关系。**
--
-- ⚠️ **本迁移不碰任何真正的业务数据**：账本、账目、`book_members`（正式成员）、
-- 编辑历史、留言**一行都不动**。它只删两类东西：
--   1. `collaborators` 表（账号级关系本身）；
--   2. `registration_invites.allows_direct_collaborator`（那个开关随着它描述的功能一起消失）。
--
-- ⚠️ **历史通知只清一种**：`collaborator_request`。**目标是"不要让用户收到一条点开也完不成的通知"**，
-- 而不是清理通知表——`book_invite` 与 `referral_reminder` **保持原样**（前者仍然有效；
-- 后者只是措辞过时，而一条已经发出、已经读过的通知不该被事后改动）。
--
-- ⚠️ **可重复执行**：全部语句都有存在性守卫。重跑不会报错，也不会第二次删东西
-- ——这很重要，因为"清理"这类迁移一旦被重放而语义变了，就是一次没有理由的数据损失
-- （`教训.md` §1.4）。

-- ---------------------------------------------------------------------------
-- 1) 账号级协作者关系
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.collaborators') IS NOT NULL THEN
    -- 外键与索引随表一起消失；两个 CHECK 约束也在表上，无需单独 DROP。
    DROP TABLE "collaborators";
    RAISE NOTICE '已删除表 collaborators（账号级协作者关系）';
  ELSE
    RAISE NOTICE '表 collaborators 不存在，跳过（迁移已执行过）';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) 次级邀请码上的"允许直接加为协作者"开关
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'registration_invites' AND column_name = 'allows_direct_collaborator'
  ) THEN
    ALTER TABLE "registration_invites" DROP COLUMN "allows_direct_collaborator";
    RAISE NOTICE '已删除 registration_invites.allows_direct_collaborator';
  ELSE
    RAISE NOTICE '列 allows_direct_collaborator 不存在，跳过';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) 旧的协作者申请通知 —— 只删"还没被处理"的那些
-- ---------------------------------------------------------------------------
--
-- ⚠️ **只删 pending。** 一条已经同意或拒绝的 `collaborator_request` 是**历史记录**：
-- 它记着当时发生过什么，而删掉它就是在改写历史（`教训.md` —— 历史不改写）。
-- 真正有害的是**还挂着、点开却完成不了**的那一条，也就是 pending 的那些。

DO $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM "notifications"
  WHERE kind = 'collaborator_request'
    AND status = 'pending';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE '已删除 % 条未处理的 collaborator_request 通知（已决定的历史通知保留）', removed;
END $$;
