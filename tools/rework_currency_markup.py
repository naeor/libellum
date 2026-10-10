"""Point the currency block's markup at the two-element arrangement.

The strip is always one non-wrapping row now: the hero card is a separate
element above it, so the strip never has to change how it wraps. The primary
currency's twin sits at the head of that row with no width while the hero card
is on screen, and grows into place after it has left.
"""

from __future__ import annotations

import io
import os

PATH = os.path.join(
    r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1",
    "apps",
    "web",
    "src",
    "pages",
    "DetailPage.tsx",
)

OLD_BLOCK = """              <div
                ref={stripRef}
                data-h-scroll
                className="mt-4 flex flex-wrap gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none] [scroll-snap-type:x_proximity]"
              >
                <MainCard className="detail-main-card" summary={main} currency={mainCode} />

                {others.map((item) => (
                  <SecondaryCard key={item.currency} summary={item} />
                ))}

                <button
                  type="button"
                  onClick={() => {
                    setShowAllCurrencies(true);
                  }}
                  className="detail-currency-card w-30 shrink-0 snap-start px-4 text-left text-xs text-white/90"
                >
                  更多币种
                </button>
              </div>"""

NEW_BLOCK = """              <>
                {/*
                  The hero card. It only ever leaves — it shrinks and slides off
                  the left edge — and it never has to become one card among
                  equals.

                  The owner proposed this arrangement after watching every fault
                  that comes of asking one element to be two things: text that
                  overflowed, a balance line that faded but kept its space, a
                  width that never matched its neighbours. Two elements, each
                  doing one job, and all of it goes.
                */}
                <MainCard className="detail-main-card mt-4" summary={main} currency={mainCode} />

                {/*
                  One row, never wrapping: the hero card is not in it, so it has
                  only ever to lay out small cards. Its first item is the
                  primary currency's twin, which is nothing until the hero card
                  has gone and then grows into the row.
                */}
                <div
                  data-h-scroll
                  className="detail-strip flex flex-nowrap gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none]"
                >
                  <SmallCard className="detail-twin" summary={main} currency={mainCode} />

                  {others.map((item) => (
                    <SmallCard key={item.currency} summary={item} currency={item.currency} />
                  ))}

                  <button
                    type="button"
                    onClick={() => {
                      setShowAllCurrencies(true);
                    }}
                    className="detail-currency-card detail-small-card w-30 shrink-0 px-4 text-left text-xs text-white/90"
                  >
                    更多币种
                  </button>
                </div>
              </>"""

OLD_SECONDARY = """/**
 * A currency other than the primary one.
 *
 * A fixed width, not a share of the row.
 *
 * A percentage would be measured against the row's *content* box, which shrinks
 * when the row indents to make room for the primary card — so every card got
 * narrower exactly when there was one more of them, which is backwards. A fixed
 * width keeps them all the same and lets the ones that do not fit run off the
 * right edge, which is what the owner asked for: a currency that cannot fit
 * should move along, not shrink everything.
 */
function SecondaryCard({ summary }: { readonly summary: CurrencySummary }): React.JSX.Element {
  return (
    <div className="detail-currency-card h-full w-34 shrink-0 snap-start px-4">
      <span className="text-[11px] text-white/70">{currencyName(summary.currency)}</span>
      <span className="text-base font-medium tabular-nums">
        {formatMoney(summary.expenseCents, summary.currency)}
      </span>
      <span className="text-[11px] text-white/70 tabular-nums">
        结余 {formatMoney(summary.balanceCents, summary.currency)}
      </span>
    </div>
  );
}"""

NEW_SECONDARY = """/**
 * One small currency card.
 *
 * Every card in the strip is this, including the primary currency's twin, so
 * they cannot drift apart in size, type or content — which is what the owner
 * kept seeing when the primary card was also trying to be one of them.
 *
 * A fixed width rather than a share of the row: a percentage is measured
 * against the row's content box, and a card that changes width when a
 * neighbour appears is a card that looks smaller the more there are. The ones
 * that do not fit run off the right edge instead.
 *
 * A currency with nothing in it this month says so, rather than showing zero —
 * the twin exists in both states, and in a month with no entries it would
 * otherwise claim the account had spent nothing.
 */
function SmallCard({
  summary,
  currency,
  className = "",
}: {
  readonly summary: CurrencySummary | null;
  readonly currency: string;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <div className={`detail-currency-card detail-small-card w-34 shrink-0 px-4 ${className}`}>
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
  );
}"""


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    if OLD_BLOCK not in text:
        print("  ✗ 找不到旧币种区块")
    else:
        text = text.replace(OLD_BLOCK, NEW_BLOCK)
        print("  ✓ 币种区块已改为「大卡飞走 + 孪生小卡」")

    if OLD_SECONDARY not in text:
        print("  ✗ 找不到 SecondaryCard")
    else:
        text = text.replace(OLD_SECONDARY, NEW_SECONDARY)
        print("  ✓ SecondaryCard → SmallCard（统一所有小卡片）")

    io.open(PATH, "w", encoding="utf-8", newline="\n").write(text)


if __name__ == "__main__":
    main()
