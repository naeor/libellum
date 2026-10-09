import { describe, expect, it } from "vitest";

import { formatAxisAmount, formatChange, formatCompactNumber, formatPercent } from "./format.js";
import { canCompare, emptyStateMessage, summariseSeries } from "./guards.js";
import {
  bucketOf,
  bucketThresholds,
  createLinearScale,
  extentOf,
  mixHex,
  niceDomain,
  quantile,
  ticksFor,
} from "./scales.js";

/**
 * The chart foundation is pure arithmetic on purpose: every rule that decides
 * what a chart shows lives here, where it can be tested without rendering
 * anything.
 */

describe("extentOf", () => {
  it("finds the range", () => {
    expect(extentOf([3, 1, 4, 1, 5])).toEqual([1, 5]);
  });

  it("returns null when there is nothing to measure", () => {
    expect(extentOf([])).toBeNull();
    expect(extentOf([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it("ignores values that are not finite", () => {
    expect(extentOf([1, Number.NaN, 9, Number.POSITIVE_INFINITY])).toEqual([1, 9]);
  });
});

describe("createLinearScale", () => {
  it("maps a domain onto a range", () => {
    const scale = createLinearScale([0, 100], [0, 200]);
    expect(scale(0)).toBe(0);
    expect(scale(50)).toBe(100);
    expect(scale(100)).toBe(200);
  });

  it("inverts back to the value", () => {
    const scale = createLinearScale([0, 100], [0, 200]);
    expect(scale.invert(100)).toBeCloseTo(50);
  });

  it("does not divide by zero when every value is the same", () => {
    const scale = createLinearScale([5, 5], [0, 100]);
    expect(scale(5)).toBe(50);
  });
});

describe("niceDomain", () => {
  it("rounds the ends out to friendly numbers", () => {
    // The raw maximum is 948; axis labels reading 0/250/500/750/1000 are
    // readable, 0/237/474/711/948 are not.
    const [low, high] = niceDomain(0, 948, 4);
    expect(low).toBe(0);
    expect(high % 250).toBe(0);
    expect(high).toBeGreaterThanOrEqual(948);
  });

  it("always includes zero for a positive series", () => {
    const [low] = niceDomain(400, 900, 4);
    expect(low).toBe(0);
  });

  it("keeps negative values on the chart", () => {
    const [low, high] = niceDomain(-300, 500, 4);
    expect(low).toBeLessThanOrEqual(-300);
    expect(high).toBeGreaterThanOrEqual(500);
  });

  it("produces a usable domain for a flat series of zeroes", () => {
    const [low, high] = niceDomain(0, 0, 4);
    expect(high).toBeGreaterThan(low);
  });

  it("survives values that are not finite", () => {
    expect(niceDomain(Number.NaN, Number.NaN)).toEqual([0, 1]);
  });
});

describe("ticksFor", () => {
  it("spans the domain inclusively", () => {
    expect(ticksFor([0, 100], 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it("returns a single tick for a zero-width domain", () => {
    expect(ticksFor([7, 7], 4)).toEqual([7]);
  });
});

describe("quantile", () => {
  it("interpolates between neighbours", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
  });

  it("handles degenerate input", () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([9], 0.5)).toBe(9);
  });
});

describe("bucketThresholds and bucketOf", () => {
  it("ignores zero days — an empty day is not a small one", () => {
    const thresholds = bucketThresholds([0, 0, 0, 10, 20, 30, 40], 4);
    expect(thresholds.every((value) => value > 0)).toBe(true);
  });

  it("spreads the buckets even when one day dwarfs the rest", () => {
    // The problem this exists for: one ¥10000 day and twenty-nine ¥10 days.
    // A linear scale would make every ordinary day look identical.
    const values = [...Array.from({ length: 29 }, () => 10), 10_000];
    const thresholds = bucketThresholds(values, 4);

    expect(bucketOf(10, thresholds)).toBeGreaterThanOrEqual(1);
    expect(bucketOf(10_000, thresholds)).toBe(4);
    expect(bucketOf(0, thresholds)).toBe(0);
  });

  it("keeps identical values in one bucket instead of scattering them", () => {
    const thresholds = bucketThresholds([5, 5, 5, 5], 4);
    const levels = new Set([5, 5, 5, 5].map((value) => bucketOf(value, thresholds)));

    expect(levels.size).toBe(1);
  });

  it("reports level 0 for nothing at all", () => {
    expect(bucketOf(0, [])).toBe(0);
    expect(bucketOf(-5, [1, 2, 3])).toBe(0);
  });
});

describe("mixHex", () => {
  it("blends two colours", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("returns the input when a colour is malformed", () => {
    expect(mixHex("not-a-colour", "#ffffff", 0.5)).toBe("not-a-colour");
  });
});

describe("formatCompactNumber", () => {
  it("shortens large numbers without lying about their size", () => {
    expect(formatCompactNumber(1200)).toBe("1200");
    expect(formatCompactNumber(12_000)).toBe("1.2万");
    expect(formatCompactNumber(120_000)).toBe("12万");
    expect(formatCompactNumber(120_000_000)).toBe("1.2亿");
  });

  it("keeps the sign", () => {
    expect(formatCompactNumber(-12_000)).toBe("-1.2万");
  });
});

describe("formatAxisAmount", () => {
  it("converts minor units to whole units first", () => {
    // 120000 cents is ¥1200, shown as a plain number.
    expect(formatAxisAmount(120_000, "CNY")).toBe("1200");
  });

  it("treats a currency without decimals as whole units already", () => {
    // 12000 yen is ¥12000 — a factor of a hundred away from the cent case.
    expect(formatAxisAmount(12_000, "JPY")).toBe("1.2万");
  });
});

describe("formatPercent and formatChange", () => {
  it("formats a ratio as a signed percentage", () => {
    expect(formatPercent(0.12)).toBe("+12%");
    expect(formatPercent(-0.05)).toBe("-5%");
  });

  it("never shows a signed zero", () => {
    expect(formatPercent(0.0001)).toBe("0%");
    expect(formatPercent(-0.0001)).toBe("0%");
  });

  it("refuses to invent a comparison", () => {
    expect(formatChange(100, 0)).toBe("—");
    expect(formatChange(100, null)).toBe("—");
    expect(formatChange(150, 100)).toBe("+50%");
  });
});

describe("summariseSeries", () => {
  it("recognises an empty series", () => {
    const summary = summariseSeries([]);
    expect(summary.state).toBe("empty");
    expect(summary.total).toBe(0);
  });

  it("recognises a series of zeroes as different from empty", () => {
    // "No entries" and "entries that were all zero" lead to different actions.
    const summary = summariseSeries([0, 0, 0]);
    expect(summary.state).toBe("all-zero");
    expect(summary.count).toBe(3);
  });

  it("flags a single category, where proportions mean nothing", () => {
    expect(summariseSeries([0, 500, 0]).state).toBe("single");
  });

  it("flags an outlier against the median", () => {
    const ordinary = Array.from({ length: 20 }, () => 100);
    expect(summariseSeries(ordinary).hasExtreme).toBe(false);
    expect(summariseSeries([...ordinary, 100_000]).hasExtreme).toBe(true);
  });

  it("notices negative values", () => {
    expect(summariseSeries([100, -50]).hasNegative).toBe(true);
  });
});

describe("canCompare and emptyStateMessage", () => {
  it("treats a missing or zero baseline as no comparison", () => {
    expect(canCompare(null)).toBe(false);
    expect(canCompare(undefined)).toBe(false);
    expect(canCompare(0)).toBe(false);
    expect(canCompare(1)).toBe(true);
  });

  it("explains why a chart is blank instead of leaving it blank", () => {
    expect(emptyStateMessage("empty", "支出")).toContain("还没有");
    expect(emptyStateMessage("all-zero", "支出")).toContain("0");
    expect(emptyStateMessage("single", "支出")).toContain("只有一项");
    expect(emptyStateMessage("ready", "支出")).toBeNull();
  });
});
