import { describe, expect, it } from "vitest";

import { categoriesFor, computeStats, daysIn, entriesInRange, seriesFor, totalsFor } from "./localStats.js";

/**
 * The analysis screen's numbers, computed on the device.
 *
 * ⚠️ **These assertions are about agreeing with the server**, and that is the whole
 * point of the file. Two implementations of "what did I spend in September" that
 * differ — even by one entry — would be worse than having no offline analysis: the
 * user would see one total online and another on a plane, with no way to tell which
 * was right. So the cases below are the ones `apps/api/src/routes/stats.ts` handles
 * explicitly, checked here as rules rather than as values chosen to fit.
 */
type Entry = Parameters<typeof totalsFor>[0][number];

function entry(overrides: Partial<Entry> & { readonly amountCents: number; readonly occurredLocalDate: string }): Entry {
  return {
    kind: "expense",
    currency: "CNY",
    categoryId: "c-food",
    categoryName: "餐饮",
    ...overrides,
  } as Entry;
}

const SEPTEMBER = { from: "2026-09-01", to: "2026-09-30" };

describe("entriesInRange", () => {
  it("includes both ends of the range", () => {
    // The server's `where` is `gte`/`lte`, so the last day of a month counts. An
    // exclusive end would silently drop one day of every range — and the first day
    // of the next month is the entry people notice missing.
    const entries = [
      entry({ amountCents: 100, occurredLocalDate: "2026-09-01" }),
      entry({ amountCents: 200, occurredLocalDate: "2026-09-30" }),
      entry({ amountCents: 400, occurredLocalDate: "2026-10-01" }),
    ];

    expect(entriesInRange(entries, SEPTEMBER, "CNY")).toHaveLength(2);
  });

  it("keeps only the requested currency", () => {
    // v1 never converts, and adding ¥ to $ would be meaningless rather than wrong —
    // which is worse, because it looks like a number.
    const entries = [
      entry({ amountCents: 100, occurredLocalDate: "2026-09-05" }),
      entry({ amountCents: 900, occurredLocalDate: "2026-09-05", currency: "USD" }),
    ];

    expect(entriesInRange(entries, SEPTEMBER, "CNY")).toHaveLength(1);
  });
});

describe("totalsFor", () => {
  it("adds spending and income separately, and nets them", () => {
    const entries = [
      entry({ amountCents: 3_800, occurredLocalDate: "2026-09-01" }),
      entry({ amountCents: 1_200, occurredLocalDate: "2026-09-02" }),
      entry({ amountCents: 50_000, occurredLocalDate: "2026-09-10", kind: "income" }),
    ];

    const totals = totalsFor(entries, SEPTEMBER, "CNY");

    expect(totals.expenseMinor).toBe(5_000);
    expect(totals.incomeMinor).toBe(50_000);
    expect(totals.netMinor).toBe(45_000);
    expect(totals.count).toBe(3);
  });

  it("⚠️ reports the largest *expense*, not the largest entry", () => {
    // The server filters `kind: "expense"` before taking the maximum, so a salary
    // must not be reported as the biggest thing that happened to the money.
    const entries = [
      entry({ amountCents: 3_800, occurredLocalDate: "2026-09-01" }),
      entry({ amountCents: 900_000, occurredLocalDate: "2026-09-10", kind: "income" }),
    ];

    expect(totalsFor(entries, SEPTEMBER, "CNY").largestExpenseMinor).toBe(3_800);
  });

  it("is all zeroes for a month with nothing in it", () => {
    const totals = totalsFor([], SEPTEMBER, "CNY");

    expect(totals).toEqual({
      expenseMinor: 0,
      incomeMinor: 0,
      netMinor: 0,
      count: 0,
      largestExpenseMinor: 0,
    });
  });
});

describe("seriesFor", () => {
  it("fills every day of the range, including the empty ones", () => {
    // The chart draws a line across the whole range; missing days would make it
    // jump rather than dip.
    const entries = [entry({ amountCents: 100, occurredLocalDate: "2026-09-15" })];
    const series = seriesFor(entries, SEPTEMBER, "CNY", "day");

    expect(series).toHaveLength(30);
    expect(series[14]?.expenseMinor).toBe(100);
    expect(series[0]?.expenseMinor).toBe(0);
  });

  it("folds days into months when the bucket is monthly", () => {
    const range = { from: "2026-08-01", to: "2026-09-30" };
    const entries = [
      entry({ amountCents: 100, occurredLocalDate: "2026-08-05" }),
      entry({ amountCents: 200, occurredLocalDate: "2026-08-20" }),
      entry({ amountCents: 400, occurredLocalDate: "2026-09-02" }),
    ];

    const series = seriesFor(entries, range, "CNY", "month");

    expect(series).toEqual([
      { bucket: "2026-08", expenseMinor: 300, incomeMinor: 0 },
      { bucket: "2026-09", expenseMinor: 400, incomeMinor: 0 },
    ]);
  });

  it("keeps income apart from spending in the series", () => {
    const entries = [
      entry({ amountCents: 100, occurredLocalDate: "2026-09-05" }),
      entry({ amountCents: 900, occurredLocalDate: "2026-09-05", kind: "income" }),
    ];

    const series = seriesFor(entries, SEPTEMBER, "CNY", "day");

    expect(series[4]?.expenseMinor).toBe(100);
    expect(series[4]?.incomeMinor).toBe(900);
  });
});

