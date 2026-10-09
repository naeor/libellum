import type { StatsSeriesPoint } from "@libellum/shared";
import { useMemo, useState } from "react";

import { bucketOf, bucketThresholds } from "../../lib/chart/scales.js";
import { heatColor } from "../../lib/chart/theme.js";
import { formatExactAmount } from "../../lib/chart/format.js";
import { currencyName, formatMoney } from "../../lib/format.js";

const LEVELS = 4;
const COLUMNS = 7;
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"] as const;

/**
 * Which days were heavy, as a grid of squares.
 *
 * The colours are **quantiles of the days that had any spending**, not a
 * linear ramp from zero. With a linear ramp one expensive day makes every
 * ordinary day look the same pale shade and the grid stops saying anything;
 * quantiles are rank-based, so the buckets fill by construction and the
 * outlier simply becomes the darkest square. Log scaling was the other
 * candidate and does not solve it — it compresses the outlier without
 * separating the ordinary days from each other.
 *
 * The consequence is deliberate and stated in the caption: a colour means
 * "heavy for this period", not a fixed amount.
 */
export function CalendarHeatmap({
  days,
  currency,
}: {
  readonly days: readonly StatsSeriesPoint[];
  readonly currency: string;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);

  const thresholds = useMemo(
    () => bucketThresholds(days.map((day) => day.expenseMinor), LEVELS),
    [days],
  );

  const total = days.reduce((sum, day) => sum + day.expenseMinor, 0);
  const spentDays = days.filter((day) => day.expenseMinor > 0).length;
  const peak = days.reduce(
    (best, day) => (day.expenseMinor > best.expenseMinor ? day : best),
    days[0] ?? { bucket: "", expenseMinor: 0, incomeMinor: 0 },
  );

  if (days.length === 0) {
    return (
      <p className="rounded-field bg-canvas px-4 py-3 text-xs leading-relaxed text-muted">
        所选时段暂无记录。
      </p>
    );
  }

  if (total === 0) {
    return (
      <p className="rounded-field bg-canvas px-4 py-3 text-xs leading-relaxed text-muted">
        所选时段已有记录，但金额均为零。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((day) => (
          <span key={day} className="text-center text-[10px] text-muted">
            {day}
          </span>
        ))}

        {/* Leading blanks so the first day sits under its weekday. */}
        {Array.from({ length: leadingBlanks(days[0]?.bucket ?? "") }, (_, index) => (
          <span key={`blank-${String(index)}`} />
        ))}

        {days.map((day) => {
          const level = bucketOf(day.expenseMinor, thresholds);
          const isSelected = selected === day.bucket;

          return (
            <button
              key={day.bucket}
              type="button"
              onClick={() => {
                setSelected(isSelected ? null : day.bucket);
              }}
              aria-label={`${day.bucket} 支出 ${formatExactAmount(day.expenseMinor, currency)} ${currency}`}
              aria-pressed={isSelected}
              className={`flex aspect-square items-center justify-center rounded text-[10px] transition ${
                isSelected ? "ring-2 ring-ink ring-offset-1" : ""
              } ${level >= 3 ? "text-white" : "text-muted"}`}
              style={{ backgroundColor: heatColor(level) }}
            >
              {Number(day.bucket.slice(8, 10))}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 text-[10px] text-muted">
        <span>少</span>
        {Array.from({ length: LEVELS + 1 }, (_, level) => (
          <span
            key={level}
            className="inline-block h-3 w-6 rounded-sm"
            style={{ backgroundColor: heatColor(level) }}
          />
        ))}
        <span>多</span>
        <span className="ml-1">最左为无支出</span>
      </div>

      <p className="text-xs leading-relaxed text-muted">
        {selected === null
          ? `本期共 ${String(spentDays)} 天有支出，合计 ${formatMoney(total, currency)}。颜色表示“在本期内的相对高低”。`
          : `${selected} 支出 ${formatMoney(
              days.find((day) => day.bucket === selected)?.expenseMinor ?? 0,
              currency,
            )}（第 ${String(
              bucketOf(
                days.find((day) => day.bucket === selected)?.expenseMinor ?? 0,
                thresholds,
              ),
            )} 档）`}
      </p>

      {peak.expenseMinor > 0 ? (
        <p className="text-xs leading-relaxed text-muted">
          {currencyName(currency)}支出最多的一天是 {peak.bucket}，
          {formatMoney(peak.expenseMinor, currency)}。
        </p>
      ) : null}
    </div>
  );
}

/** Weekday index of the first day, so the grid lines up with its column. */
function leadingBlanks(firstBucket: string): number {
  if (firstBucket === "") return 0;

  // Date.UTC is used purely as a civil calendar; the value is a date string,
  // never an instant, so no timezone can shift it.
  const weekday = new Date(`${firstBucket}T00:00:00Z`).getUTCDay();

  // The grid starts on Monday, and getUTCDay() calls Sunday 0.
  return (weekday + 6) % COLUMNS;
}
