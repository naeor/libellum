"""S6 step 1: the audit table, and the field import de-duplication needs.

Two schema changes, both small and both hard to get right later.

`source_ref` is the identifier a row carried in the file it came from. It is
deliberately *not* the primary key: a foreign file's identifiers are not ours to
trust, and using them as keys would let one file's numbering collide with
another book's. The uniqueness is scoped to the book, so re-importing the same
file into the same book is idempotent while importing it into a different book
is not blocked.

`ExportLog` records that an export happened and what it covered — never the
contents. The owner was explicit: no rows, no file, just who, when, how much and
which file number, so a later question about a file can be matched to a run.
"""

from __future__ import annotations

import io
import os

PATH = os.path.join(
    r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1",
    "prisma",
    "schema.prisma",
)

FIELD = """
    /// The identifier of this row in the file it was imported from, if any.
    ///
    /// Not the primary key, and never used as one: identifiers from a file we
    /// did not produce are not ours to trust. Uniqueness is scoped to the book
    /// below, so importing the same file twice into one book changes nothing,
    /// while importing it into a different book is not blocked.
    sourceRef String? @map("source_ref")

"""

UNIQUE = """
    /// One source row per book. Scoping to the book is the whole point: a global
    /// rule would refuse a legitimate import into a second book.
    @@unique([bookId, sourceRef])
"""

EXPORT_LOG = """

/// A record that an export happened.
///
/// Metadata only. The owner was explicit that the contents are not kept — no
/// rows, no file — so this holds what the export covered, how much of it there
/// was, and the number shown to the user, which is what makes it possible to
/// match a later question to the run that produced the file.
model ExportLog {
  id     String @id @db.Uuid
  bookId String @map("book_id") @db.Uuid
  /// Who ran it.
  userId String @map("user_id") @db.Uuid

  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  /// "csv" or "xlsx".
  format String @db.VarChar(8)

  /// The filter that produced it, stored as the answers rather than a query
  /// string, so it stays readable when the query language changes.
  monthFrom  String? @map("month_from") @db.VarChar(7)
  monthTo    String? @map("month_to") @db.VarChar(7)
  kind       TransactionKind?
  categoryId String? @map("category_id") @db.Uuid
  currency   String? @map("currency") @db.Char(3)

  /// How many entries went into it.
  rowCount Int @map("row_count")

  /// Shown to the user, so a file in their hands can be matched to this record.
  fileRef String @unique @map("file_ref") @db.VarChar(32)

  book Book @relation(fields: [bookId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([bookId, createdAt])
  @@map("export_logs")
}
"""


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    if "sourceRef" in text:
        print("  (sourceRef 已存在)")
    else:
        anchor = "    /// The local calendar date where the entry was made."
        index = text.find(anchor)
        if index < 0:
            print("  ✗ 找不到 Transaction 的插入点")
            return
        text = text[:index] + FIELD.lstrip("\n") + "\n" + text[index:]
        print("  ✓ Transaction.sourceRef 已加入")

    # The unique constraint goes at the end of the Transaction model.
    if "@@unique([bookId, sourceRef])" not in text:
        start = text.find("model Transaction {")
        end = text.find("\n}", start)
        if start < 0 or end < 0:
            print("  ✗ 找不到 Transaction 的结尾")
            return
        text = text[:end] + "\n" + UNIQUE.rstrip("\n") + text[end:]
        print("  ✓ 账本内唯一约束已加入")

    if "model ExportLog" in text:
        print("  (ExportLog 已存在)")
    else:
        # Relations have to exist on both sides in Prisma.
        text = text.rstrip() + "\n" + EXPORT_LOG

        for model, field in (("model Book {", "  exportLogs ExportLog[]"), ("model User {", "  exportLogs ExportLog[]")):
            start = text.find(model)
            if start < 0:
                print(f"  ✗ 找不到 {model}")
                continue
            end = text.find("\n}", start)
            text = text[:end] + "\n" + field + text[end:]
            print(f"  ✓ {model.split()[1]} 加了反向关系")

        print("  ✓ ExportLog 模型已加入")

    io.open(PATH, "w", encoding="utf-8", newline="\n").write(text)
    print("\n  完成")


if __name__ == "__main__":
    main()
