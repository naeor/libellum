import { decimalsFor, formatMinor } from "@libellum/shared";

/**
 * Axis and label formatting.
 *
 * Axis labels live in a very small space, so amounts get shortened — but the
 * rule is that a shortened label must still be *true to its magnitude*. `1.2万`
 * is fine; silently dropping digits and printing `1` for 12000 is not.
 */

const TEN_THOUSAND = 10_000;
const HUNDRED_MILLION = 100_000_000;

/** `12000` becomes `1.2万`; below ten thousand the number is shown as it is. */
export function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (absolute >= HUNDRED_MILLION) {
    return `${sign}${trim(absolute / HUNDRED_MILLION)}亿`;
  }

  if (absolute >= TEN_THOUSAND) {
    return `${sign}${trim(absolute / TEN_THOUSAND)}万`;
  }

  return `${sign}${String(Math.round(absolute))}`;
}

/**
 * An axis label for an amount held in minor units.
 *
 * Converts to whole units first, so a chart of yen and a chart of dollars both
 * read in the units a person thinks in.
 */
export function formatAxisAmount(minor: number, currency: string): string {
  const scale = 10 ** decimalsFor(currency);

  return formatCompactNumber(minor / scale);
}

/** The exact amount, for a tooltip or a data label — never shortened. */
export function formatExactAmount(minor: number, currency: string): string {
  return formatMinor(minor, decimalsFor(currency));
}

/** `0.1234` becomes `12%`; `-0.05` becomes `-5%`. */
export function formatPercent(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return "—";

  const value = ratio * 100;
  const rounded = value.toFixed(digits);

  // Avoid "-0%" and "+0%", which read as a change when there is none.
  if (Number(rounded) === 0) return "0%";

  return `${Number(rounded) > 0 ? "+" : ""}${rounded}%`;
}

/** A signed percentage, or an em dash when there is nothing to compare with. */
export function formatChange(
  current: number,
  previous: number | null | undefined,
): string {
  if (previous === null || previous === undefined || previous === 0) return "—";

  return formatPercent((current - previous) / previous);
}

/** At most one decimal place, and no trailing `.0`. */
function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;

  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * A short label for one point on a time axis.
 *
 * Short because the axis is narrow and its labels are thinned; a full date
 * would be truncated into nonsense rather than shortened into meaning.
 */
export function bucketLabel(bucket: string, kind: "day" | "month"): string {
  if (kind === "month") {
    // "2026-10" reads as "10月"; the year is in the range label above the chart.
    return `${String(Number(bucket.slice(5, 7)))}月`;
  }

  return `${String(Number(bucket.slice(5, 7)))}/${String(Number(bucket.slice(8, 10)))}`;
}

/** A full date for a tooltip, where there is room to be unambiguous. */
export function bucketFullLabel(bucket: string, kind: "day" | "month"): string {
  if (kind === "month") {
    return `${bucket.slice(0, 4)} 年 ${String(Number(bucket.slice(5, 7)))} 月`;
  }

  return `${bucket.slice(0, 4)}-${bucket.slice(5, 7)}-${bucket.slice(8, 10)}`;
}
