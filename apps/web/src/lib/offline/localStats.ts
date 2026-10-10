import type {
  CategoryTotal,
  Currency,
  PeriodTotals,
  StatsBucket,
  StatsResponse,
  StatsSeriesPoint,
  Transaction,
} from "@libellum/shared";

import { fillSeriesGaps } from "@libellum/shared";

/**
 * Computing the analysis screen's numbers on the device.
 *
 * ⚠️ **This is the other half of what the owner found missing.** He had twenty
 * megabytes of history stored locally and the analysis screen still would not
 * load, because it asks `GET /stats` — a question the server answers, and which
 * cannot be asked without a network. But everything that endpoint sums is already
 * on the device: every entry, with its kind, amount, currency, category and date.
 * So the answer can be computed rather than fetched.
 *
 * ⚠️ **The arithmetic below is a deliberate mirror of `apps/api/src/routes/stats.ts`,
 * rule for rule.** Two implementations of "what did I spend in September" that
 * disagree — even by a single entry — would be worse than no offline analysis at
 * all: the user would see one total online and another on a plane, and would have
 * no way to tell which was right. The tests assert the same edge cases the server
 * handles, and a change to either side has to be made on both.
 *
 * What it is **not** is a copy of the SQL. The database groups rows and adds them
 * up; this walks an array and adds it up. Same rules, different machine.
 */

/** The fields a locally computed statistic needs from one entry. */
type Entry = Pick<
  Transaction,
  "kind" | "amountCents" | "currency" | "categoryId" | "categoryName" | "occurredLocalDate"
>;

export interface StatsRange {
  readonly from: string;
  readonly to: string;
}

/**
 * Filter to the entries that count.
 *
 * The same four conditions the server's `where` uses: the right currency, inside
 * the range **inclusive at both ends**, and not deleted. Deleted entries reach the
 * client as an absence rather than a flag — the list endpoint filters them — so
 * there is nothing to check for them here, and the comment is here so that nobody
 * adds a `deletedAt` check against a field that does not exist.
 */
export function entriesInRange(
  entries: readonly Entry[],
  range: StatsRange,
  currency: string,
): readonly Entry[] {
  return entries.filter(
    (entry) =>
      entry.currency === currency &&
      entry.occurredLocalDate >= range.from &&
      entry.occurredLocalDate <= range.to,
  );
}

/**
 * The four totals, matching `totalsFor`.
 *
 * `largestExpenseMinor` is the largest single **expense**, not the largest entry: a
 * salary must not be reported as the biggest thing that happened to the money.
 */
export function totalsFor(entries: readonly Entry[], range: StatsRange, currency: string): PeriodTotals {
  let expenseMinor = 0;
  let incomeMinor = 0;
  let count = 0;
  let largestExpenseMinor = 0;

  for (const entry of entriesInRange(entries, range, currency)) {
    count += 1;

    if (entry.kind === "expense") {
      expenseMinor += entry.amountCents;
      if (entry.amountCents > largestExpenseMinor) largestExpenseMinor = entry.amountCents;
    } else {
      incomeMinor += entry.amountCents;
    }
  }

  return {
    expenseMinor,
    incomeMinor,
    netMinor: incomeMinor - expenseMinor,
    count,
    largestExpenseMinor,
  };
}

/**
 * The series, matching `seriesFor` and `foldToMonths`.
 *
 * Days are summed first and then folded into months when the bucket is monthly —
 * the same two steps the server takes, and in that order, because folding a month
 * straight from entries would give the same numbers **except** where a month's
 * boundaries fall. Doing it the server's way means it cannot disagree.
 *
 * `fillSeriesGaps` is shared with the server rather than reimplemented: it is
 * already the thing that decides which empty periods appear, and a second version
 * of that decision is precisely the kind of divergence this file exists to avoid.
 */
