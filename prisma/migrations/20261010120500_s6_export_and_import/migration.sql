-- S6 step 1 (first half): a reference column for import, and a record of exports.
--
-- ⚠️ This migration exists in the directory again, but with a history worth
-- knowing. It was written, applied to `ledger_dev`, and then deleted from the
-- repository during the S6 step-one rollback (2026-10-10) — while the row
-- recording it in `_prisma_migrations` stayed behind. The result was a database
-- ahead of the schema and a migration directory missing one of its own
-- migrations.
--
-- It is restored **byte-identical to the SQL that was actually applied**, which
-- is why the constraints the schema now wants (reference format, known format)
-- are added by the following migration instead of by editing this one. Editing
-- an applied migration would invalidate its recorded checksum and silently make
-- every existing database irreproducible.
--
-- `source_ref` holds the identifier a row carried in the file it came from. It
-- is not the primary key: a file we did not produce does not get to choose our
-- keys. Uniqueness is scoped to the book, so the same file imported twice into
-- one book changes nothing, while importing it into a second book is not
-- blocked.
--
-- `export_logs` holds metadata only -- who, when, what range, how many, and a
-- file number the user can quote back. Never the rows, never the file.

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "source_ref" TEXT;

-- CreateTable
CREATE TABLE "export_logs" (
    "id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "format" VARCHAR(8) NOT NULL,
    "month_from" VARCHAR(7),
    "month_to" VARCHAR(7),
    "kind" "TransactionKind",
    "category_id" UUID,
    "currency" CHAR(3),
    "row_count" INTEGER NOT NULL,
    "file_ref" VARCHAR(32) NOT NULL,

    CONSTRAINT "export_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "export_logs_file_ref_key" ON "export_logs"("file_ref");

-- CreateIndex
CREATE INDEX "export_logs_book_id_created_at_idx" ON "export_logs"("book_id", "created_at");

-- AddForeignKey
ALTER TABLE "export_logs" ADD CONSTRAINT "export_logs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_logs" ADD CONSTRAINT "export_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