describe("categoriesFor", () => {
  it("⚠️ computes the share within its own kind", () => {
    // ⚠️ A category's share of *spending* is meaningless against a total that
    // includes income — the server says so in a comment, and getting it wrong makes
    // every percentage on the donut chart wrong in a way that looks plausible.
    const entries = [
      entry({ amountCents: 300, occurredLocalDate: "2026-09-01", categoryId: "a", categoryName: "餐饮" }),
      entry({ amountCents: 100, occurredLocalDate: "2026-09-02", categoryId: "b", categoryName: "交通" }),
      entry({
        amountCents: 1_000,
        occurredLocalDate: "2026-09-03",
        categoryId: "c",
        categoryName: "工资",
        kind: "income",
      }),
    ];

    const categories = categoriesFor(entries, SEPTEMBER, "CNY");
    const food = categories.find((category) => category.categoryId === "a");
    const salary = categories.find((category) => category.categoryId === "c");

    // 300 of 400 spent, not 300 of 1400.
    expect(food?.share).toBeCloseTo(0.75);
    expect(salary?.share).toBeCloseTo(1);
  });

  it("sorts by amount, largest first", () => {
    const entries = [
      entry({ amountCents: 100, occurredLocalDate: "2026-09-01", categoryId: "b", categoryName: "交通" }),
      entry({ amountCents: 300, occurredLocalDate: "2026-09-02", categoryId: "a", categoryName: "餐饮" }),
    ];

    expect(categoriesFor(entries, SEPTEMBER, "CNY").map((category) => category.categoryId)).toEqual(["a", "b"]);
  });

  it("returns nothing for a month with nothing in it", () => {
    expect(categoriesFor([], SEPTEMBER, "CNY")).toEqual([]);
  });
});

describe("daysIn", () => {
  it("counts both ends", () => {
    expect(daysIn({ from: "2026-09-01", to: "2026-09-30" })).toBe(30);
    expect(daysIn({ from: "2026-09-01", to: "2026-09-01" })).toBe(1);
  });

  it("handles a leap February", () => {
    expect(daysIn({ from: "2028-02-01", to: "2028-02-29" })).toBe(29);
  });
});

describe("computeStats", () => {
  const entries = [
    entry({ amountCents: 3_800, occurredLocalDate: "2026-09-01" }),
    entry({ amountCents: 1_200, occurredLocalDate: "2026-09-02" }),
    entry({ amountCents: 5_000, occurredLocalDate: "2026-08-10" }),
  ];

  it("produces the shape the analysis screen expects", () => {
    // It has to be the same shape `GET /stats` returns, or the screen would have to
    // know whether it was online — which is exactly what this is here to avoid.
    const stats = computeStats(entries, {
      from: "2026-09-01",
      to: "2026-09-30",
      bucket: "day",
      currency: "CNY",
    });

    expect(stats.range).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      bucket: "day",
      currency: "CNY",
      days: 30,
    });
    expect(stats.totals.expenseMinor).toBe(5_000);
    expect(stats.series).toHaveLength(30);
    expect(stats.comparison).toBeNull();
  });

  it("includes the comparison period when one is given", () => {
    const stats = computeStats(entries, {
      from: "2026-09-01",
      to: "2026-09-30",
      bucket: "day",
      currency: "CNY",
      compareFrom: "2026-08-01",
      compareTo: "2026-08-31",
    });

    expect(stats.comparison?.range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(stats.comparison?.totals.expenseMinor).toBe(5_000);
  });

  it("computes an empty ledger without inventing anything", () => {
    const stats = computeStats([], {
      from: "2026-09-01",
      to: "2026-09-30",
      bucket: "month",
      currency: "CNY",
    });

    expect(stats.totals.count).toBe(0);
    expect(stats.byCategory).toEqual([]);
    expect(stats.series).toEqual([{ bucket: "2026-09", expenseMinor: 0, incomeMinor: 0 }]);
  });
});
