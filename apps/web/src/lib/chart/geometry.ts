/**
 * SVG path builders.
 *
 * Pure string arithmetic, so a chart component never assembles path data by
 * hand and every chart gets the same rounded joints and closed areas.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A polyline through the points, or an empty string when there is nothing to draw. */
export function linePath(points: readonly Point[]): string {
  if (points.length === 0) return "";

  if (points.length === 1) {
    const only = points[0]!;
    // A single point has no length; a dot is drawn separately by the caller.
    return `M ${round(only.x)} ${round(only.y)}`;
  }

  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${round(point.x)} ${round(point.y)}`)
    .join(" ");
}

/**
 * The same line closed down to a baseline, for filled area charts.
 *
 * `baseline` is a y pixel, not a value — the caller has already mapped zero
 * through the scale, which keeps this function ignorant of the data.
 */
export function areaPath(points: readonly Point[], baseline: number): string {
  if (points.length < 2) return "";

  const first = points[0]!;
  const last = points.at(-1)!;

  return `${linePath(points)} L ${round(last.x)} ${round(baseline)} L ${round(first.x)} ${round(baseline)} Z`;
}

/** Polar to cartesian, with 0° pointing up and angles increasing clockwise. */
export function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDegrees: number,
): Point {
  const radians = ((angleDegrees - 90) * Math.PI) / 180;

  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

/**
 * One segment of a ring, as a closed path.
 *
 * `innerRadius` of 0 produces a pie slice; anything larger produces a donut
 * segment. A segment covering a full circle cannot be drawn with a single arc
 * — the start and end points coincide — so it is drawn as two half circles.
 */
export function arcPath(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = endAngle - startAngle;

  if (sweep <= 0) return "";
  if (sweep >= 360) return fullRingPath(cx, cy, outerRadius, innerRadius);

  const largeArc = sweep > 180 ? 1 : 0;

  const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, endAngle);

  if (innerRadius <= 0) {
    return [
      `M ${round(cx)} ${round(cy)}`,
      `L ${round(outerStart.x)} ${round(outerStart.y)}`,
      `A ${round(outerRadius)} ${round(outerRadius)} 0 ${String(largeArc)} 1 ${round(outerEnd.x)} ${round(outerEnd.y)}`,
      "Z",
    ].join(" ");
  }

  const innerEnd = polarToCartesian(cx, cy, innerRadius, endAngle);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);

  return [
    `M ${round(outerStart.x)} ${round(outerStart.y)}`,
    `A ${round(outerRadius)} ${round(outerRadius)} 0 ${String(largeArc)} 1 ${round(outerEnd.x)} ${round(outerEnd.y)}`,
    `L ${round(innerEnd.x)} ${round(innerEnd.y)}`,
    `A ${round(innerRadius)} ${round(innerRadius)} 0 ${String(largeArc)} 0 ${round(innerStart.x)} ${round(innerStart.y)}`,
    "Z",
  ].join(" ");
}

function fullRingPath(cx: number, cy: number, outerRadius: number, innerRadius: number): string {
  if (innerRadius <= 0) {
    // A circle cannot be expressed as an arc whose ends meet; two halves can.
    return [
      `M ${round(cx)} ${round(cy - outerRadius)}`,
      `A ${round(outerRadius)} ${round(outerRadius)} 0 1 1 ${round(cx)} ${round(cy + outerRadius)}`,
      `A ${round(outerRadius)} ${round(outerRadius)} 0 1 1 ${round(cx)} ${round(cy - outerRadius)}`,
      "Z",
    ].join(" ");
  }

  return [
    `M ${round(cx)} ${round(cy - outerRadius)}`,
    `A ${round(outerRadius)} ${round(outerRadius)} 0 1 1 ${round(cx)} ${round(cy + outerRadius)}`,
    `A ${round(outerRadius)} ${round(outerRadius)} 0 1 1 ${round(cx)} ${round(cy - outerRadius)}`,
    "Z",
    `M ${round(cx)} ${round(cy - innerRadius)}`,
    `A ${round(innerRadius)} ${round(innerRadius)} 0 1 0 ${round(cx)} ${round(cy + innerRadius)}`,
    `A ${round(innerRadius)} ${round(innerRadius)} 0 1 0 ${round(cx)} ${round(cy - innerRadius)}`,
    "Z",
  ].join(" ");
}

/** Keep path data short: two decimals is below what a phone screen can show. */
function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}
