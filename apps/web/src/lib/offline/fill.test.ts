import { describe, expect, it } from "vitest";

import { DEFAULT_MONTHS_BACK, monthOf, monthsToFetch } from "./fill.js";
import { formatBytes } from "./persistence.js";

/**
 * The arithmetic behind "put the whole history on the device".
 *
 * ⚠️ Worth testing because getting it wrong is **quiet**: a missing month is not an
 * error, it is a month that is blank while the user is offline, months later, with
 * nothing on screen to connect the two.
 */
describe("monthOf", () => {
  it("writes a month the way the API expects", () => {
    // The server validates against `/^\d{4}-\d{2}$/` and answers 400 otherwise, so
    // a missing zero is a request that fails rather than a wrong month.
    expect(monthOf(new Date(2026, 9, 11))).toBe("2026-10");
    expect(monthOf(new Date(2026, 0, 1))).toBe("2026-01");
    expect(monthOf(new Date(2026, 11, 31))).toBe("2026-12");
  });
});

describe("monthsToFetch", () => {
  it("starts with the current month", () => {
    expect(monthsToFetch(new Date(2026, 9, 11), 3)[0]).toBe("2026-10");
  });

  it("walks backwards, newest first", () => {
    expect(monthsToFetch(new Date(2026, 9, 11), 4)).toEqual([
      "2026-10",
      "2026-09",
      "2026-08",
      "2026-07",
    ]);
  });

  it("crosses the year boundary", () => {
    // ⚠️ The case a hand-written loop gets wrong: `getMonth() - 1` in January is
    // `-1`, and only `Date`'s own normalisation turns that into December of the
    // previous year.
    expect(monthsToFetch(new Date(2026, 0, 15), 3)).toEqual(["2026-01", "2025-12", "2025-11"]);
  });

  it("handles a leap February without inventing a month", () => {
    expect(monthsToFetch(new Date(2028, 2, 31), 2)).toEqual(["2028-03", "2028-02"]);
  });

  it("returns nothing when asked for nothing", () => {
    expect(monthsToFetch(new Date(2026, 9, 11), 0)).toEqual([]);
  });

  it("never repeats a month", () => {
    const months = monthsToFetch(new Date(2026, 9, 11), DEFAULT_MONTHS_BACK);

    expect(new Set(months).size).toBe(months.length);
    expect(months).toHaveLength(DEFAULT_MONTHS_BACK);
  });

  it("reaches back five years by default", () => {
    const months = monthsToFetch(new Date(2026, 9, 11), DEFAULT_MONTHS_BACK);

    expect(months[months.length - 1]).toBe("2021-11");
  });
});

describe("formatBytes", () => {
  it("says bytes, kilobytes and megabytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("does not round a real amount down to nothing", () => {
    // "0 KB" for something that exists reads as a bug.
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1025)).toBe("1 KB");
  });
});
