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
 * Which notice a chart should show, if any.
 *
 * `hasEntries` cannot be worked out from the values, and this is the bug that
 * taught us so: a series is gap-filled, so every day of the period is present
 * with a zero. A currency that has never been used therefore arrives as a row
 * of zeroes — identical in shape to a period in which nothing was spent. Only
 * the totals know which of the two happened, so the caller has to say.
 *
 * A currency nobody has ever recorded in must say "no entries", not "the
 * amounts were all zero". The second sentence tells the user they spent
 * nothing, which is a claim about their money and is not true.
 */
export function chartNotice(
  hasEntries: boolean,
  values: readonly number[],
  subject: string,
): string | null {
  if (!hasEntries) return `所选时段暂无${subject}记录。`;

  const summary = summariseSeries(values);

  if (summary.state === "all-zero") return "所选时段已有记录，但金额均为零。";

  return null;
}

/**
 * Copy for a chart that has no data to show.
 *
 * A chart with nothing in it still owes the reader a reason, and "nothing was
 * recorded" and "everything came to zero" are different facts. The wording
 * states the fact plainly, in the register of a statement from the product
 * rather than a remark from a person — a ledger is a record, and the text
 * around it should sound like one.
 *
 * Use `chartNotice` where the values have been gap-filled; this one is for
 * data that naturally has no rows when there is nothing to show.
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
