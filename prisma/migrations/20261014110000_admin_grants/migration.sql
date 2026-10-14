-- Platform administration becomes an explicit, revocable grant.
--
-- ⚠️ **Why this migration exists.**
--
-- Before it, the project had **no administrator mechanism at all in the sense that
-- matters**: `users.is_admin` was written in two places and **read by no authorization
-- check anywhere** — no guard, no route, no query. It was a marker, not a permission.
-- And the one path that could set it at registration was worse than nothing: a
-- registration invite carrying `grants_admin = true` promoted whoever redeemed it,
-- and **98 such codes existed, never expiring, reserving account numbers
-- 10000002–10000099**. Those were the owner's printed first batch. Anyone holding one
-- of those cards could have become an administrator without anybody deciding so at
-- that moment.
--
-- So this migration does two things, and they belong together:
--
--   1. **creates `admin_grants`** — the authorization half of the admin check, a dated
--      and individually revocable record of "this account administers the platform";
--   2. **takes the privilege off the invite codes**, so that redeeming a code can never
--      again be the thing that grants administration.
--
-- ⚠️ **The grants are not inferred from the account number, and that is the same lesson
-- this project has already learned twice.** `20261010200000` fixed "a reserved number
-- implies an administrator"; inferring administration from "the number is in the first
-- hundred" would be the same mistake with a different column. The range is a
-- *qualification* — see `apps/api/src/admin/guard.ts` — and never a grant.
--
-- ⚠️ **No administrator is created by this migration.** The first grant is made by
-- `tools/grant-admin.mjs` against a named UUID, deliberately, and separately, so that
-- "who was made an administrator" is a decision with a moment attached to it rather
-- than a side effect of an upgrade. (Compare `20261010200000`, which *did* hard-code
-- `WHERE account_number = '10000000'` — the older style. That row is left exactly as it
-- is: this migration does not rewrite what earlier ones decided.)

-- ---------------------------------------------------------------------------
-- 1. The grant record
-- ---------------------------------------------------------------------------

CREATE TABLE "admin_grants" (
    "user_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by" VARCHAR(200) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" VARCHAR(200),
    "note" VARCHAR(500),

    CONSTRAINT "admin_grants_pkey" PRIMARY KEY ("user_id")
);

-- Revocation is the interesting question ("who currently holds this"), so it gets the
-- index. `revoked_at IS NULL` is the hot predicate in the guard.
CREATE INDEX "admin_grants_revoked_at_idx" ON "admin_grants"("revoked_at");

-- Deleting an account deletes its authorization, deliberately: a grant row pointing at
-- nobody is a privilege waiting for a UUID to be handed out again.
ALTER TABLE "admin_grants"
  ADD CONSTRAINT "admin_grants_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Take the privilege off the invite codes
-- ---------------------------------------------------------------------------
--
-- ⚠️ **The unused codes are cleared; the used ones and the reservations are not touched.**
-- Three separate facts live in this table and only one of them is going away:
--
--   * `account_number` — the reserved number. **Kept.** It is the whole point of the
--     batch: the numbers were printed on cards and are still the first-batch numbers.
--     Clearing them would lose a reservation that cannot be reconstructed.
--   * `used_by_user_id` / `revoked_at` — history. **Kept.**
--   * `grants_admin` — a promise that redeeming this code conferred administration.
--     **Cleared where the code has never been used**, because that promise is exactly
--     what must stop being true, and leaving it set would leave the database claiming
--     something the registration path no longer honours.
--
-- Used codes keep their value: they are a record of what happened, and the accounts they
-- created are not affected either way — `users.is_admin` is not derived from this column
-- and nothing here re-reads it.
UPDATE "registration_invites"
   SET "grants_admin" = false
 WHERE "grants_admin" = true
   AND "used_by_user_id" IS NULL;
