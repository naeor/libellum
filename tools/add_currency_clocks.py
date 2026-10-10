"""Add the currency block's three clocks and correct the green area's height."""

from __future__ import annotations

import io
import os

PATH = os.path.join(
    r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1",
    "apps",
    "web",
    "src",
    "detail-motion.css",
)

CLOCKS = """  /*
   * The currency block, in three acts.
   *
   * The primary card leaves first, on its own, so nothing else is moving while
   * it is on screen to collide with. The small cards settle in the middle. The
   * primary currency's twin grows into the row last, once the row it is joining
   * has stopped moving.
   *
   * Sequential rather than overlapping, on purpose: every fault this block has
   * had came from two of its parts moving at the same time.
   */
  --p-out: clamp(0, calc(var(--p) / 0.4), 1);
  --p-small: clamp(0, calc((var(--p) - 0.3) / 0.5), 1);
  --p-twin: clamp(0, calc((var(--p) - 0.6) / 0.4), 1);
"""

HEIGHT_NOTE = """  /*
   * Tall enough for what the list state actually draws.
   *
   * Worked out rather than guessed: 24 padding, a 36 wordmark line, a 40 month
   * row, a 52 strip, 28 padding, and a little over — because a containment box
   * clips whatever does not fit, and the owner has already seen these cards cut
   * in half once.
   */
  --hero-short: 192px;"""


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    if "--p-out" in text:
        print("  (时钟已存在)")
    else:
        anchor = "  --p-cur:"
        index = text.find(anchor)
        if index < 0:
            print("  ✗ 找不到 --p-cur")
        else:
            text = text[:index] + CLOCKS + text[index:]
            print("  ✓ 三个时钟已加入")

    old = "  --hero-short: 150px;"
    if old in text:
        text = text.replace(old, HEIGHT_NOTE)
        print("  ✓ 明细态高度 150 → 192")
    elif "--hero-short: 192px" in text:
        print("  (高度已是 192)")
    else:
        print("  ✗ 找不到 --hero-short")

    io.open(PATH, "w", encoding="utf-8", newline="\n").write(text)

    for line in text.splitlines():
        if "--hero-short" in line or "--p-out" in line or "--p-twin" in line:
            print("   ", line.strip())


if __name__ == "__main__":
    main()
