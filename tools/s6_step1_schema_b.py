"""Insert the reference column and its constraint, at the file's real indentation.

The first attempt used four spaces; this schema indents model bodies by two, so
neither anchor matched and only the audit table landed. Caught by validating the
schema rather than by assuming the write had worked.
"""

from __future__ import annotations

import io
import os

PATH = os.path.join(
    r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1",
    "prisma",
    "schema.prisma",
)

FIELD = """  /// The identifier this row carried in the file it was imported from, if any.
  ///
  /// Deliberately not the primary key. A file we did not produce does not get
  /// to choose our keys, and de-duplicating on the identifier alone would
  /// refuse a legitimate import into a second book — see the unique constraint
  /// below, which scopes it to the book.
  sourceRef String? @map("source_ref")

"""

UNIQUE = """  /// One source row per book. The scoping is the point: a global rule would
  /// refuse a legitimate import into a second book.
  @@unique([bookId, sourceRef])

"""


def main() -> None:
    lines = io.open(PATH, encoding="utf-8").read().split("\n")

    start = next(i for i, line in enumerate(lines) if line == "model Transaction {")
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == "}")

    body = "\n".join(lines[start:end])

    if "sourceRef" in body:
        print("  (sourceRef 已存在)")
    else:
        # Right after bookId, so the column reads next to the book it belongs to.
        at = next(
            i for i in range(start, end) if lines[i].strip().startswith("bookId ")
        )
        lines[at + 1 : at + 1] = FIELD.rstrip("\n").split("\n")
        print("  ✓ Transaction.sourceRef")

    # The constraint goes last in the model, next to the @@map.
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == "}")
    if "@@unique([bookId, sourceRef])" not in "\n".join(lines[start:end]):
        at = next(
            i for i in range(start, end) if lines[i].strip() == '@@map("transactions")'
        )
        lines[at:at] = UNIQUE.rstrip("\n").split("\n")
        print("  ✓ @@unique([bookId, sourceRef])")
    else:
        print("  (约束已存在)")

    io.open(PATH, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
    print("\n  写入完成")


if __name__ == "__main__":
    main()