export function seriesFor(
  entries: readonly Entry[],
  range: StatsRange,
  currency: Currency,
  bucket: StatsBucket,
): readonly StatsSeriesPoint[] {
  const byDay = new Map<string, StatsSeriesPoint>();

  for (const entry of entriesInRange(entries, range, currency)) {
    const day = entry.occurredLocalDate;
    const point = byDay.get(day) ?? { bucket: day, expenseMinor: 0, incomeMinor: 0 };

    byDay.set(day, {
      bucket: day,
      expenseMinor: point.expenseMinor + (entry.kind === "expense" ? entry.amountCents : 0),
      incomeMinor: point.incomeMinor + (entry.kind === "income" ? entry.amountCents : 0),
    });
  }

  const daily = fillSeriesGaps([...byDay.values()], range, "day");

  if (bucket === "day") return daily;

  return fillSeriesGaps(foldToMonths(daily), range, "month");
}

/** Sum daily points into months. Mirrors `foldToMonths`. */
export function foldToMonths(daily: readonly StatsSeriesPoint[]): readonly StatsSeriesPoint[] {
  const byMonth = new Map<string, StatsSeriesPoint>();

  for (const point of daily) {
    const month = point.bucket.slice(0, 7);
    const running = byMonth.get(month) ?? { bucket: month, expenseMinor: 0, incomeMinor: 0 };

    byMonth.set(month, {
      bucket: month,
      expenseMinor: running.expenseMinor + point.expenseMinor,
      incomeMinor: running.incomeMinor + point.incomeMinor,
    });
  }

  return [...byMonth.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/**
 * Per-category totals with shares, matching `categoriesFor`.
 *
 * ⚠️ **Shares are per kind.** A category's share of *spending* is meaningless
 * against a total that includes income, and the server says so in a comment; the
 * rule is repeated here because getting it wrong would make every percentage on
 * the donut chart wrong in a way that looks plausible.
 */
export function categoriesFor(
  entries: readonly Entry[],
  range: StatsRange,
  currency: Currency,
): readonly CategoryTotal[] {
  const totals = new Map<string, CategoryTotal>();

  for (const entry of entriesInRange(entries, range, currency)) {
    const existing = totals.get(entry.categoryId);

    if (existing === undefined) {
      totals.set(entry.categoryId, {
        categoryId: entry.categoryId,
        name: entry.categoryName,
        kind: entry.kind,
        minor: entry.amountCents,
        share: 0,
      });

      continue;
    }

    totals.set(entry.categoryId, { ...existing, minor: existing.minor + entry.amountCents });
  }

  if (totals.size === 0) return [];

  const perKind = new Map<string, number>();

  for (const total of totals.values()) {
    perKind.set(total.kind, (perKind.get(total.kind) ?? 0) + total.minor);
  }

  return [...totals.values()]
    .map((total) => {
      const kindTotal = perKind.get(total.kind) ?? 0;

      return { ...total, share: kindTotal === 0 ? 0 : total.minor / kindTotal };
    })
    .sort((a, b) => b.minor - a.minor);
}

/** How many days a range covers, inclusive. Mirrors the server's `days`. */
export function daysIn(range: StatsRange): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);

  if (Number.isNaN(from) || Number.isNaN(to)) return 0;

  return Math.round((to - from) / 86_400_000) + 1;
}

export interface LocalStatsQuery {
  readonly from: string;
  readonly to: string;
  readonly bucket: StatsBucket;
  readonly currency: Currency;
  readonly compareFrom?: string | undefined;
  readonly compareTo?: string | undefined;
}

/**
 * Everything the analysis screen draws, computed from what is on the device.
 *
 * Produces exactly the shape `GET /stats` produces, so the screen cannot tell the
 * difference — which is the whole point, and the reason the shape is asserted by
 * the type of the return value rather than described in a comment.
 */
export function computeStats(entries: readonly Entry[], query: LocalStatsQuery): StatsResponse {
  const range: StatsRange = { from: query.from, to: query.to };

  const comparisonRange: StatsRange | null =
    query.compareFrom !== undefined && query.compareTo !== undefined
      ? { from: query.compareFrom, to: query.compareTo }
      : null;

  return {
    range: {
      from: query.from,
      to: query.to,
      bucket: query.bucket,
      currency: query.currency,
      days: daysIn(range),
    },
    totals: totalsFor(entries, range, query.currency),
    series: seriesFor(entries, range, query.currency, query.bucket),
    byCategory: categoriesFor(entries, range, query.currency),
    comparison:
      comparisonRange === null
        ? null
        : { range: comparisonRange, totals: totalsFor(entries, comparisonRange, query.currency) },
  };
}
