import { describe, expect, it } from "vitest";

import { heatRangeFor } from "./StatsPage.js";

/**
 * The query window the calendar heat map asks the server for.
 *
 * The last day of a month is the one date in that window that cannot be written
 * down in advance, and it used to be faked by pasting "-31" onto the month:
 * April was asked for the 31st of April, which JavaScript accepts and rolls
 * forward to the 1st of May. The failure is silent — the request succeeds, the
 * grid looks right, and a day from the next month is counted as part of this
 * one. These cases pin the real month ends: a short month, February in a common
 * year, and February in a leap year.
 */
describe("heatRangeFor", () => {
  it("starts the month view on the first and ends it on the last day", () => {
    expect(heatRangeFor("month", "2026-10-09")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("ends a 30-day month on the 30th", () => {
    expect(heatRangeFor("month", "2026-04-15")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
  });

  it("ends February on the 28th in a common year", () => {
    expect(heatRangeFor("month", "2026-02-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("ends February on the 29th in a leap year", () => {
    expect(heatRangeFor("month", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("never names a day its own month does not have", () => {
    for (const month of ["2026-02", "2026-04", "2026-06", "2026-09", "2026-11"]) {
      expect(heatRangeFor("month", `${month}-15`).to.slice(0, 7)).toBe(month);
    }
  });

  it("keeps the rolling week ending today", () => {
    // The other view is a plain window of days and has no month end in it; it
    // is asserted here so a change to the shared helper cannot alter it quietly.
    expect(heatRangeFor("7d", "2026-10-09")).toEqual({ from: "2026-10-03", to: "2026-10-09" });
  });
});
