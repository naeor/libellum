import type { StatsBucket, StatsSeriesPoint } from "@libellum/shared";
import { useRef, useState } from "react";

import { ChartFrame, type ChartLayout } from "../chart/ChartFrame.js";
import { Baseline, XAxis, YAxis } from "../chart/Axis.js";
import { Legend, type LegendItem } from "../chart/Legend.js";
import { areaPath, linePath } from "../../lib/chart/geometry.js";
import { createLinearScale, extentOf, niceDomain, ticksFor } from "../../lib/chart/scales.js";
import { categoricalColor, markerPoints } from "../../lib/chart/theme.js";
import {
  bucketFullLabel,
  bucketLabel,
  formatAxisAmount,
  formatExactAmount,
} from "../../lib/chart/format.js";
import { emptyStateMessage, summariseSeries } from "../../lib/chart/guards.js";
import { currencyName, formatMoney } from "../../lib/format.js";

/** Expense is the thing people come to look at, so it leads and is filled. */
const EXPENSE_COLOR = categoricalColor(3);
const INCOME_COLOR = categoricalColor(0);

const PLOT_HEIGHT = 190;

/**
 * Spending and income over time.
 *
 * Touch is the primary input here, so the whole plot area is a pointer target:
 * dragging a finger across it moves a marker and reports the bucket under it.
 * That is also why the values are printed rather than left to a hover state
 * that a phone does not have.
 */
export function TrendChart({
  points,
  currency,
  bucket,
}: {
  readonly points: readonly StatsSeriesPoint[];
  readonly currency: string;
  readonly bucket: StatsBucket;
}): React.JSX.Element {
  const [active, setActive] = useState<number | null>(null);
  const dragging = useRef(false);

  const expenses = points.map((point) => point.expenseMinor);
  const incomes = points.map((point) => point.incomeMinor);
  const summary = summariseSeries([...expenses, ...incomes]);

  const totals = {
    expense: expenses.reduce((sum, value) => sum + value, 0),
    income: incomes.reduce((sum, value) => sum + value, 0),
  };

  const legend: LegendItem[] = [
    {
      label: "支出",
      color: EXPENSE_COLOR,
      shape: "circle",
      value: formatMoney(totals.expense, currency),
    },
    {
      label: "收入",
      color: INCOME_COLOR,
      shape: "square",
      value: formatMoney(totals.income, currency),
    },
  ];

  return (
    <>
      <ChartFrame
        height={PLOT_HEIGHT}
        padding={{ top: 14, right: 12, bottom: 26, left: 42 }}
        title={`${currencyName(currency)}收支趋势`}
        notice={emptyStateMessage(summary.state, "收支")}
      >
        {(layout) => {
          const all = [...expenses, ...incomes];
          const extent = extentOf(all) ?? [0, 1];
          const domain = niceDomain(extent[0], extent[1], 4);
          const y = createLinearScale(domain, [
            layout.padding.top + layout.innerHeight,
            layout.padding.top,
          ]);
          const slot = layout.innerWidth / Math.max(points.length, 1);
          const x = (index: number): number => layout.padding.left + slot * (index + 0.5);

          const expensePoints = points.map((point, index) => ({ x: x(index), y: y(point.expenseMinor) }));
          const incomePoints = points.map((point, index) => ({ x: x(index), y: y(point.incomeMinor) }));

          const pick = (clientX: number, bounds: DOMRect): void => {
            const relative = clientX - bounds.left;
            const index = Math.min(Math.max(Math.floor(relative / Math.max(slot, 1)), 0), points.length - 1);

            setActive(index);
          };

          const selected = active === null ? undefined : points[active];

          return (
            <>
              <YAxis
                layout={layout}
                ticks={ticksFor(domain, 4)}
                scale={y}
                format={(value) => formatAxisAmount(value, currency)}
              />
              <Baseline layout={layout} y={y(0)} />

              <path d={areaPath(expensePoints, y(0))} fill={EXPENSE_COLOR} fillOpacity={0.12} />
              <path
                d={linePath(expensePoints)}
                fill="none"
                stroke={EXPENSE_COLOR}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <path
                d={linePath(incomePoints)}
                fill="none"
                stroke={INCOME_COLOR}
                strokeWidth={2}
                strokeDasharray="4 3"
                strokeLinejoin="round"
              />
              {incomePoints.map((point, index) => (
                <polygon
                  key={index}
                  points={markerPoints("square", 2.6)}
                  transform={`translate(${String(point.x)}, ${String(point.y)})`}
                  fill={INCOME_COLOR}
                />
              ))}

              {selected === undefined ? null : (
                <ActiveMarker
                  layout={layout}
                  x={x(active ?? 0)}
                  label={bucketFullLabel(selected.bucket, bucket)}
                  expense={formatExactAmount(selected.expenseMinor, currency)}
                  income={formatExactAmount(selected.incomeMinor, currency)}
                  currency={currency}
                />
              )}

              <XAxis
                layout={layout}
                labels={points.map((point) => bucketLabel(point.bucket, bucket))}
                slotWidth={slot}
              />

              {/* Last, so it sits above the series: the whole plot is the target. */}
              <rect
                x={layout.padding.left}
                y={layout.padding.top}
                width={layout.innerWidth}
                height={layout.innerHeight}
                fill="transparent"
                className="touch-pan-y"
                onPointerDown={(event) => {
                  dragging.current = false;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const bounds = event.currentTarget.getBoundingClientRect();
                  pick(event.clientX, bounds);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  dragging.current = true;
                  pick(event.clientX, event.currentTarget.getBoundingClientRect());
                }}
                onPointerUp={(event) => {
                  dragging.current = false;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => {
                  dragging.current = false;
                  setActive(null);
                }}
                onPointerLeave={() => {
                  if (!dragging.current) setActive(null);
                }}
              />
            </>
          );
        }}
      </ChartFrame>

      <Legend items={legend} className="mt-3" />
    </>
  );
}

/** The vertical rule and the values under the finger. */
function ActiveMarker({
  layout,
  x,
  label,
  expense,
  income,
  currency,
}: {
  readonly layout: ChartLayout;
  readonly x: number;
  readonly label: string;
  readonly expense: string;
  readonly income: string;
  readonly currency: string;
}): React.JSX.Element {
  const width = 112;
  const height = 46;
  const left = Math.min(Math.max(x - width / 2, 2), layout.width - width - 2);
  const top = 2;

  return (
    <g pointerEvents="none">
      <line
        x1={x}
        x2={x}
        y1={layout.padding.top}
        y2={layout.padding.top + layout.innerHeight}
        stroke={EXPENSE_COLOR}
        strokeOpacity={0.45}
        strokeWidth={1}
      />
      <rect x={left} y={top} width={width} height={height} rx={6} fill="#ffffff" stroke="#e3eae6" />
      <text x={left + 8} y={top + 15} fontSize={10} fill="#8fa39a">
        {label}
      </text>
      <text x={left + 8} y={top + 29} fontSize={11} fill={EXPENSE_COLOR}>
        支出 {expense}
      </text>
      <text x={left + 8} y={top + 41} fontSize={11} fill={INCOME_COLOR}>
        收入 {income} {currency}
      </text>
    </g>
  );
}
