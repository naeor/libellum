-- 值的历史，以及记在服务器上的冲突。
--
-- 两件事，都是所有者逐条确认过的设计：
--
-- 1. `value_history` —— 判断"设备报上来的值服务器见过没有"的依据。
--    "除非本地设备的值不在服务器的值的历史数据中（也就是本地 A，服务器 B 到 D，这种情况是冲突），
--     否则一律用服务器数据覆盖本地数据."
--
-- 2. 冲突存在服务器上，而不是每台设备各记各的：
--    "如果用户已经对这个冲突做了一次确认，那说明用户已经肯定这次账单的数值了；
--     此时没必要让用户在别的设备上再肯定一次."
--
-- ⚠️ 用 JSON 列而不是历史表：一笔账改 20 次就是 20 行，而这里唯一要回答的问题是
-- "这个值出现过没有" —— 一个列表一次读取就够，不需要 join。代价是不能按历史内容查询，而目前不需要。

ALTER TABLE "transactions"
  ADD COLUMN "value_history" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "transaction_conflicts" (
  "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
  "transaction_id" UUID        NOT NULL,
  "book_id"        UUID        NOT NULL,
  "field"          VARCHAR(32) NOT NULL,
  "server_value"   JSONB       NOT NULL,
  "claims"         JSONB       NOT NULL DEFAULT '[]',
  "history"        JSONB       NOT NULL DEFAULT '[]',
  "resolved_at"    TIMESTAMPTZ(6),
  "resolved_value" JSONB,
  "resolved_by"    VARCHAR(64),
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transaction_conflicts_pkey" PRIMARY KEY ("id")
);

-- 同步循环每次设备动作时都会查"这个账本还有没有没解决的冲突"。
CREATE INDEX "transaction_conflicts_book_id_resolved_at_idx"
  ON "transaction_conflicts"("book_id", "resolved_at");
CREATE INDEX "transaction_conflicts_transaction_id_idx"
  ON "transaction_conflicts"("transaction_id");

ALTER TABLE "transaction_conflicts"
  ADD CONSTRAINT "transaction_conflicts_transaction_id_fkey"
  FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 冲突解决之后，那张行会被删掉；这份记录留下来，回答"这笔账为什么自己变了"。
CREATE TABLE "conflict_resolutions" (
  "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
  "transaction_id" UUID        NOT NULL,
  "book_id"        UUID        NOT NULL,
  "field"          VARCHAR(32) NOT NULL,
  "server_value"   JSONB       NOT NULL,
  "claims"         JSONB       NOT NULL DEFAULT '[]',
  "resolved_value" JSONB       NOT NULL,
  "resolved_by"    VARCHAR(64) NOT NULL,
  "resolved_at"    TIMESTAMPTZ(6) NOT NULL,
  "raised_at"      TIMESTAMPTZ(6) NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conflict_resolutions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conflict_resolutions_book_id_resolved_at_idx"
  ON "conflict_resolutions"("book_id", "resolved_at");
CREATE INDEX "conflict_resolutions_transaction_id_idx"
  ON "conflict_resolutions"("transaction_id");