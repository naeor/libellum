import { z } from "zod";

import { currencySchema, transactionKindSchema } from "./ledger.js";

/**
 * Statistics.
 *
 * Two rules shape this file.
 *
 * **The server computes, the chart draws.** Every number a chart needs arrives
 * already summed, bucketed, and sorted. A chart component that started
 * grouping its own data would be a second implementation of the same rule,
 * and the two would eventually disagree.
 *
 * **Calendar dates are strings, never `Date` objects.** All grouping and
 * filtering happens on `occurred_local_date` — the calendar date on the phone
 * that recorded the entry. Converting those to `Date` would drag the server's
 * timezone into somebody else's day. The helpers below do calendar arithmetic
 * on `YYYY-MM-DD` strings, using UTC internally purely as a civil calendar.
 */

// ---------------------------------------------------------------------------
// Calendar arithmetic
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const calendarDateSchema = z
  .string()
  .regex(DATE_PATTERN, "日期格式应为 YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "日期不存在");

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function partsOf(date: string): DateParts {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

function fromUtc(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function toUtc(date: string): number {
  const { year, month, day } = partsOf(date);

  return Date.UTC(year, month - 1, day);
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * 86_400_000);
}

/** Number of days in the range, counting both ends: the 1st to the 1st is 1. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000) + 1;
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/**
 * The last day of the month, by asking the calendar rather than remembering.
 *
 * A month end is not a number that can be written down once: April has thirty
 * days, February twenty-eight or twenty-nine. Both the analysis screen's heat
 * map window and `isEndOfMonth` below build on this.
 */
export function endOfMonth(date: string): string {
  const { year, month } = partsOf(date);

  // Day 0 of the next month is the last day of this one.
  return fromUtc(Date.UTC(year, month, 0));
}

export function isFirstOfMonth(date: string): boolean {
  return date === startOfMonth(date);
}

/**
 * Whether a date is the last day of its own month.
 *
 * This is how `comparisonRangeFor` answers "is this range a whole calendar
 * month?", which is a question the date string alone cannot answer: 2026-10-31
 * is a month end, 2026-10-30 is not, and the two look equally arbitrary.
 */
export function isEndOfMonth(date: string): boolean {
  return date === endOfMonth(date);
}

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/**
 * The period to compare a range against.
 *
 * This exists because of a real trap: comparing a half-finished month with a
 * complete one always shows a large, flattering drop in spending, and the user
 * has no way to tell that the comparison is unfair rather than the month being
 * frugal. The rule differs by shape:
 *
 *  * a **complete calendar month** compares with the previous complete month
 *  * a **month so far** compares with the same stretch of the previous month,
 *    so the 1st–9th is measured against the 1st–9th
 *  * anything else — a rolling window — compares with the window of equal
 *    length immediately before it
 *
 * When the previous month is shorter, the comparison is clamped to its end:
 * the 1st–30th of March is measured against the whole of February. That is
 * imperfect, and it is the standard reading of "compared with last month";
 * the alternative, spilling into January, would compare against a month the
 * user did not ask about.
 */
export function comparisonRangeFor(range: DateRange): DateRange {
  const { from, to } = range;

  if (daysBetween(from, to) < 1 || from > to) {
    return { from, to };
  }

  if (isFirstOfMonth(from)) {
    const previousMonthEnd = addDays(startOfMonth(from), -1);
    const previousMonthStart = startOfMonth(previousMonthEnd);

    // A whole month in, a whole month back.
    if (isEndOfMonth(to)) {
      return { from: previousMonthStart, to: previousMonthEnd };
    }

    // Month so far: the same days of the previous month.
    const dayOfMonth = Number(to.slice(8, 10));
    const lastDayOfPreviousMonth = Number(previousMonthEnd.slice(8, 10));
    const comparisonsEnd = addDays(
      previousMonthStart,
      Math.min(dayOfMonth, lastDayOfPreviousMonth) - 1,
    );

    return { from: previousMonthStart, to: comparisonsEnd };
  }

  // A rolling window compares with the equivalent window just before it.
  const days = daysBetween(from, to);

  return { from: addDays(from, -days), to: addDays(from, -1) };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const STATS_BUCKETS = ["day", "month"] as const;
export const statsBucketSchema = z.enum(STATS_BUCKETS);
export type StatsBucket = z.infer<typeof statsBucketSchema>;

/** A year is plenty for one request; anything longer is a client bug. */
export const MAX_STATS_DAYS = 400;

export const statsQuerySchema = z
  .object({
    from: calendarDateSchema,
    to: calendarDateSchema,
    bucket: statsBucketSchema.default("day"),
    currency: currencySchema,
    /** Optional: when present, the response carries a comparison. */
    compareFrom: calendarDateSchema.optional(),
    compareTo: calendarDateSchema.optional(),
  })
  .refine((value) => value.from <= value.to, {
    message: "开始日期不能晚于结束日期",
    path: ["from"],
  })
  .refine((value) => daysBetween(value.from, value.to) <= MAX_STATS_DAYS, {
    message: `统计区间最长 ${String(MAX_STATS_DAYS)} 天`,
    path: ["to"],
  })
  .refine(
    (value) =>
      (value.compareFrom === undefined) === (value.compareTo === undefined),
    { message: "对比区间的起止日期必须同时提供", path: ["compareFrom"] },
  );

export type StatsQuery = z.infer<typeof statsQuerySchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export interface PeriodTotals {
  readonly expenseMinor: number;
  readonly incomeMinor: number;
  /** Income minus expense; negative means the period spent more than it earned. */
  readonly netMinor: number;
  readonly count: number;
  /** The single largest expense in the period, for "what was that one big thing". */
  readonly largestExpenseMinor: number;
}

export interface StatsSeriesPoint {
  /** `YYYY-MM-DD` for a daily bucket, `YYYY-MM` for a monthly one. */
  readonly bucket: string;
  readonly expenseMinor: number;
  readonly incomeMinor: number;
}

export interface CategoryTotal {
  readonly categoryId: string;
  readonly name: string;
  readonly kind: z.infer<typeof transactionKindSchema>;
  readonly minor: number;
  /** Share of its own kind's total, 0–1. Computed here so the donut only draws. */
  readonly share: number;
}

export interface StatsComparison {
  readonly range: DateRange;
  readonly totals: PeriodTotals;
}

export interface StatsResponse {
  readonly range: DateRange & {
    readonly bucket: StatsBucket;
    readonly currency: z.infer<typeof currencySchema>;
    readonly days: number;
  };
  readonly totals: PeriodTotals;
  readonly series: readonly StatsSeriesPoint[];
  readonly byCategory: readonly CategoryTotal[];
  readonly comparison: StatsComparison | null;
}

export const periodTotalsSchema = z.object({
  expenseMinor: z.number().int(),
  incomeMinor: z.number().int(),
  netMinor: z.number().int(),
  count: z.number().int(),
  largestExpenseMinor: z.number().int(),
});

export const statsResponseSchema = z.object({
  range: z.object({
    from: calendarDateSchema,
    to: calendarDateSchema,
    bucket: statsBucketSchema,
    currency: currencySchema,
    days: z.number().int().positive(),
  }),
  totals: periodTotalsSchema,
  series: z.array(
    z.object({
      bucket: z.string(),
      expenseMinor: z.number().int(),
      incomeMinor: z.number().int(),
    }),
  ),
  byCategory: z.array(
    z.object({
      categoryId: z.string(),
      name: z.string(),
      kind: transactionKindSchema,
      minor: z.number().int(),
      share: z.number(),
    }),
  ),
  comparison: z
    .object({
      range: z.object({ from: calendarDateSchema, to: calendarDateSchema }),
      totals: periodTotalsSchema,
    })
    .nullable(),
});

// ---------------------------------------------------------------------------
// Presentation-independent helpers
// ---------------------------------------------------------------------------

/** Every bucket in the range, including the days with nothing in them. */
export function fillSeriesGaps(
  points: readonly StatsSeriesPoint[],
  range: DateRange,
  bucket: StatsBucket,
): StatsSeriesPoint[] {
  const byBucket = new Map(points.map((point) => [point.bucket, point]));
  const keys: string[] = [];

  if (bucket === "month") {
    let cursor = range.from.slice(0, 7);

    while (cursor <= range.to.slice(0, 7)) {
      keys.push(cursor);
      const [year, month] = cursor.split("-").map(Number) as [number, number];
      const next = month === 12 ? `${String(year + 1)}-01` : `${String(year)}-${String(month + 1).padStart(2, "0")}`;
      cursor = next;
    }
  } else {
    for (let cursor = range.from; cursor <= range.to; cursor = addDays(cursor, 1)) {
      keys.push(cursor);
    }
  }

  return keys.map(
    (key) => byBucket.get(key) ?? { bucket: key, expenseMinor: 0, incomeMinor: 0 },
  );
}

/** The average expense per day, rounded to a whole minor unit. */
export function averagePerDay(totals: PeriodTotals, days: number): number {
  if (days <= 0) return 0;

  return Math.round(totals.expenseMinor / days);
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/**
 * The shortcuts offered in the interface.
 *
 * These are **shortcuts, not a model**. A preset is expanded into a concrete
 * `{ from, to }` before anything else sees it, and every chart and query takes
 * that range. Supporting "the two months I was renovating" later then means
 * adding a way to pick dates, not rewriting the five charts — which is exactly
 * why the four buttons are not what the drawing code receives.
 */
export const STATS_RANGES = ["7d", "30d", "90d", "365d"] as const;
export const statsRangeSchema = z.enum(STATS_RANGES);
export type StatsRangeKey = z.infer<typeof statsRangeSchema>;

const RANGE_DAYS: Readonly<Record<StatsRangeKey, number>> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
};

export const RANGE_LABELS: Readonly<Record<StatsRangeKey, string>> = {
  "7d": "近 7 天",
  "30d": "近 30 天",
  "90d": "近 90 天",
  "365d": "近一年",
};

/**
 * Expand a preset into a range ending today, inclusive of both ends.
 *
 * `today` is passed in rather than read from the clock: it is the **phone's**
 * calendar date, and the server must never decide what day it is for somebody
 * else.
 */
export function rangeForPreset(preset: StatsRangeKey, today: string): DateRange {
  return { from: addDays(today, -(RANGE_DAYS[preset] - 1)), to: today };
}

/**
 * The bucket a preset is drawn in.
 *
 * A year of daily points is 365 marks on a chart 350 pixels wide — a smear,
 * not a trend. Longer periods are summarised by month, which is also how
 * people talk about them.
 */
export function bucketForPreset(preset: StatsRangeKey): StatsBucket {
  return RANGE_DAYS[preset] > 120 ? "month" : "day";
}
