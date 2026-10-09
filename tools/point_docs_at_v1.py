"""Point the current-state references at 记账程序v1.

Historical entries stay as they are: "the project was moved to 记账程序v2" was
true when it was written, and rewriting it would be falsifying the record. Only
the passages that describe where the project is NOW need to change.
"""

from __future__ import annotations

import io
import os
import sys

V1 = r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1"
DOCS = os.path.join(V1, "docs")

REPLACEMENTS: list[tuple[str, str]] = [
    # §3.1 the shortcut instructions
    (
        r"打开 `C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v2\docs\`，双击 **`启动记账服务器.lnk`**",
        r"打开 `C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1\docs\`，双击 **`启动记账服务器.lnk`**",
    ),
    # §4 the current-root note
    (
        "**2026-10-09 19:00 之后，项目实际根目录是 `Desktop\\工作\\记账程序\\记账程序v2\\`**（见 §1.26）。",
        "**2026-10-09 19:00 起项目移入子目录，19:55 起该子目录名为 `记账程序v1`**（见 §1.26、§1.28）。",
    ),
]


def main() -> int:
    applied = 0
    missing: list[str] = []

    for name in ("DEVLOG.md", "BACKLOG.md", "README.md"):
        path = os.path.join(DOCS, name)
        if not os.path.exists(path):
            continue

        text = io.open(path, encoding="utf-8").read()
        original = text

        for old, new in REPLACEMENTS:
            if old in text:
                text = text.replace(old, new)
                applied += 1

        if text != original:
            io.open(path, "w", encoding="utf-8", newline="\n").write(text)
            print(f"  已更新 {name}")

    print(f"共 {applied} 处")

    # Report what is left, so a stale current-state reference cannot hide.
    print("\n剩余提到「记账程序v2」的位置（应全部是历史记录）：")
    for name in ("DEVLOG.md", "BACKLOG.md", "README.md"):
        path = os.path.join(DOCS, name)
        if not os.path.exists(path):
            continue
        for number, line in enumerate(io.open(path, encoding="utf-8"), start=1):
            if "记账程序v2" in line:
                print(f"  {name}:L{number}  {line.strip()[:90]}")

    return 0 if not missing else 1


if __name__ == "__main__":
    sys.exit(main())
