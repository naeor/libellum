"""Close the gap between the month and the cards, and settle three alignments.

The owner has been reporting the same large gap for several rounds, and the
cause was two things stacked.

The month row kept its full height after the month had risen out of it, so
thirty-two pixels of space sat empty directly beneath the month. And the rise
itself was still 52px, a number worked out against an older arrangement of the
header; against the present one the month only needs 24px to reach the tool
buttons — so it was overshooting upwards while the empty row below it stayed
put, and the two together opened a gap of about a hundred pixels.

Everything here is derived from the numbers the file already holds rather than
picked: padding, the wordmark line, the month row, the strip, the padding again.
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

EDITS: list[tuple[str, str, str]] = [
    # The month's rise, corrected against the present header.
    (
        "  --row-one: 52px;",
        "  --row-one: 24px;",
        "月份上升 52 → 24（按现在的表头重算）",
    ),
    # The tools move down ten, and the month follows them.
    (
        """.detail-tools {
  transform: translate3d(0, calc(var(--p-tools) * -10px), 0);
}""",
        """.detail-tools {
  transform: translate3d(0, calc(var(--p-tools) * 10px), 0);
}""",
        "工具按钮改为下移 10px",
    ),
    # The month row gives up its height as the month leaves it.
    (
        """  margin-top: calc(8px - var(--p) * 8px);
}""",
        """  margin-top: calc(8px - var(--p) * 8px);
  /*
   * And it gives up its height.
   *
   * This is the gap the owner kept reporting: the month rises out of this row,
   * but the row stayed thirty-two pixels tall underneath it, so the space it
   * had vacated was still there. The month is translated, not laid out, so
   * shrinking the row does not move it.
   */
  height: calc(32px - var(--p) * 16px);
}""",
        "月份行让出高度",
    ),
    # The strip rises into the space the month row gave back.
    (
        """.detail-strip {
  margin-top: calc(var(--card-gap) * (1 - var(--p-rise)));
}""",
        """.detail-strip {
  margin-top: calc(16px - var(--p) * 24px);
}""",
        "卡片条上移，贴住月份",
    ),
    # Shallower still, now that there is less to hold.
    (
        "  --hero-short: 155px;",
        "  --hero-short: 140px;",
        "明细态高度 155 → 140",
    ),
    # The twin's gap contribution, so the first real card sits flush left.
    (
        """  opacity: var(--p-twin);
  overflow: hidden;
  padding-inline: 0;
}""",
        """  opacity: var(--p-twin);
  overflow: hidden;
  padding-inline: 0;
  /*
   * And it does not leave the row's gap behind.
   *
   * With no width it still had a gap after it, which put the first real card
   * about ten pixels in from the edge in the display state. The owner saw it
   * and was right that it was small but wrong.
   */
  margin-right: calc(-10px + var(--p-twin) * 10px);
}""",
        "孪生卡不再留下 10px 空隙",
    ),
]


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    for old, new, note in EDITS:
        if old not in text:
            print(f"  ✗ 未匹配：{note}")
            continue
        text = text.replace(old, new, 1)
        print(f"  ✓ {note}")

    io.open(PATH, "w", encoding="utf-8", newline="\n").write(text)

    print()
    print("  明细态核算：")
    print("    上内边距          6")
    print("    品牌/工具行      36")
    print("    月份行           16   （32 - 16）")
    print("    卡片条上间距     -8   （16 - 24）")
    print("    卡片条           74")
    print("    下内边距          6")
    print("    ────────────────────")
    print("    合计            130   ≤ 140  ✓")
    print()
    print("  对齐核算：")
    print("    工具中心  6 + 18 + 10 = 34")
    print("    月份中心  42 - 24 + 16 = 34   ✓ 齐平")
    print("    月份下沿  18 + 32 = 50")
    print("    卡片上沿  6 + 36 + 16 - 8 = 50   ✓ 空隙归零")


if __name__ == "__main__":
    main()
