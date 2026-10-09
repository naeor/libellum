import { quantile } from "./scales.js";

/**
 * What a series is, before anything is drawn.
 *
 * Charts fail most often on the data nobody remembered to imagine: nothing at
 * all, everything zero, one single category, one value far larger than the
 * rest. Deciding that here — in one pure function — means each chart does not
 * have to remember, and every chart answers the same way.
 */
export type ChartState =
  /** No points at all. */
  | "empty"
  /** Points exist but every value is zero. */
  | "all-zero"
  /** Exactly one bucket with a non-zero value: proportions are meaningless. */
  | "single"
  /** Enough to draw. */
  | "ready";

export interface SeriesSummary {
  readonly state: ChartState;
  readonly count: number;
  readonly total: number;
  readonly max: number;
  readonly min: number;
  /** True when the largest value dwarfs the typical one. */
  readonly hasExtreme: boolean;
  readonly hasNegative: boolean;
}

/** A value this many times the median is treated as an outlier worth flagging. */
const EXTREME_RATIO = 8;

export function summariseSeries(values: readonly number[]): SeriesSummary {
  const finite = values.filter((value) => Number.isFinite(value));
  const positive = finite.filter((value) => value > 0);

  const total = finite.reduce((sum, value) => sum + value, 0);
  const max = finite.length > 0 ? Math.max(...finite) : 0;
  const min = finite.length > 0 ? Math.min(...finite) : 0;

  const sortedPositive = [...positive].sort((a, b) => a - b);
  const median = quantile(sortedPositive, 0.5);
  const hasExtreme = median > 0 && max > median * EXTREME_RATIO;

  let state: ChartState = "ready";

  if (finite.length === 0) {
    state = "empty";
  } else if (positive.length === 0) {
    state = "all-zero";
  } else if (positive.length === 1) {
    state = "single";
  }

  return {
    state,
    count: finite.length,
    total,
    max,
    min,
    hasExtreme,
    hasNegative: finite.some((value) => value < 0),
  };
}

/**
 * Whether a comparison has anything to compare against.
 *
 * A month with no predecessor is not "a 0% change" — it is a question that
 * cannot be answered yet, and saying "0%" would be a lie the user cannot see
 * through.
 */
export function canCompare(previous: number | null | undefined): boolean {
  return previous !== null && previous !== undefined && previous !== 0;
}

/**
 * Copy for a chart that has no data to show.
 *
 * Returned as a table so a chart can print a reason rather than a blank box:
 * "no entries yet" and "every day was zero" are different situations and lead
 * to different actions.
 */
export function emptyStateMessage(state: ChartState, subject: string): string | null {
  switch (state) {
    case "empty":
      return `这个时间段还没有${subject}记录。`;

    case "all-zero":
      return `这个时间段有记录，但金额都是 0。`;

    case "single":
      return `这个时间段只有一项${subject}，占比图暂时没有意义。`;

    case "ready":
    default:
      return null;
  }
}
