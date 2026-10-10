"""Remove the leaked comment and the recent-entries row.

The comment is my fault: a script inserted a CSS-style block comment into JSX,
where braces and asterisks mean nothing and the text is simply content. It
rendered on the page.

The row it introduced is being removed anyway, at the owner's request — a
heading that labels a list the reader can already see, and a link that does what
an upward swipe does.
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
    "pages",
    "DetailPage.tsx",
)

# From the leaked comment through the closing tag of the heading row.
BLOCK = re.compile(
    r"\n\s*/\* Centred rather than baseline-aligned.*?</div>\n",
    re.S,
)


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    match = BLOCK.search(text)
    if match is None:
        print("  ✗ 没找到那一块")
        return

    print("  将删除的内容：")
    for line in match.group(0).strip().splitlines():
        print("   ", line.strip()[:88])

    text = text[: match.start()] + "\n" + text[match.end() :]

    # `goTo` was only used by the link that has just gone.
    if "goTo" not in text.split("useDetailTransition")[1].split("\n", 1)[1]:
        pass

    io.open(PATH, "w", encoding="utf-8", newline="\n").write(text)
    print("  ✓ 已删除")


if __name__ == "__main__":
    main()
