"""Rebuild the currency block: the primary card leaves, a twin takes its place.

The owner's proposal, and it removes a whole class of faults at once. Until now
one element had to be both a hero card and one card among equals, and everything
that went wrong - text overflowing, the balance line leaving a blank strip, the
width never matching its neighbours - came from that one requirement.

So there are two elements. The hero card flies out to the left and collapses.
A twin of it, identical to every other small card, waits as the first item in the
strip and grows into place once the strip has settled. Neither ever has to be
anything other than what it is.
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

# The whole currency section, from the primary card's rule to the end of the
# small-card height rule, is replaced in one go.
NEW_BLOCK = """/*
 * D. The primary card leaves.
 *
 * It used to shrink into the row and become one card among equals, and the
 * owner found every fault that comes of asking one element to be two things:
 * the amount overflowed, the balance line faded but still held space, and its
 * width never matched its neighbours. He proposed the simpler arrangement -
 * let it fly out to the left, and give it a twin in the row - and he is right.
 *
 * So this element only ever leaves: it shrinks in height and slides off the
 * left edge.
 */
.detail-main-card {
  height: calc(var(--card-tall) * (1 - var(--p-out)));
  opacity: calc(1 - var(--p-out));
  transform: translate3d(calc(var(--p-out) * -45%), 0, 0);
  overflow: hidden;
  contain: layout paint style;
}

/* Its smaller print is hidden outright rather than faded, so it cannot leave a
   blank line behind in the space it is vacating. */
.detail-main-detail {
  opacity: calc(1 - clamp(0, calc((var(--p-out) - 0.2) / 0.3), 1));
}

.detail-main-amount {
  font-size: 1.875rem;
}

.detail-main-name {
  font-size: 0.75rem;
}

/*
 * E. The strip of small cards.
 *
 * Every currency in one scrolling row, all of them the same size and shape.
 * The gap above it closes as the primary card collapses, so the strip arrives
 * at the top of the green area without anything having to push it.
 */
.detail-strip {
  margin-top: calc(var(--card-gap) * (1 - var(--p-rise)));
}

.detail-small-card {
  height: calc(var(--secondary-tall) - var(--p-small) * (var(--secondary-tall) - var(--secondary-short)));
}

/*
 * The primary currency's twin.
 *
 * It is the first item of the strip in both states; only its width is nothing
 * while the hero card is still on screen. Growing the share of the line rather
 * than the width keeps it inside the flex row rather than overflowing it, and
 * the content is clipped while there is no room for it.
 */
.detail-twin {
  flex-basis: calc(var(--p-twin) * var(--card-narrow));
  flex-grow: 0;
  flex-shrink: 0;
  opacity: var(--p-twin);
  overflow: hidden;
}
"""


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    start = text.find("/* D. The primary card.")
    if start < 0:
        start = text.find("/* D. The main card.")
    if start < 0:
        print("  ✗ 找不到 D 段")
        return

    end = text.find("/* F. The tool buttons", start)
    if end < 0:
        print("  ✗ 找不到 F 段（D 段的终点）")
        return

    text = text[:start] + NEW_BLOCK + "\n" + text[end:]

    # The clock the new rules read.
    clock = """  --p-out: clamp(0, calc(var(--p) / 0.4), 1);
  --p-small: clamp(0, calc((var(--p) - 0.3) / 0.5), 1);
  --p-twin: clamp(0, calc((var(--p) - 0.6) / 0.4), 1);
"""
    if "--p-out" not in text:
        anchor = "  --p-cur:"
        index = text.find(anchor)
        if index >= 0:
            text = text[:index] + clock + text[index:]
            print("  ✓ 已加入三个新时钟")
        else:
            print("  ✗ 找不到时钟插入点")
    else:
        print("  (时钟已存在)")

    io.open(PATH, "w", encoding="utf-8", newline="\n").write(text)
    print("  ✓ 币种区块已重写")


if __name__ == "__main__":
    main()
