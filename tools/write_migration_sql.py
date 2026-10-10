"""Write the migration SQL cleanly.

The first attempt piped PowerShell's own error output into the file, so the
migration began with a BOM and an error message and PostgreSQL refused it. The
SQL itself was correct; only its surroundings were not.
"""

from __future__ import annotations

import io
import os

DIR = os.path.join(
    r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1",
    "prisma",
    "migrations",
    "20261010120500_s6_export_and_import",
)

SQL = """-- S6 step 1: a reference column for import, and a record of exports.
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
CREATE UNIQUE INDEX "transactions_book_id_source_ref_key" ON "transactions"("book_id", "source_ref");

-- CreateIndex
CREATE UNIQUE INDEX "export_logs_file_ref_key" ON "export_logs"("file_ref");

-- CreateIndex
CREATE INDEX "export_logs_book_id_created_at_idx" ON "export_logs"("book_id", "created_at");

-- AddForeignKey
ALTER TABLE "export_logs" ADD CONSTRAINT "export_logs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_logs" ADD CONSTRAINT "export_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
"""


def main() -> None:
    path = os.path.join(DIR, "migration.sql")

    # utf-8-sig on the way in, so a BOM left by PowerShell is consumed rather
    # than written back.
    io.open(path, "w", encoding="utf-8", newline="\n").write(SQL)

    raw = io.open(path, "rb").read()
    print(f"  写入 {len(raw)} 字节")
    print(f"  以 BOM 开头: {raw[:3] == b'\\xef\\xbb\\xbf'}")
    print(f"  首行: {raw.decode('utf-8').splitlines()[0][:60]}")


if __name__ == "__main__":
    main()
