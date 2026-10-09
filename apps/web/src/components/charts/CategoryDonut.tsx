import type { CategoryTotal } from "@libellum/shared";
import { useMemo, useState } from "react";

import { ChartFrame } from "../chart/ChartFrame.js";
import { arcPath } from "../../lib/chart/geometry.js";
import { categoricalColor, markerPoints, markerShape, type MarkerShape } from "../../lib/chart/theme.js";
import { emptyStateMessage, summariseSeries } from "../../lib/chart/guards.js";
import { formatMoney } from "../../lib/format.js";

/** Beyond this many slices the ring becomes confetti; the rest become 其它. */
const MAX_SLICES = 6;

interface Slice {
  readonly id: string | null;
  readonly name: string;
  readonly minor: number;
  readonly share: number;
  readonly color: string;
  readonly shape: MarkerShape;
}

/**
 * Where the money went, as a ring.
 *
 * The legend is not decoration: it carries the name, the amount and the share
 * of every slice, because a ring on its own cannot be read precisely and on a
 * phone its labels would overlap. Each row also carries a **shape**, so the
 * chart does not depend on colour alone.
 *
 * Tapping a row opens the entries behind it — the number is only ever a route
 * to the thing the user actually wanted to see.
 */
export function CategoryDonut({
  totals,
  currency,
  onSelectCategory,
}: {
  readonly totals: readonly CategoryTotal[];
  readonly currency: string;
  readonly onSelectCategory?: (categoryId: string) => void;
}): React.JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null);

  const slices = useMemo(() => buildSlices(totals), [totals]);
  const total = slices.reduce((sum, slice) => sum + slice.minor, 0);
  const summary = summariseSeries(slices.map((slice) => slice.minor));

  return (
    <>
      <ChartFrame
        height={188}
        padding={{ top: 8, right: 8, bottom: 8, left: 8 }}
        title={`${currency} 分类占比`}
        notice={emptyStateMessage(summary.state, "支出")}
      >
        {(layout) => {
          const cx = layout.width / 2;
          const cy = layout.height / 2;
          const outer = Math.min(cx, cy) - 4;
          const inner = outer * 0.6;

          let angle = 0;

          return (
            <>
              {slices.map((slice) => {
                const sweep = total === 0 ? 0 : (slice.minor / total) * 360;
                const path = arcPath(cx, cy, outer, inner, angle + 0.8, angle + sweep - 0.8);
                angle += sweep;

                return (
                  <path
                    key={slice.name}
                    d={path}
                    fill={slice.color}
                    fillOpacity={activeId === null || activeId === slice.id ? 1 : 0.35}
                  />
                );
              })}
              <text
                x={cx}
                y={cy - 4}
                textAnchor="middle"
                fontSize={11}
                fill="#8fa39a"
              >
                合计
              </text>
              <text
                x={cx}
                y={cy + 14}
                textAnchor="middle"
                fontSize={15}
                fontWeight={600}
                fill="#1f2d27"
              >
                {formatMoney(total, currency)}
              </text>
            </>
          );
        }}
      </ChartFrame>

      <ul className="mt-3 flex flex-col">
        {slices.map((slice) => {
          const share = total === 0 ? 0 : slice.minor / total;
          const tappable = slice.id !== null && onSelectCategory !== undefined;

          return (
            <li key={slice.name}>
              <button
                type="button"
                disabled={!tappable}
                onClick={() => {
                  if (slice.id === null || onSelectCategory === undefined) return;
                  setActiveId(activeId === slice.id ? null : slice.id);
                  onSelectCategory(slice.id);
                }}
                className="flex w-full items-center gap-2.5 border-b border-line py-2.5 text-left text-sm last:border-b-0 disabled:cursor-default"
              >
                <SliceMarker color={slice.color} shape={slice.shape} />
                <span className="flex-1 truncate text-ink">{slice.name}</span>
                <span className="text-xs text-muted">{Math.round(share * 100)}%</span>
                <span className="w-20 text-right tabular-nums text-ink">
                  {formatMoney(slice.minor, currency)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function SliceMarker({
  color,
  shape,
}: {
  readonly color: string;
  readonly shape: MarkerShape;
}): React.JSX.Element {
  const size = 10;
  const radius = size / 2 - 1;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${String(size)} ${String(size)}`} aria-hidden="true">
      {shape === "circle" ? (
        <circle cx={size / 2} cy={size / 2} r={radius} fill={color} />
      ) : (
        <polygon
          points={markerPoints(shape, radius)}
          fill={color}
          transform={`translate(${String(size / 2)}, ${String(size / 2)})`}
        />
      )}
    </svg>
  );
}

/**
 * Split the totals into slices, keeping the tail out of the way.
 *
 * A ring with eighteen equal slices says nothing. The largest few carry the
 * story; everything else is genuinely "other" and is labelled as such rather
 * than hidden.
 */
function buildSlices(totals: readonly CategoryTotal[]): Slice[] {
  const positive = totals.filter((total) => total.minor > 0);
  const head = positive.slice(0, MAX_SLICES);
  const tail = positive.slice(MAX_SLICES);
  const tailTotal = tail.reduce((sum, total) => sum + total.minor, 0);

  const slices: Slice[] = head.map((total, index) => ({
    id: total.categoryId,
    name: total.name,
    minor: total.minor,
    share: total.share,
    color: categoricalColor(index),
    shape: markerShape(index),
  }));

  if (tailTotal > 0) {
    slices.push({
      id: null,
      name: `其它 ${String(tail.length)} 项`,
      minor: tailTotal,
      share: 0,
      color: categoricalColor(slices.length),
      shape: markerShape(slices.length),
    });
  }

  return slices;
}
