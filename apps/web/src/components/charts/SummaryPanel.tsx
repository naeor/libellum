import type { PeriodTotals, StatsSeriesPoint } from "@libellum/shared";
import { useState } from "react";

import { ChartFrame } from "../chart/ChartFrame.js";
import { Baseline, YAxis } from "../chart/Axis.js";
import { createLinearScale, niceDomain, ticksFor } from "../../lib/chart/scales.js";
import { categoricalColor } from "../../lib/chart/theme.js";
import { formatAxisAmount, formatExactAmount } from "../../lib/chart/format.js";
import { summariseSeries } from "../../lib/chart/guards.js";
import { currencyName, formatMoney } from "../../lib/format.js";

const EXPENSE_COLOR = categoricalColor(3);
const INCOME_COLOR = categoricalColor(0);

/**
 * Month against month, with the comparison made honest.
 *
 * The trap this exists for: on the 9th of the month, total spending is
 * obviously lower than a whole month's, and a plain "down 71%" reads as
 * frugality when it is only the calendar. `monthToDate` marks that case, and
 * the caller has already fetched a comparison covering the same number of days
 * — so the percentage is a real comparison, and the note explains why the
 * second period is shorter.
 */
export function ComparisonPanel({
  current,
  previous,
  monthToDate,
  currentDays,
  previousDays,
  currency,
}: {
  readonly current: PeriodTotals;
  readonly previous: PeriodTotals | null;
  readonly monthToDate: boolean;
  readonly currentDays: number;
  readonly previousDays: number;
  readonly currency: string;
}): React.JSX.Element {
  const rows = [
    {
      label: "支出",
      current: current.expenseMinor,
      previous: previous?.expenseMinor ?? null,
      invert: true,
      color: EXPENSE_COLOR,
    },
    {
      label: "收入",
      current: current.incomeMinor,
      previous: previous?.incomeMinor ?? null,
      invert: false,
      color: INCOME_COLOR,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <ComparisonRow
          key={row.label}
          label={row.label}
          color={row.color}
          current={row.current}
          previous={row.previous}
          currency={currency}
          invert={row.invert}
        />
      ))}

      <p className="text-xs leading-relaxed text-muted">
        {previous === null
          ? "所选时段没有可对比的历史数据，因此不显示变化幅度。"
          : monthToDate
            ? `对比为“上月同期”：本期 ${String(currentDays)} 天，对比上期 ${String(previousDays)} 天。本期尚未结束，与完整月份比较会失真。`
            : `对比为上一完整周期：本期 ${String(currentDays)} 天，对比上期 ${String(previousDays)} 天。`}
      </p>
    </div>
  );
}

function ComparisonRow({
  label,
  color,
  current,
  previous,
  currency,
  invert,
}: {
  readonly label: string;
  readonly color: string;
  readonly current: number;
  readonly previous: number | null;
  readonly currency: string;
  /** True for spending, where an increase is not good news. */
  readonly invert: boolean;
}): React.JSX.Element {
  const hasComparison = previous !== null && previous !== 0;
  const delta = hasComparison ? (current - previous) / previous : 0;
  const rising = delta > 0;
  const isNotable = hasComparison && Math.abs(delta) >= 0.005;

  // Spending up is worth a second look; income up is simply good. Colour
  // follows that reading, and the arrow repeats it for anyone who cannot
  // separate the two greens and reds.
  const tone = !isNotable
    ? "text-muted"
    : rising === invert
      ? "text-danger"
      : "text-brand-dark";

  return (
    <div className="flex items-baseline justify-between gap-3 rounded-field bg-canvas px-4 py-3">
      <span className="flex items-center gap-2 text-sm text-muted">
        <span aria-hidden="true" className="inline-block size-2 rounded-full" style={{ backgroundColor: color }} />
        {label}
      </span>
      <span className="flex items-baseline gap-2">
        <span className="text-base font-medium tabular-nums text-ink">
          {formatMoney(current, currency)}
        </span>
        <span className={`text-xs tabular-nums ${tone}`}>
          {!hasComparison ? "—" : isNotable ? `${rising ? "↑" : "↓"} ${formatPercent(Math.abs(delta))}` : "持平"}
        </span>
      </span>
    </div>
  );
}

