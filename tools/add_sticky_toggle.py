"""Add the pinned-toggle rule, which the JSX already refers to.

The class is applied in DetailPage when the list state arrives, but the rule
itself failed to land — so for one commit the toggle carried a class that
matched nothing. Appending rather than replacing, because the exact text of the
preceding rule did not match cleanly and guessing again would waste another
round.
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

RULE = """
/*
 * In the list state the toggle is pinned under the summary.
 *
 * The owner asked for it: expense and income are what the entries below are
 * filtered by, so they belong with the month and the tool buttons rather than
 * scrolling away with the rows. It parks directly beneath the green area, which
 * is itself pinned, so the two read as one header.
 */
.detail-toggle-sticky {
  position: sticky;
  top: var(--hero-short);
  z-index: 19;
  background: var(--color-canvas, #fbfbf9);
}
"""


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    if ".detail-toggle-sticky" in text:
        print("  规则已存在，无需重复添加")
        return

    io.open(PATH, "w", encoding="utf-8", newline="\n").write(text.rstrip() + "\n" + RULE)
    print("  ✓ 已加入 .detail-toggle-sticky")


if __name__ == "__main__":
    main()
