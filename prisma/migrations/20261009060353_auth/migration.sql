-- DropIndex
DROP INDEX "sessions_user_id_idx";

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "recovery_code_hash" TEXT,
ADD COLUMN     "recovery_code_used_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "registration_invites" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "used_by_user_id" UUID,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "registration_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "registration_invites_code_key" ON "registration_invites"("code");

-- CreateIndex
CREATE UNIQUE INDEX "registration_invites_used_by_user_id_key" ON "registration_invites"("used_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_user_id_key" ON "sessions"("user_id");

-- AddForeignKey
ALTER TABLE "registration_invites" ADD CONSTRAINT "registration_invites_used_by_user_id_fkey" FOREIGN KEY ("used_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