function formatPercent(ratio: number): string {
  return `${String(Math.round(ratio * 100))}%`;
}

/**
 * A year at a glance: the totals, then twelve bars.
 *
 * The bars are drawn with the same primitives as everything else, and the
 * tallest one is labelled rather than every one — a number on each of twelve
 * bars on a phone is noise.
 */
export function YearOverview({
  months,
  totals,
  currency,
}: {
  readonly months: readonly StatsSeriesPoint[];
  readonly totals: PeriodTotals;
  readonly currency: string;
}): React.JSX.Element {
  const [active, setActive] = useState<number | null>(null);

  const values = months.map((month) => month.expenseMinor);
  const summary = summariseSeries(values);
  const peak = Math.max(...values, 0);
  const peakIndex = values.indexOf(peak);

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3">
        <Stat label="总支出" value={formatMoney(totals.expenseMinor, currency)} />
        <Stat label="总收入" value={formatMoney(totals.incomeMinor, currency)} />
        <Stat
          label="结余"
          value={formatMoney(totals.netMinor, currency)}
          tone={totals.netMinor < 0 ? "danger" : "default"}
        />
        <Stat label="笔数" value={`${String(totals.count)} 笔`} />
      </dl>

      {summary.state === "ready" || summary.state === "single" ? (
        <ChartFrame
          height={148}
          padding={{ top: 10, right: 8, bottom: 20, left: 40 }}
          title={`${currencyName(currency)} 各月支出`}
          notice={null}
        >
          {(layout) => {
            const domain = niceDomain(0, peak, 3);
            const y = createLinearScale(domain, [
              layout.padding.top + layout.innerHeight,
              layout.padding.top,
            ]);
            const slot = layout.innerWidth / Math.max(months.length, 1);
            const barWidth = Math.max(slot * 0.62, 2);

            return (
              <>
                <YAxis
                  layout={layout}
                  ticks={ticksFor(domain, 3)}
                  scale={y}
                  format={(value) => formatAxisAmount(value, currency)}
                />
                {months.map((month, index) => {
                  const top = y(month.expenseMinor);
                  const base = y(0);

                  return (
                    <rect
                      key={month.bucket}
                      x={layout.padding.left + slot * index + (slot - barWidth) / 2}
                      y={top}
                      width={barWidth}
                      height={Math.max(base - top, 1)}
                      rx={2}
                      fill={EXPENSE_COLOR}
                      fillOpacity={active === null || active === index ? 0.9 : 0.35}
                      onClick={() => {
                        setActive(active === index ? null : index);
                      }}
                    />
                  );
                })}
                <Baseline layout={layout} y={y(0)} />
                {peakIndex >= 0 && peak > 0 ? (
                  <text
                    x={layout.padding.left + slot * peakIndex + slot / 2}
                    y={y(peak) - 4}
                    textAnchor="middle"
                    fontSize={10}
                    fill="#8fa39a"
                  >
                    {formatAxisAmount(peak, currency)}
                  </text>
                ) : null}
              </>
            );
          }}
        </ChartFrame>
      ) : (
        <p className="rounded-field bg-canvas px-4 py-3 text-xs leading-relaxed text-muted">
          所选时段暂无支出记录，因此不显示各月分布。
        </p>
      )}

      {active === null ? null : (
        <p className="text-xs text-muted">
          {active + 1} 月支出 {formatExactAmount(months[active]?.expenseMinor ?? 0, currency)}{" "}
          {currency}
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "default" | "danger";
}): React.JSX.Element {
  return (
    <div className="rounded-field bg-canvas px-4 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 text-base font-medium tabular-nums ${tone === "danger" ? "text-danger" : "text-ink"}`}>
        {value}
      </dd>
    </div>
  );
}
