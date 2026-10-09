import { markerPoints, type MarkerShape } from "../../lib/chart/theme.js";

export interface LegendItem {
  readonly label: string;
  readonly color: string;
  /** Matches the marker used on the chart itself. */
  readonly shape?: MarkerShape;
  readonly value?: string;
}

/**
 * The key to a chart.
 *
 * Every entry carries a **shape as well as a colour**. Colour alone is not a
 * channel everyone can read — and on a phone held at an angle in daylight, it
 * is not a channel anyone can read reliably. A legend that only differs by hue
 * is decoration; this one is information.
 */
export function Legend({
  items,
  className = "",
}: {
  readonly items: readonly LegendItem[];
  readonly className?: string;
}): React.JSX.Element {
  return (
    <ul className={`flex flex-wrap gap-x-4 gap-y-2 ${className}`}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-xs text-muted">
          <LegendMarker color={item.color} shape={item.shape ?? "circle"} />
          <span className="text-ink">{item.label}</span>
          {item.value === undefined ? null : <span className="tabular-nums">{item.value}</span>}
        </li>
      ))}
    </ul>
  );
}

function LegendMarker({
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
        <polygon points={markerPoints(shape, radius)} fill={color} transform={`translate(${String(size / 2)}, ${String(size / 2)})`} />
      )}
    </svg>
  );
}
