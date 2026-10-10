"""Define the three clocks. The previous pass matched their uses, not the names."""

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


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    if "--p-out:" in text:
        print("  (已定义)")
    else:
        anchor = "  --p-cur:"
        index = text.find(anchor)
        if index < 0:
            print("  ✗ 找不到 --p-cur")
        else:
            text = text[:index] + CLOCKS + text[index:]
            io.open(PATH, "w", encoding="utf-8", newline="\n").write(text)
            print("  ✓ 三个时钟已定义")

    text = io.open(PATH, encoding="utf-8").read()
    for line in text.splitlines():
        if line.strip().startswith("--p-") and ":" in line:
            print("   ", line.strip())


if __name__ == "__main__":
    main()
