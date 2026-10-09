import {
  daysBetween,
  fillSeriesGaps,
  statsQuerySchema,
  statsResponseSchema,
  type CategoryTotal,
  type DateRange,
  type PeriodTotals,
  type StatsBucket,
  type StatsSeriesPoint,
} from "@libellum/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { PrismaClient } from "../generated/prisma/client.js";
import { currentBookId } from "../ledger/access.js";

interface StatsRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
}

/**
 * `GET /api/v1/stats` — everything the analysis screen needs, in one request.
 *
 * The whole payload is computed here rather than in the browser. Two reasons:
 * a chart that grouped its own data would be a second implementation of rules
 * that already exist, and the two would eventually disagree; and summing a
 * year of entries in SQL is work the phone should not be doing.
 *
 * Only three queries run, whatever the range: totals by kind, totals by day
 * and kind, and totals by category and kind. Month buckets are folded from the
 * daily rows in memory — for a personal ledger that is at most 366 rows, and
 * it avoids a second SQL dialect to maintain.
 */
export function registerStatsRoutes(app: FastifyInstance, options: StatsRouteOptions): void {
  const { prisma, requireAuth } = options;

  app.get("/api/v1/stats", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);

    const query = statsQuerySchema.parse(request.query);
    const range: DateRange = { from: query.from, to: query.to };

    const comparisonRange =
      query.compareFrom !== undefined && query.compareTo !== undefined
        ? { from: query.compareFrom, to: query.compareTo }
        : null;

    const [totals, series, byCategory, comparisonTotals] = await Promise.all([
      totalsFor(prisma, bookId, range, query.currency),
      seriesFor(prisma, bookId, range, query.currency, query.bucket),
      categoriesFor(prisma, bookId, range, query.currency),
      comparisonRange === null
        ? Promise.resolve(null)
        : totalsFor(prisma, bookId, comparisonRange, query.currency),
    ]);

    return statsResponseSchema.parse({
      range: {
        ...range,
        bucket: query.bucket,
        currency: query.currency,
        days: daysBetween(range.from, range.to),
      },
      totals,
      series,
      byCategory,
      comparison:
        comparisonRange === null || comparisonTotals === null
          ? null
          : { range: comparisonRange, totals: comparisonTotals },
    });
  });
}

/** The date-only column is `@db.Date`; midnight UTC is its canonical value. */
function asDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function asKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function totalsFor(
  prisma: PrismaClient,
  bookId: string,
  range: DateRange,
  currency: string,
): Promise<PeriodTotals> {
  const where = {
    bookId,
    deletedAt: null,
    currency,
    occurredLocalDate: { gte: asDate(range.from), lte: asDate(range.to) },
  };

  const [grouped, largest] = await Promise.all([
    prisma.transaction.groupBy({
      by: ["kind"],
      where,
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    prisma.transaction.findFirst({
      where: { ...where, kind: "expense" },
      orderBy: { amountCents: "desc" },
      select: { amountCents: true },
    }),
  ]);

  let expenseMinor = 0;
  let incomeMinor = 0;
  let count = 0;

  for (const row of grouped) {
    const sum = Number(row._sum.amountCents ?? 0n);
    count += row._count._all;

    if (row.kind === "expense") expenseMinor += sum;
    else incomeMinor += sum;
  }

  return {
    expenseMinor,
    incomeMinor,
    netMinor: incomeMinor - expenseMinor,
    count,
    largestExpenseMinor: Number(largest?.amountCents ?? 0n),
  };
}

async function seriesFor(
  prisma: PrismaClient,
  bookId: string,
  range: DateRange,
  currency: string,
  bucket: StatsBucket,
): Promise<StatsSeriesPoint[]> {
  const rows = await prisma.transaction.groupBy({
    by: ["occurredLocalDate", "kind"],
    where: {
      bookId,
      deletedAt: null,
      currency,
      occurredLocalDate: { gte: asDate(range.from), lte: asDate(range.to) },
    },
    _sum: { amountCents: true },
  });

  const byDay = new Map<string, StatsSeriesPoint>();

  for (const row of rows) {
    const day = asKey(row.occurredLocalDate);
    const point = byDay.get(day) ?? { bucket: day, expenseMinor: 0, incomeMinor: 0 };
    const sum = Number(row._sum.amountCents ?? 0n);

    byDay.set(day, {
      bucket: day,
      expenseMinor: point.expenseMinor + (row.kind === "expense" ? sum : 0),
      incomeMinor: point.incomeMinor + (row.kind === "income" ? sum : 0),
    });
  }

  const daily = fillSeriesGaps([...byDay.values()], range, "day");

  if (bucket === "day") return daily;

  return fillSeriesGaps(foldToMonths(daily), range, "month");
}

function foldToMonths(daily: readonly StatsSeriesPoint[]): StatsSeriesPoint[] {
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

async function categoriesFor(
  prisma: PrismaClient,
  bookId: string,
  range: DateRange,
  currency: string,
): Promise<CategoryTotal[]> {
  const rows = await prisma.transaction.groupBy({
    by: ["categoryId", "kind"],
    where: {
      bookId,
      deletedAt: null,
      currency,
      occurredLocalDate: { gte: asDate(range.from), lte: asDate(range.to) },
    },
    _sum: { amountCents: true },
  });

  if (rows.length === 0) return [];

  const categories = await prisma.category.findMany({
    where: { bookId, id: { in: rows.map((row) => row.categoryId) } },
    select: { id: true, name: true },
  });
  const names = new Map(categories.map((category) => [category.id, category.name]));

  const totals = rows.map((row) => ({
    categoryId: row.categoryId,
    name: names.get(row.categoryId) ?? "—",
    kind: row.kind,
    minor: Number(row._sum.amountCents ?? 0n),
  }));

  // Shares are per kind: a category's share of spending is meaningless against
  // a total that includes income.
  const perKind = new Map<string, number>();
  for (const total of totals) {
    perKind.set(total.kind, (perKind.get(total.kind) ?? 0) + total.minor);
  }

  return totals
    .map((total) => {
      const kindTotal = perKind.get(total.kind) ?? 0;

      return {
        ...total,
        share: kindTotal === 0 ? 0 : total.minor / kindTotal,
      };
    })
    .sort((a, b) => b.minor - a.minor);
}
