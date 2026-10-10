"""Move §1.31 to where it belongs: directly after §1.30, not at the end of the file.

The insertion anchor named a heading that does not exist in this document, so the
section was appended instead. Timeline sections belong in the timeline.
"""

from __future__ import annotations

import io
import os

PATH = os.path.join(
    r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1",
    "docs",
    "DEVLOG.md",
)

HEADING = "### 1.31 第三十一阶段：明细页两个形态（2026-10-10 全天）"
BOUNDARY = "## 2. 关键决策记录（ADR）"


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    start = text.find(HEADING)
    if start < 0:
        print("  ✗ 找不到 §1.31")
        return

    # To the end of the file, or to the next top-level heading after it.
    rest = text.find("\n## ", start)
    end = len(text) if rest < 0 else rest + 1
    block = text[start:end]

    text = text[:start] + text[end:]
    text = text.rstrip() + "\n"

    # Now place it before the ADR section.
    at = text.find(BOUNDARY)
    if at < 0:
        print("  ✗ 找不到 §2 的标题")
        return

    text = text[:at] + block.rstrip() + "\n\n---\n\n" + text[at:]

    io.open(PATH, "w", encoding="utf-8", newline="\n").write(text)
    print("  ✓ §1.31 已移到 §1.30 之后")

    for line in text.splitlines():
        if line.startswith("### 1.3") or line.startswith("## "):
            print("   ", line[:60])


if __name__ == "__main__":
    main()
