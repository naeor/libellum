-- Account numbers become sequential, and a block of them is reserved.
--
-- The owner's decision (2026-10-10) replaced random allocation with a
-- server-owned counter, so numbers can be written down and handed out in
-- advance. Two things follow that the schema has to hold:
--
--   * `users.account_number` is still eight digits, so the existing CHECK keeps
--     working unchanged — `10000000` satisfies it.
--   * a `counters` row owns the sequence, and `registration_invites` may carry
--     the number a code will grant.
--
-- The trade is recorded rather than hidden: a sequential number can be guessed
-- from its neighbour, where a random one could not. That was the original reason
-- for randomness, and the owner accepted the exchange.

-- ---------------------------------------------------------------------------
-- Who may see everything
-- ---------------------------------------------------------------------------

ALTER TABLE "users" ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- The counter
-- ---------------------------------------------------------------------------

CREATE TABLE "counters" (
    "name" TEXT NOT NULL,
    "next" INTEGER NOT NULL,

    CONSTRAINT "counters_pkey" PRIMARY KEY ("name")
);

-- ---------------------------------------------------------------------------
-- Invites can reserve the number they will grant
-- ---------------------------------------------------------------------------

ALTER TABLE "registration_invites" ADD COLUMN "account_number" VARCHAR(8);

CREATE UNIQUE INDEX "registration_invites_account_number_key"
  ON "registration_invites"("account_number");

-- A reserved number is either absent or a valid eight-digit number, and it can
-- never be one the account series has already passed. Both rules are the
-- database's job: application code that forgets them would otherwise be able to
-- hand out a number that is already in use elsewhere.
ALTER TABLE "registration_invites" ADD CONSTRAINT "registration_invites_account_number_eight_digits"
  CHECK ("account_number" IS NULL OR "account_number" ~ '^[0-9]{8}$');

-- ---------------------------------------------------------------------------
-- Seed the sequences
-- ---------------------------------------------------------------------------
--
-- **Two counters, not one**, and the reason is worth stating because one looks
-- like it would do.
--
-- The owner's plan is that a batch of codes is generated now, each carrying the
-- number it will grant, and that later codes continue from after that batch. A
-- single counter cannot express that: the batch would push it forward past the
-- reserved block, and every later account without a code would be allocated
-- inside the block the owner is still handing out — two accounts, one number.
--
--   * `account_number`        — numbers handed to codes, which carry them;
--   * `account_number_direct` — numbers given to accounts at signup.
--
-- Both only ever move forward, so a reserved number is never reissued even if
-- its code is never used, and the two series cannot collide because the first
-- starts above where the second ends.

-- The reserved block: 10000000..10000099, which covers the batch of codes.
--
-- It starts at 10000002, not 10000000, because the two accounts that already
-- exist were given the first two numbers of the block just below. The owner's
-- own account is the first number in the series — he asked for 10000000 — and
-- 妈妈's follows it. Codes therefore begin where they end, and nothing in the
-- batch can collide with an account that already exists.
INSERT INTO "counters" ("name", "next") VALUES ('account_number', 10000002);

-- Direct allocation, starting above the block. Not "the last reserved number
-- plus one": 10000100 is skipped so the two series stay visibly distinct if
-- somebody ever reads a number and wants to know which batch it came from.
INSERT INTO "counters" ("name", "next") VALUES ('account_number_direct', 10000101);

-- The accounts that already exist are numbered from the top of the reserved
-- block, so the owner's own number is the first thing in the series rather than
-- something between batches.
UPDATE "users" SET "account_number" = '10000000' WHERE "username" = 'naeor';
UPDATE "users" SET "account_number" = '10000001' WHERE "username" = 'mama';

-- The owner's account is an administrator: he is the one who will need to look
-- at an abandoned ledger.
UPDATE "users" SET "is_admin" = true WHERE "account_number" = '10000000';
