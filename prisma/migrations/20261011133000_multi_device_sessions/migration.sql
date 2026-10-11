-- One account, many devices.
--
-- ⚠️ **The owner asked for this after a real test, and the restriction was actively
-- harming the feature being tested**: "我觉得是时候删除掉每个账号只能有一台设备登录的限制了；
-- 每个账号现在都应该可以被多台设备同时登录，而不会被踢掉."
--
-- What the restriction was: `sessions.user_id` carried a UNIQUE constraint, and
-- `POST /auth/login` used `upsert({ where: { userId } })` — so **signing in on one
-- device overwrote the session of every other device**, and the ones left behind
-- were "kicked out" the moment their next request was authenticated.
--
-- ⚠️ **Two devices on one account is the ordinary case, not an edge case.** The
-- offline design is built on it: a phone and a tablet each keep their own copy of
-- the ledger, each records what it cannot send, and **conflict detection exists
-- precisely because the two can diverge.** A rule that logs one of them out
-- **removes the ability to test — and to use — the feature it was interfering with.**
--
-- ⚠️ **Nothing about the security model depended on it.** A session is identified by
-- the hash of its own token, which is already unique; the constraint only limited
-- how many could exist. Revocation is per-token (`logout` deletes the row whose
-- token matches) and password changes still clear every session for the account,
-- which is where a single-device assumption would actually matter.
--
-- The index that replaces the constraint keeps the lookup by user fast — it is used
-- on every authenticated request, and dropping the constraint without it would leave
-- a sequential scan behind.

DROP INDEX IF EXISTS "sessions_user_id_key";

CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");