"""S6 step 1: the audit table, and the reference de-duplication needs.

Two small schema changes, both of which are hard to correct later.

`source_ref` holds the identifier a row carried in the file it came from, and is
deliberately not the primary key. A file we did not produce does not get to
choose our keys, and uniqueness scoped to the identifier alone would refuse a
legitimate import into a second book. `(bookId, sourceRef)` is the rule: the
same file into the same book changes nothing, the same file into another book is
not blocked.

`ExportLog` holds metadata only — who, when, what range, how many, and a file
number the user can quote back. Never the rows, never the file.
"""

from __future__ import annotations

import io
import os

PATH = os.path.join(
    r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1",
    "prisma",
    "schema.prisma",
)

SOURCE_REF = """    /// The identifier this row carried in the file it was imported from, if any.
    ///
    /// Deliberately not the primary key. A file we did not produce does not get
    /// to choose our keys, and de-duplicating on the identifier alone would
    /// refuse a legitimate import into a second book — see the unique
    /// constraint below, which scopes it to the book.
    sourceRef String? @map("source_ref")

"""

UNIQUE = """    /// One source row per book. The scoping is the point: a global rule would
    /// refuse a legitimate import into a second book.
    @@unique([bookId, sourceRef])

"""

EXPORT_LOG = """

/// A record that an export happened.
///
/// Metadata only. The owner was explicit that the contents are not kept: no
/// rows, no file. What is here is what the export covered, how much of it there
/// was, and the number the user was shown — which is what makes it possible to
/// match a later question about a file to the run that produced it.
model ExportLog {
  id     String @id @db.Uuid
  bookId String @map("book_id") @db.Uuid
  /// Who ran it.
  userId String @map("user_id") @db.Uuid

  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  /// "csv" or "xlsx".
  format String @db.VarChar(8)

  /// The filter that produced it, kept as answers rather than as a query string
  /// so it stays readable when the query language changes.
  monthFrom  String?          @map("month_from") @db.VarChar(7)
  monthTo    String?          @map("month_to") @db.VarChar(7)
  kind       TransactionKind?
  categoryId String?          @map("category_id") @db.Uuid
  currency   String?          @map("currency") @db.Char(3)

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


def add_relation(text: str, model: str, field: str) -> tuple[str, bool]:
    """Put a back-relation at the end of a model, before its @@map."""
    start = text.find(f"model {model} {{")
    if start < 0:
        return text, False
    end = text.find("\n}", start)
    if end < 0:
        return text, False
    body = text[start:end]
    if field.strip().split()[0] in body:
        return text, False
    return text[:end] + f"\n{field}" + text[end:], True


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()
    changed = False

    # 1. The reference column.
    if "sourceRef" in text:
        print("  (sourceRef 已存在)")
    else:
        anchor = "    // The list view always asks for one book's live rows newest-first; cursor"
        if anchor not in text:
            print("  ✗ 找不到 Transaction 的锚点")
        else:
            text = text.replace(anchor, SOURCE_REF + anchor, 1)
            changed = True
            print("  ✓ Transaction.sourceRef")

    # 2. Its uniqueness, scoped to the book.
    if "@@unique([bookId, sourceRef])" not in text:
        anchor = '    @@map("transactions")'
        if anchor not in text:
            print("  ✗ 找不到 @@map(\"transactions\")")
        else:
            text = text.replace(anchor, UNIQUE + anchor, 1)
            changed = True
            print("  ✓ @@unique([bookId, sourceRef])")

    # 3. The audit table, and the relations Prisma requires on both sides.
    if "model ExportLog" in text:
        print("  (ExportLog 已存在)")
    else:
        text = text.rstrip() + "\n" + EXPORT_LOG
        changed = True
        print("  ✓ ExportLog")

        for model, field in (
            ("Book", "  exportLogs     ExportLog[]"),
            ("User", "  exportLogs       ExportLog[]"),
        ):
            text, done = add_relation(text, model, field)
            print(f"  {'✓' if done else '✗'} {model} 的反向关系")

    if changed:
        io.open(PATH, "w", encoding="utf-8", newline="\n").write(text)
    print("\n  写入完成" if changed else "\n  无改动")


if __name__ == "__main__":
    main()
