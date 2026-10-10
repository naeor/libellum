"""Point the primary card's rule at flex-basis, and drop the rise trick.

The primary card is now the first child of one strip rather than a row of its
own. Its width was a box measurement; its share of the line is what matters now,
because that is what decides whether the smaller cards sit beneath it or beside
it. The rule that walked the second row up to meet it has nothing left to do.
"""

from __future__ import annotations

import io
import os
import re

PATH = os.path.join(
    r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1",
    "apps",
    "web",
    "src",
    "detail-motion.css",
)

NEW_MAIN = """/* D. The primary card.
 *
 * Its share of the line, not its width: a full line while the screen is a home
 * page, so the smaller cards wrap onto a second row beneath it, and a third of
 * one once it is a list, so they sit beside it in a single row that scrolls.
 * `flex-basis` decides both, and it animates — which is what lets one element
 * be a hero card and then one card among equals.
 */
.detail-main-card {
  flex-basis: calc(100% - var(--p-cur) * (100% - var(--card-narrow)));
  flex-grow: 0;
  flex-shrink: 0;
  height: calc(var(--card-tall) - var(--p-cur) * (var(--card-tall) - var(--card-short)));
  contain: layout paint style;
}
"""


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    main_rule = re.search(r"/\* D\. The main card\..*?\n\}\n", text, re.S)
    if main_rule is None:
        main_rule = re.search(r"\.detail-main-card \{.*?\n\}\n", text, re.S)

    if main_rule is None:
        print("  ✗ 没找到主卡片规则")
    else:
        text = text[: main_rule.start()] + NEW_MAIN + text[main_rule.end() :]
        print("  ✓ 主卡片改为 flex-basis")

    rise_rule = re.search(
        r"/\*\n \* E\. The row of smaller currencies rises.*?\n\.detail-secondary-row \{.*?\n\}\n",
        text,
        re.S,
    )
    if rise_rule is None:
        print("  (未找到上升规则)")
    else:
        text = text[: rise_rule.start()] + text[rise_rule.end() :]
        print("  ✓ 已删除「上升合流」规则")

    io.open(PATH, "w", encoding="utf-8", newline="\n").write(text)

    remaining = re.findall(r"^\.detail-[a-z-]+", text, re.M)
    print("  规则清单:", ", ".join(sorted(set(remaining))))


if __name__ == "__main__":
    main()
