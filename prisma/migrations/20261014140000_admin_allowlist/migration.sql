-- The second half of the admin check becomes a genuinely separate fact.
--
-- ⚠️ **What was wrong, stated plainly.**
--
-- `20261014110000_admin_grants` introduced two checks that were meant to be independent:
-- an authorization (a grant row) and an allow-list membership. But the allow-list half was
-- **derived from the same table it was supposed to be independent of** — it answered
-- "is this account granted *and* first-batch?" — so the two could never disagree. One grant
-- satisfied both halves. The owner's words:
--
--   *"授权记录和允许名单并没有完全分离……如果未来误将另一个合格账号加入 admin_grants，
--    在默认的 first-batch 范围下，它可能同时通过所谓的两重检查。"*
--
-- That is exactly right, and it is not a theoretical worry: a mis-typed UUID in one command
-- would have produced a working administrator, while the guard reported two checks passed.
--
-- ⚠️ **Why this is a table and not an environment variable.**
--
-- A list in server configuration would be independent too, and it has one real advantage:
-- nothing an API can reach. It was considered and not chosen, for three reasons that are
-- about this project rather than about security in the abstract:
--
--   * **This project keeps its state in PostgreSQL.** A second configuration mechanism means
--     two places to look, two formats to get right, and two ways to be wrong — and the local
--     development environment is Windows while production is Linux, which is exactly where
--     two formats drift apart.
--   * **Changing the list must not require a restart**, because the case that matters is
--     *"remove this account now"*. With a table the next request is enough; with an
--     environment variable a container restart is part of the incident response.
--   * **It is auditable.** Who listed the account, when, and why, is a row. The brief asks
--     the allow list to be individually revocable and to say *"normal Prisma migration,
--     separate grant/revoke tooling"*.
--
-- ⚠️ **The table is created empty, and that is deliberate.**
--
-- *"防止迁移自动授予任何账号"* — a migration that listed an account would be a privilege
-- granted by a deployment, at a moment when nobody was deciding anything. The first entry is
-- written by `pnpm admin:allow <uuid> --by <operator>` against a named UUID.
--
-- ⚠️ **Nothing here derives from or writes to `admin_grants`.** The two tables are populated
-- by two different commands, and neither command touches the other table. `admin:grant` does
-- not list; `admin:allow` does not grant. An operator has to mean both, which is the entire
-- point of asking twice.

CREATE TABLE "admin_allowlist" (
    "user_id" UUID NOT NULL,
    "listed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "listed_by" VARCHAR(200) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" VARCHAR(200),
    "note" VARCHAR(500),

    CONSTRAINT "admin_allowlist_pkey" PRIMARY KEY ("user_id")
);

-- Removal is the operation that happens under time pressure ("is this account still
-- permitted?"), so the unrevoked rows get the index.
CREATE INDEX "admin_allowlist_revoked_at_idx" ON "admin_allowlist"("revoked_at");

-- Deriving the list from the grants table is precisely what this migration stops doing, but a
-- listing still has to name a real account: a UUID that matches nobody is a permission
-- waiting for the UUID to be handed out again.
ALTER TABLE "admin_allowlist"
  ADD CONSTRAINT "admin_allowlist_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
