-- S6 step 1: provenance for import and export.
--
-- Four things, and each one answers a question somebody will actually ask:
--
--   transactions.source_ref   "this row came from a file that carried this
--                              value" (one we minted on export, or a
--                              stranger's identifier)
--   transactions.import_ref   "this row arrived in the In-… import run"
--   export_logs               what left this book, when, how much, and the
--                              Out-… reference the user can quote back
--   import_logs               what arrived, and how much of it was already here
--
-- Uniqueness for source_ref is scoped to the book, never global: the same file
-- imported twice into one book changes nothing, while importing it into a
-- second book is not blocked. Both prefixes are enforced by CHECK constraints
-- rather than by convention, so a reference that cannot be traced cannot be
-- written in the first place.
--
-- ⚠️ Read this before editing the statements below.
--
-- The `export_logs` table was already created by `20261010120500_s6_export_and_import`,
-- a migration that was applied to the development database and then deleted
-- from the repository during the step-one rollback. That migration is therefore
-- gone from `prisma/migrations`, which makes the migration history here
-- inconsistent with every database in existence: a fresh database has no
-- `export_logs` and no `source_ref`, while `ledger_dev` has both.
--
-- This migration is written to be the honest half of that pair. It assumes the
-- earlier one is still in the directory (it is being restored, byte-identical
-- to what was applied) and adds what that one did not have. It is deliberately
-- **not** idempotent: guarded DDL hides exactly the drift that caused the
-- trouble in the first place.

-- ---------------------------------------------------------------------------
-- Transactions: the two reference columns, and the rule that makes re-imports
-- harmless.
-- ---------------------------------------------------------------------------

-- The column the old migration left on TEXT, narrowed to the width the schema
-- declares, plus the two the rollback removed entirely.
ALTER TABLE "transactions"
  ALTER COLUMN "source_ref" SET DATA TYPE VARCHAR(64),
  ADD COLUMN "import_ref" VARCHAR(32);

-- One source row per book. NULLs are distinct in PostgreSQL, so any number of
-- hand-typed entries can sit here with no source reference at all.
CREATE UNIQUE INDEX "transactions_book_id_source_ref_key"
  ON "transactions"("book_id", "source_ref");

CREATE INDEX "transactions_book_id_import_ref_idx"
  ON "transactions"("book_id", "import_ref");

-- A row can only carry an In-… reference of the shape we mint, and never
-- anything else. Cheap, and it means a typo cannot quietly create a reference
-- that looks traceable but is not.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_ref_format"
  CHECK ("import_ref" IS NULL OR "import_ref" ~ '^In-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$');

-- ---------------------------------------------------------------------------
-- Export log: metadata only. No rows, no file.
-- ---------------------------------------------------------------------------

-- The old migration created this table without the two rules that make its
-- references trustworthy, so they are added here.
ALTER TABLE "export_logs" ADD CONSTRAINT "export_logs_file_ref_format"
  CHECK ("file_ref" ~ '^Out-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$');

ALTER TABLE "export_logs" ADD CONSTRAINT "export_logs_format_known"
  CHECK ("format" IN ('csv', 'xlsx'));

-- ---------------------------------------------------------------------------
-- Import log: the same idea in the other direction, plus the counts that make
-- "the file said 200 rows and my ledger grew by 187" answerable.
-- ---------------------------------------------------------------------------

CREATE TABLE "import_logs" (
    "id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "format" VARCHAR(8) NOT NULL,
    "file_ref" VARCHAR(32) NOT NULL,
    "exported_file_ref" VARCHAR(32),
    "source_fingerprint" VARCHAR(64) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "imported_count" INTEGER NOT NULL,
    "skipped_count" INTEGER NOT NULL,

    CONSTRAINT "import_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "import_logs_file_ref_key" ON "import_logs"("file_ref");

CREATE INDEX "import_logs_book_id_created_at_idx" ON "import_logs"("book_id", "created_at");

ALTER TABLE "import_logs" ADD CONSTRAINT "import_logs_book_id_fkey"
  FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "import_logs" ADD CONSTRAINT "import_logs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "import_logs" ADD CONSTRAINT "import_logs_file_ref_format"
  CHECK ("file_ref" ~ '^In-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$');

-- When a file turns out to be one of our own exports, its Out-… reference is
-- recorded here — that is what lets the UI say "this is the file you exported
-- on 10 October" instead of guessing.
ALTER TABLE "import_logs" ADD CONSTRAINT "import_logs_exported_ref_format"
  CHECK ("exported_file_ref" IS NULL
         OR "exported_file_ref" ~ '^Out-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$');

ALTER TABLE "import_logs" ADD CONSTRAINT "import_logs_format_known"
  CHECK ("format" IN ('csv'));

-- The three counts have to add up; they are what the report is built from.
ALTER TABLE "import_logs" ADD CONSTRAINT "import_logs_counts_add_up"
  CHECK ("imported_count" + "skipped_count" <= "row_count");
