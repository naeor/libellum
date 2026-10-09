import { describe, expect, it } from "vitest";

import {
  addDays,
  averagePerDay,
  comparisonRangeFor,
  daysBetween,
  endOfMonth,
  fillSeriesGaps,
  isEndOfMonth,
  isFirstOfMonth,
  startOfMonth,
  statsQuerySchema,
} from "./stats.js";

/**
 * Statistics rest on calendar arithmetic over `YYYY-MM-DD` strings. Getting it
 * wrong is quiet and expensive — an off-by-one here silently attributes a
 * day's spending to the wrong month, and every chart built on it is wrong in a
 * way nobody notices until the totals do not add up.
 */
describe("calendar arithmetic", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-10-09", 1)).toBe("2026-10-10");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(endOfMonth("2028-02-10")).toBe("2028-02-29");
  });

  it("counts both ends of a range", () => {
    expect(daysBetween("2026-10-01", "2026-10-01")).toBe(1);
    expect(daysBetween("2026-10-01", "2026-10-09")).toBe(9);
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(31);
  });

  it("finds the ends of a month without being told how long it is", () => {
    expect(endOfMonth("2026-02-01")).toBe("2026-02-28");
    expect(endOfMonth("2026-04-15")).toBe("2026-04-30");
    expect(startOfMonth("2026-10-09")).toBe("2026-10-01");
  });

  it("recognises the first and last day", () => {
    expect(isFirstOfMonth("2026-10-01")).toBe(true);
    expect(isFirstOfMonth("2026-10-02")).toBe(false);
    expect(isEndOfMonth("2026-10-31")).toBe(true);
    expect(isEndOfMonth("2026-10-30")).toBe(false);
  });
});

describe("comparisonRangeFor", () => {
  it("compares a finished month with the previous finished month", () => {
    expect(comparisonRangeFor({ from: "2026-10-01", to: "2026-10-31" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("compares a month so far with the same days of the previous month", () => {
    // The case this whole function exists for: on the 9th of October, measuring
    // against all of September would show a drop that is not real.
    expect(comparisonRangeFor({ from: "2026-10-01", to: "2026-10-09" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-09",
    });
  });

  it("clamps to the end of a shorter previous month", () => {
    // The 1st–30th of March against February: 28 days is all February has.
    expect(comparisonRangeFor({ from: "2026-03-01", to: "2026-03-30" })).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("compares a rolling window with the window just before it", () => {
    expect(comparisonRangeFor({ from: "2026-10-05", to: "2026-10-11" })).toEqual({
      from: "2026-09-28",
      to: "2026-10-04",
    });
  });

  it("crosses the year boundary correctly", () => {
    expect(comparisonRangeFor({ from: "2026-01-01", to: "2026-01-15" })).toEqual({
      from: "2025-12-01",
      to: "2025-12-15",
    });
  });

  it("returns the range itself when it is not a range at all", () => {
    expect(comparisonRangeFor({ from: "2026-10-09", to: "2026-10-01" })).toEqual({
      from: "2026-10-09",
      to: "2026-10-01",
    });
  });
});

describe("statsQuerySchema", () => {
  const valid = { from: "2026-10-01", to: "2026-10-09", currency: "CNY" } as const;

  it("defaults to a daily bucket", () => {
    expect(statsQuerySchema.parse(valid).bucket).toBe("day");
  });

  it("refuses a backwards range", () => {
    expect(() => statsQuerySchema.parse({ ...valid, from: "2026-10-09", to: "2026-10-01" })).toThrow();
  });

  it("refuses a range longer than a year", () => {
    expect(() => statsQuerySchema.parse({ ...valid, from: "2020-01-01", to: "2026-10-09" })).toThrow();
  });

  it("refuses a malformed date", () => {
    expect(() => statsQuerySchema.parse({ ...valid, from: "2026-10" })).toThrow();
    expect(() => statsQuerySchema.parse({ ...valid, to: "2026-02-31" })).toThrow();
  });

  it("requires the comparison range to be given in full or not at all", () => {
    expect(() => statsQuerySchema.parse({ ...valid, compareFrom: "2026-09-01" })).toThrow();
    expect(
      statsQuerySchema.parse({ ...valid, compareFrom: "2026-09-01", compareTo: "2026-09-09" })
        .compareTo,
    ).toBe("2026-09-09");
  });
});

describe("fillSeriesGaps", () => {
  it("gives empty days a zero instead of leaving a hole", () => {
    // A missing day and a day with nothing spent look identical on a chart
    // unless the gap is filled deliberately.
    const filled = fillSeriesGaps(
      [{ bucket: "2026-10-02", expenseMinor: 500, incomeMinor: 0 }],
      { from: "2026-10-01", to: "2026-10-03" },
      "day",
    );

    expect(filled).toHaveLength(3);
    expect(filled.map((point) => point.bucket)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(filled[0]?.expenseMinor).toBe(0);
    expect(filled[1]?.expenseMinor).toBe(500);
  });

  it("keeps the values it was given", () => {
    const filled = fillSeriesGaps(
      [{ bucket: "2026-10", expenseMinor: 700, incomeMinor: 900 }],
      { from: "2026-09-01", to: "2026-11-30" },
      "month",
    );

    expect(filled.map((point) => point.bucket)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(filled[1]).toEqual({ bucket: "2026-10", expenseMinor: 700, incomeMinor: 900 });
  });

  it("crosses a year boundary when filling months", () => {
    const filled = fillSeriesGaps([], { from: "2026-11-01", to: "2027-02-28" }, "month");

    expect(filled.map((point) => point.bucket)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });
});

describe("averagePerDay", () => {
  it("divides expense over the days in the period", () => {
    expect(
      averagePerDay(
        { expenseMinor: 900, incomeMinor: 0, netMinor: -900, count: 3, largestExpenseMinor: 500 },
        9,
      ),
    ).toBe(100);
  });

  it("does not divide by zero", () => {
    expect(
      averagePerDay({ expenseMinor: 900, incomeMinor: 0, netMinor: -900, count: 0, largestExpenseMinor: 0 }, 0),
    ).toBe(0);
  });
});
