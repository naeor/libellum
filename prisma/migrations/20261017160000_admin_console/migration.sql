-- S13 · 线上管理机制 —— 三处**纯加法**的 schema 变更。
--
-- ⚠️ **全部是加法**（新表 + 可空列），所以**应用回滚不需要回滚这个迁移**：
-- 旧代码不认识这三样东西，也不会因为它们存在而出错。
-- 这是发布纪律的一部分（运维手册 §9：迁移只向前）。

-- ---------------------------------------------------------------------------
-- 1. admin_audit_logs —— 管理操作审计
-- ---------------------------------------------------------------------------
--
-- 字段在 2026-10-14 就已经定好（`管理员与权限边界-设计决定.md` §9.4），
-- 当时明确"没有实际管理员操作就不必为预留而增加复杂的空表和后台页面"。
-- **2026-10-16 第一次真实的管理操作发生了**（生产上 grant + allow），
-- 而 S13 要给管理操作一个界面 —— 所以这张表现在建，**并且从第一天就有写入者**。
--
-- ⚠️ **没有指向 `users` 的外键。** 审计记录必须活得比它描述的那个账号久；
-- `admin_username` 是当时的快照（与 `transaction_events.actor_name` 同一个理由）。
--
-- ⚠️ **这里永远不存凭据**：密码、会话 cookie、恢复码、邀请码明文，全都不进这张表。
CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "admin_username" VARCHAR(64) NOT NULL,
    "action" VARCHAR(48) NOT NULL,
    "target" VARCHAR(200),
    "outcome" VARCHAR(16) NOT NULL,
    "detail" JSONB,
    "request_id" VARCHAR(64),
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- 这张表只服务一个查询："最近发生了什么，从新到旧"。
CREATE INDEX "admin_audit_logs_at_idx" ON "admin_audit_logs"("at" DESC);

-- ---------------------------------------------------------------------------
-- 2. users.disabled_at / disabled_by —— 账号停用
-- ---------------------------------------------------------------------------
--
-- 所有者 2026-10-17 的要求：*"在停用账户的一瞬间，服务器会把账户上的所有登录设备都踢出去，
-- 然后服务器把对应账户标记为停用状态。停用状态的账户没法被登录"*。
--
-- ⚠️ **停用不是删除。** 账本、流水、历史全部保留 —— 停用一个人和销毁他的记录是两个决定。
-- ⚠️ **用时间戳而不是布尔值**，与 `registration_invites.revoked_at` 同一个理由：
-- 记录要能回答"什么时候"，布尔值把这个事实丢掉了。
-- ⚠️ **两列都可空**，所以 `ADD COLUMN` 是安全的加法：既有账号默认"未停用"。
ALTER TABLE "users" ADD COLUMN "disabled_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN "disabled_by" VARCHAR(200);

-- ---------------------------------------------------------------------------
-- 3. backup_logs —— 概览页的"上次备份"
-- ---------------------------------------------------------------------------
--
-- 所有者要求管理概览显示"上次备份时间"。而 `backup.sh` 把 .dump 写到**宿主机**
-- （`deploy/backups/`），**API 跑在容器里看不见那个目录**。
-- 给容器挂载宿主机目录会为了一个数字扩大容器能读到的范围；一行写进数据库
-- 则可见、可追溯、且不新增任何访问权限。
--
-- ⚠️ **写入者还没接上** —— 这是所有者明确说的"备份的事待会再说"。
-- 在 `backup.sh` 写第一行之前，概览会**老实显示"还没有记录"**，而不是假装有备份。
CREATE TABLE "backup_logs" (
    "id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "file_ref" VARCHAR(300),
    "note" VARCHAR(500),

    CONSTRAINT "backup_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "backup_logs_started_at_idx" ON "backup_logs"("started_at" DESC);
