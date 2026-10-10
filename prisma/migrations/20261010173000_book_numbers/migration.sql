-- Ledgers get their own public number, in a block of their own.
--
-- The owner's decisions (2026-10-10): every ledger carries an eight-digit number
-- the way every account does, the block starts at 40000000 so the two kinds of
-- number are never confused at a glance, and his own ledger takes the first one.
--
-- Like account numbers, this runs on a server-owned counter rather than on
-- randomness, because a number that is decided in one atomic statement cannot be
-- handed to two ledgers. Unlike account numbers it is **not searchable**: a
-- ledger is joined by invitation, so the number is a label, not an address.

ALTER TABLE "books" ADD COLUMN "book_number" VARCHAR(8);

CREATE UNIQUE INDEX "books_book_number_key" ON "books"("book_number");

-- Either absent (only possible for a row that predates this migration) or a
-- valid eight-digit number. The format is the database's business, not only the
-- application's — the same rule `users.account_number` already carries.
ALTER TABLE "books" ADD CONSTRAINT "books_book_number_eight_digits"
  CHECK ("book_number" IS NULL OR "book_number" ~ '^[0-9]{8}$');

-- ---------------------------------------------------------------------------
-- Number the ledgers that already exist
-- ---------------------------------------------------------------------------
--
-- Ordered by **creator's account number**, so the owner's ledger is 40000000 and
-- the next account's is 40000001 — which is what he asked for, and which also
-- makes the numbers reproducible: running this on the same data twice gives the
-- same answer, so a re-run cannot shuffle anybody's ledger.
--
-- Ordering by `created_at` would have been the obvious choice and gives the same
-- result today. It is not used because account number *is* the owner's stated
-- ordering ("最前面的是我的帐本"), stated once, in the data.

WITH ordered AS (
  SELECT b."id",
         (40000000 + ROW_NUMBER() OVER (ORDER BY u."account_number", b."created_at", b."id") - 1)::text AS number
  FROM "books" AS b
  JOIN "users" AS u ON u."id" = b."created_by"
)
UPDATE "books" AS b
SET "book_number" = ordered.number
FROM ordered
WHERE b."id" = ordered."id";

-- ---------------------------------------------------------------------------
-- Seed the counter
-- ---------------------------------------------------------------------------
--
-- Above the numbers just handed out, so the next ledger created continues the
-- series instead of colliding with an existing one.
--
-- The value is computed rather than written down as a literal: the migration
-- must be correct whatever the database already contained, and hard-coding
-- `40000002` would be wrong on any server that had more than two ledgers.

INSERT INTO "counters" ("name", "next")
SELECT 'book_number', COALESCE(MAX("book_number"::int), 39999999) + 1
FROM "books";
