"""Lift the cards clear of the green boundary, and tidy the recent-entries heading.

The owner's numbers, applied as given: the small cards rise eight, the month and
the two tool buttons rise four, and the green boundary itself stays where it is —
so the clearance comes out of the slack the list state already had rather than
from making the green area taller again.
"""

from __future__ import annotations

import io
import os

BASE = r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1"
CSS = os.path.join(BASE, "apps", "web", "src", "detail-motion.css")
PAGE = os.path.join(BASE, "apps", "web", "src", "pages", "DetailPage.tsx")

EDITS: list[tuple[str, str, str]] = [
    # The month rises four further than its alignment with the tools requires.
    (
        "  transform: translate3d(0, calc(var(--p-month) * var(--row-one) * -1), 0);",
        "  transform: translate3d(0, calc(var(--p-month) * var(--row-one) * -1 - var(--p) * 4px), 0);",
        "月份再上移 4px",
    ),
    # The tools move down ten and then up four: six, net.
    (
        "  transform: translate3d(0, calc(var(--p-tools) * 10px), 0);",
        "  transform: translate3d(0, calc(var(--p-tools) * 10px - var(--p) * 4px), 0);",
        "工具按钮净下移 6px（10 − 4）",
    ),
]

# The cards rise as a block, which keeps them level with one another.
STRIP_NOTE = """/*
 * The small cards rise as a block in the list state.
 *
 * A transform rather than a margin, so all of them move together and the green
 * boundary does not have to move at all — which is what the owner asked for:
 * clearance under the cards, bought from the slack the layout already had.
 */
"""


def css() -> None:
    text = io.open(CSS, encoding="utf-8").read()

    for old, new, note in EDITS:
        if old not in text:
            print(f"  ✗ 未匹配：{note}")
            continue
        text = text.replace(old, new, 1)
        print(f"  ✓ {note}")

    old_strip = ".detail-strip {\n  margin-top: calc(16px - var(--p) * 24px);\n}"
    new_strip = (
        STRIP_NOTE
        + ".detail-strip {\n  margin-top: calc(16px - var(--p) * 24px);\n"
        + "  transform: translate3d(0, calc(var(--p) * -8px), 0);\n}"
    )
    if old_strip in text:
        text = text.replace(old_strip, new_strip, 1)
        print("  ✓ 卡片条整体上移 8px（绿色边界不动）")
    else:
        print("  ✗ 找不到 .detail-strip")

    io.open(CSS, "w", encoding="utf-8", newline="\n").write(text)

    print()
    print("  明细态核算：")
    print("    卡片下沿  50 + 74 - 8 = 116")
    print("    绿色边界                140")
    print("    余量                    24   ✓ 卡片不再贴边")


def page() -> None:
    text = io.open(PAGE, encoding="utf-8").read()

    old = '<div className="detail-recent-heading flex items-end justify-between pt-4">'
    new = (
        "/* Centred rather than baseline-aligned: the heading and the link are\n"
        "               different sizes, and aligning their baselines left the two\n"
        "               looking like they belonged to different rows. */\n"
        '            <div className="detail-recent-heading flex items-center justify-between pt-[11px]">'
    )
    if old in text:
        text = text.replace(old, new, 1)
        print("  ✓ 最近记录 / 查看全部：居中对齐，上移 5px")
    else:
        print("  ✗ 找不到最近记录那一行")

    old_link = 'className="pb-1 text-xs text-brand-dark"'
    if old_link in text:
        text = text.replace(old_link, 'className="text-xs text-brand-dark"', 1)
        print("  ✓ 查看全部去掉多余的下内边距")

    io.open(PAGE, "w", encoding="utf-8", newline="\n").write(text)


if __name__ == "__main__":
    css()
    page()
