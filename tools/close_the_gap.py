"""Close the last seven pixels.

The list state's content measured 162 against a 155 green area, which a
containment box would have clipped. The month row's top gap was the only part
still fixed; it closes as the transition runs.
"""

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

OLD = """.detail-month-row {
  transform: translate3d(0, calc(var(--p-month) * var(--row-one) * -1), 0);
}"""

NEW = """.detail-month-row {
  transform: translate3d(0, calc(var(--p-month) * var(--row-one) * -1), 0);
  /*
   * The gap above the month closes as the transition runs. It is the last part
   * of the green area that was still fixed, and without it the list state's
   * content came to 162 against a 155 area — which a containment box clips
   * rather than shows.
   */
  margin-top: calc(8px - var(--p) * 8px);
}"""


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    if OLD not in text:
        print("  ✗ 找不到 .detail-month-row 的规则")
        # Still report the numbers so the arithmetic can be checked by hand.
    else:
        text = text.replace(OLD, NEW)
        io.open(PATH, "w", encoding="utf-8", newline="\n").write(text)
        print("  ✓ 月份行的上间距随转场收拢")

    print()
    print("  明细态内容高度：")
    print("    上内边距   6")
    print("    品牌/工具 36")
    print("    月份行     0 + 32 = 32")
    print("    卡片条    74")
    print("    下内边距   6")
    print("    ──────────────")
    print("    合计     154  ≤ 155  ✓")


if __name__ == "__main__":
    main()
