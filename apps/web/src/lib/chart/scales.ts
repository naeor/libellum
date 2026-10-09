/**
 * Scales and ticks.
 *
 * Everything here is pure arithmetic with no knowledge of React or SVG, which
 * is what makes it testable — and what keeps the statistical rules out of the
 * chart components. A chart receives numbers and a size; this module is the
 * only place that decides how one maps onto the other.
 */

export interface LinearScale {
  (value: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  /** Pixel back to value. Needed to turn a touch position into a data point. */
  invert(pixel: number): number;
}

export function createLinearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;

  const scale = ((value: number): number => {
    // A zero-width domain would divide by zero; park everything in the middle
    // so a flat series still draws a sensible line instead of NaN.
    if (span === 0) return (r0 + r1) / 2;
    return r0 + ((value - d0) / span) * (r1 - r0);
  }) as { (value: number): number } & Record<string, unknown>;

  scale["domain"] = domain;
  scale["range"] = range;
  scale["invert"] = (pixel: number): number => {
    if (r1 === r0) return d0;
    return d0 + ((pixel - r0) / (r1 - r0)) * span;
  };

  return scale as unknown as LinearScale;
}

/** Smallest and largest of a series, ignoring anything not finite. */
export function extentOf(values: readonly number[]): readonly [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let seen = false;

  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    seen = true;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  return seen ? [min, max] : null;
}

/** Round a number up to the next "nice" step (1, 2, 5, 10, 20, 50, …). */
function niceStep(rough: number): number {
  if (rough <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;

  if (normalised <= 1) return magnitude;
  if (normalised <= 2) return 2 * magnitude;
  if (normalised <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

/**
 * Widen a domain so its ends land on round numbers.
 *
 * Axis labels reading `0 / 250 / 500 / 750 / 1000` are readable; the raw
 * `0 / 237 / 474 / 711 / 948` that a maximum of 948 would produce is not.
 * Always includes zero: bar and area charts read as comparisons against a
 * baseline, and a truncated axis makes small differences look enormous.
 */
export function niceDomain(
  min: number,
  max: number,
  tickCount = 4,
): readonly [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];

  let low = Math.min(min, 0);
  let high = Math.max(max, 0);

  // A completely flat series still deserves a visible axis.
  if (low === high) {
    if (high === 0) return [0, 1];
    low = Math.min(0, high);
    high = Math.max(0, high);
    if (low === high) return [0, high * 2 || 1];
  }

  const step = niceStep((high - low) / Math.max(tickCount, 1));

  return [Math.floor(low / step) * step, Math.ceil(high / step) * step];
}

/** Evenly spaced tick values across a domain, inclusive of both ends. */
export function ticksFor(
  domain: readonly [number, number],
  count = 4,
): number[] {
  const [start, end] = domain;
  if (!Number.isFinite(start) || !Number.isFinite(end) || count < 1) return [];

  if (start === end) return [start];

  const step = (end - start) / count;
  return Array.from({ length: count + 1 }, (_, index) => start + step * index);
}

/**
 * Quantile of an **ascending-sorted** array, using linear interpolation.
 *
 * `q` runs from 0 to 1. Used below to build heat thresholds that stay readable
 * when one day dwarfs every other.
 */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;

  const position = (sorted.length - 1) * Math.min(Math.max(q, 0), 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;

  const a = sorted[lower] ?? 0;
  const b = sorted[upper] ?? a;

  return a + (b - a) * weight;
}

/**
 * Thresholds that split values into `levels` buckets.
 *
 * Built from **quantiles of the non-zero values**, which is the answer to a
 * real problem: with a linear colour scale, one expensive day makes every other
 * day look identically pale, and the heat map stops saying anything.
 *
 * Why quantiles rather than a log scale, which is the other usual answer:
 * a log scale compresses large values but **does not guarantee that the small
 * ones separate**. Thirty days at ¥10 and one at ¥10000 still map to nearly the
 * same shade for the thirty. Quantiles are rank-based, so the buckets are
 * filled by construction — the outlier simply becomes the darkest cell, and the
 * rest spread across the lighter ones.
 *
 * The trade-off is deliberate and worth stating: colours are relative to the
 * period being shown, so the same amount can be a darker cell in a cheap month
 * than in an expensive one. The heat map answers "which days were heavy in this
 * period", not "how does this day compare with last year".
 */
export function bucketThresholds(
  values: readonly number[],
  levels: number,
): number[] {
  if (levels < 2) return [];

  const positive = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);

  if (positive.length === 0) return [];
  if (positive.length === 1) return [positive[0] ?? 0];

  const lowest = positive[0] ?? 0;
  const highest = positive.at(-1) ?? 0;

  // Every non-zero value identical: no threshold can separate them, and
  // pretending otherwise would scatter identical days across four colours.
  if (lowest === highest) return [lowest];

  return Array.from({ length: levels - 1 }, (_, index) =>
    quantile(positive, (index + 1) / levels),
  );
}

/**
 * Which bucket a value falls into: `0` for nothing, then `1..levels`.
 *
 * `thresholds` come from `bucketThresholds` and are ascending.
 */
export function bucketOf(value: number, thresholds: readonly number[]): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (thresholds.length === 0) return 1;

  let level = 1;
  for (const threshold of thresholds) {
    if (value > threshold) level += 1;
  }

  return level;
}

/** Blend two `#rrggbb` colours; `t` is clamped to 0..1. */
export function mixHex(from: string, to: string, t: number): string {
  const ratio = Math.min(Math.max(t, 0), 1);
  const a = hexToRgb(from);
  const b = hexToRgb(to);

  if (!a || !b) return from;

  const channel = (start: number, end: number): string =>
    Math.round(start + (end - start) * ratio)
      .toString(16)
      .padStart(2, "0");

  return `#${channel(a[0], b[0])}${channel(a[1], b[1])}${channel(a[2], b[2])}`;
}

function hexToRgb(hex: string): readonly [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) return null;

  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
