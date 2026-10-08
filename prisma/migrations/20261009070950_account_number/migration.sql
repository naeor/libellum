-- Add the public account number to existing accounts.
--
-- This runs against a database that already holds real accounts, so the column
-- cannot simply be added as NOT NULL: PostgreSQL has no value to put into the
-- existing rows. The safe order is nullable -> backfill -> constrain.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "account_number" TEXT;

-- Backfill: derive a distinct identifier from each row's own id, so the
-- statement is idempotent and every existing account keeps working.
UPDATE "users"
SET "account_number" = 'LB-'
    || upper(substr(md5("id"::text), 1, 4))
    || '-'
    || upper(substr(md5("id"::text), 5, 4))
WHERE "account_number" IS NULL;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "account_number" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_account_number_key" ON "users"("account_number");
