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
 * A chart with nothing in it still owes the reader a reason: "no entries in
 * this period" and "entries that all came to zero" are different facts and
 * lead to different actions. The wording states the fact plainly and in the
 * register of a statement from the product, not a remark from a person — a
 * ledger is a record, and the text around it should sound like one.
 */
export function emptyStateMessage(state: ChartState, subject: string): string | null {
  switch (state) {
    case "empty":
      return `所选时段暂无${subject}记录。`;

    case "all-zero":
      return "所选时段已有记录，但金额均为零。";

    case "single":
      return `所选时段仅有一项${subject}，占比分析暂不适用。`;

    case "ready":
    default:
      return null;
  }
}
