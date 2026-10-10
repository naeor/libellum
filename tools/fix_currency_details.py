"""Four corrections to the currency block and the green area's depth.

1. The twin's padding is inside an inner wrapper, so at zero width it is truly
   nothing rather than a thirty-two pixel hole in front of the first real card.
2. The small cards keep one height throughout. The owner's words were that they
   should do nothing but change position, and he is right: interpolating their
   height was what pushed their text out of them.
3. The twin's share of the line is expressed in the same unit as its neighbours'
   width, so the two are the same number rather than merely close.
4. The green area in the list state is shallower. There is a floor here — the
   content has to fit inside a containment box, or it is clipped — so the number
   is derived from what the list state actually draws rather than picked, and
   the padding around it is trimmed to buy back as much as possible.
"""

from __future__ import annotations

import io
import os

BASE = r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1"
CSS = os.path.join(BASE, "apps", "web", "src", "detail-motion.css")
PAGE = os.path.join(BASE, "apps", "web", "src", "pages", "DetailPage.tsx")

# ---------------------------------------------------------------------------
# 1 & 2 & 3: the stylesheet
# ---------------------------------------------------------------------------

OLD_SMALL = """.detail-small-card {
  height: calc(var(--secondary-tall) - var(--p-small) * (var(--secondary-tall) - var(--secondary-short)));
}"""

NEW_SMALL = """/*
 * One height, in both states.
 *
 * It used to interpolate, and the owner saw the result: every card was squashed
 * on the way down and its text pushed out of it. His words were that they should
 * do nothing but change position, which is the whole point of them being in a
 * row that is already the right size.
 */
.detail-small-card {
  height: var(--secondary-tall);
}"""

OLD_TWIN = """.detail-twin {
  flex-basis: calc(var(--p-twin) * var(--card-narrow));
  flex-grow: 0;
  flex-shrink: 0;
  opacity: var(--p-twin);
  overflow: hidden;
}"""

NEW_TWIN = """/*
 * Its share of the line, in the same unit as its neighbours' width.
 *
 * A percentage and a fixed width are not the same number, and the owner could
 * see the difference: the twin came out a little narrower than the cards beside
 * it. Both are 8.5rem now.
 */
.detail-twin {
  flex-basis: calc(var(--p-twin) * 8.5rem);
  flex-grow: 0;
  flex-shrink: 0;
  opacity: var(--p-twin);
  overflow: hidden;
  padding-inline: 0;
}"""

HERO_PADDING = """
/*
 * The green area's own padding, trimmed as the list state arrives.
 *
 * The owner asked for the boundary between green and white to move up about
 * fifty pixels. The content has a floor — the strip's cards keep one height, as
 * he asked, so they cannot give anything back — and the only slack left is the
 * spacing around them. This is that slack.
 */
"""


def css() -> None:
    text = io.open(CSS, encoding="utf-8").read()

    if OLD_SMALL in text:
        text = text.replace(OLD_SMALL, NEW_SMALL)
        print("  ✓ 小卡片高度固定（不再压扁）")
    else:
        print("  ✗ 找不到 .detail-small-card")

    if OLD_TWIN in text:
        text = text.replace(OLD_TWIN, NEW_TWIN)
        print("  ✓ 孪生卡宽度改用同一个单位")
    else:
        print("  ✗ 找不到 .detail-twin")

    # The hero's padding shrinks with the transition.
    old_hero = """.detail-hero {
  contain: layout paint style;"""
    if old_hero in text and "--hero-pad" not in text:
        text = text.replace(
            old_hero,
            """.detail-hero {
  contain: layout paint style;
  padding-top: var(--hero-pad-top);
  padding-bottom: var(--hero-pad-bottom);""",
        )
        text = text.replace(
            "  --hero-short: 192px;",
            "  --hero-pad-top: calc(24px - var(--p) * 18px);\n  --hero-pad-bottom: calc(28px - var(--p) * 22px);\n  --hero-short: 155px;",
        )
        print("  ✓ 绿色区内边距随转场收紧，高度 192 → 155")
    else:
        print("  (内边距/高度已改过)")

    if HERO_PADDING.strip() not in text:
        text = text.replace(".detail-strip {", HERO_PADDING + ".detail-strip {")

    io.open(CSS, "w", encoding="utf-8", newline="\n").write(text)


# ---------------------------------------------------------------------------
# 4: the markup, so the twin's padding cannot make a hole
# ---------------------------------------------------------------------------

OLD_CARD = """    <div className={`detail-currency-card detail-small-card w-34 shrink-0 px-4 ${className}`}>
      <span className="text-[11px] whitespace-nowrap text-white/70">{currencyName(currency)}</span>
      {summary === null ? (
        <span className="text-[11px] whitespace-nowrap text-white/60">暂无数据</span>
      ) : (
        <>
          <span className="text-base font-medium tabular-nums whitespace-nowrap">
            {formatMoney(summary.expenseCents, summary.currency)}
          </span>
          <span className="text-[11px] whitespace-nowrap text-white/70 tabular-nums">
            结余 {formatMoney(summary.balanceCents, summary.currency)}
          </span>
        </>
      )}
    </div>"""

NEW_CARD = """    /*
     * The padding lives inside, not on the card.
     *
     * On the card it is part of its width, so the twin — which is nothing until
     * the hero card has left — still measured thirty-two pixels and left a hole
     * in front of the first real card. The owner saw that hole in the display
     * state before anything had moved.
     */
    <div className={`detail-currency-card detail-small-card w-34 shrink-0 ${className}`}>
      <div className="flex h-full flex-col justify-center px-4">
        <span className="text-[11px] whitespace-nowrap text-white/70">{currencyName(currency)}</span>
        {summary === null ? (
          <span className="text-[11px] whitespace-nowrap text-white/60">暂无数据</span>
        ) : (
          <>
            <span className="text-base font-medium tabular-nums whitespace-nowrap">
              {formatMoney(summary.expenseCents, summary.currency)}
            </span>
            <span className="text-[11px] whitespace-nowrap text-white/70 tabular-nums">
              结余 {formatMoney(summary.balanceCents, summary.currency)}
            </span>
          </>
        )}
      </div>
    </div>"""

OLD_HEADER = '<header\n            className="detail-hero relative bg-brand px-6 pt-6 pb-7 text-white"\n            data-pinned={atList}\n          >'
NEW_HEADER = '<header\n            className="detail-hero relative bg-brand px-6 text-white"\n            data-pinned={atList}\n          >'


def page() -> None:
    text = io.open(PAGE, encoding="utf-8").read()

    if OLD_CARD in text:
        text = text.replace(OLD_CARD, NEW_CARD)
        print("  ✓ 卡片内边距移入内层")
    else:
        print("  ✗ 找不到 SmallCard 的主体")

    if OLD_HEADER in text:
        text = text.replace(OLD_HEADER, NEW_HEADER)
        print("  ✓ header 的上下内边距交给变量")
    else:
        print("  (header 已改过)")

    io.open(PAGE, "w", encoding="utf-8", newline="\n").write(text)


if __name__ == "__main__":
    css()
    page()
