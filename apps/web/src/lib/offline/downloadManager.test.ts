import { describe, expect, it } from "vitest";

import { queryKeys, transactionFilters } from "../queries.js";
import { monthRows, monthLabel, estimateBytes, managerMonths } from "./downloadManager.js";
import { monthRange, summaryFor } from "./localStats.js";

/**
 * ⚠️ **The bug this file exists for.**
 *
 * TanStack Query hashes a key with `JSON.stringify`, and **`JSON.stringify` drops
 * `undefined` values.** So `{month, kind, categoryId}` and
 * `{month, kind, categoryId, currency: undefined}` are different strings, different
 * hashes, and **different cache entries** — even though they ask the server for
 * exactly the same thing.
 *
 * The offline fill wrote four fields and the detail screen wrote three, so a month
 * the user had waited to download was stored under a key the screen never looked up.
 * **The symptom was "离线看不到详情", and the cause was two objects that looked
 * identical in the source.** That is why the key shape now has a test rather than a
 * comment.
 */
describe("the transaction query key", () => {
  /** The same hashing TanStack Query uses: `JSON.stringify` with sorted keys. */
  function hashKey(key: unknown): string {
    return JSON.stringify(key, (_, value: unknown) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.keys(value as object)
            .sort()
            .reduce<Record<string, unknown>>((result, name) => {
              result[name] = (value as Record<string, unknown>)[name];
              return result;
            }, {})
        : value,
    );
  }

  it("is the same whether a caller passes three fields or four", () => {
    // The exact mismatch that shipped.
    const screen = transactionFilters({ month: "2026-10", kind: undefined, categoryId: undefined });
    const fill = transactionFilters({ month: "2026-10" });

    expect(hashKey(queryKeys.transactions(screen))).toBe(hashKey(queryKeys.transactions(fill)));
  });

  it("produces the same key for an empty filter and an all-undefined one", () => {
    expect(hashKey(queryKeys.transactions(transactionFilters()))).toBe(
      hashKey(queryKeys.transactions(transactionFilters({ month: undefined }))),
    );
  });

  it("still separates genuinely different months", () => {
    // Normalising must not collapse two months into one entry.
    expect(hashKey(queryKeys.transactions(transactionFilters({ month: "2026-09" })))).not.toBe(
      hashKey(queryKeys.transactions(transactionFilters({ month: "2026-10" }))),
    );
  });

  it("still separates a filtered view from an unfiltered one", () => {
    // The detail screen filters by category; those entries are not all of them.
    expect(hashKey(queryKeys.transactions(transactionFilters({ month: "2026-10" })))).not.toBe(
      hashKey(queryKeys.transactions(transactionFilters({ month: "2026-10", categoryId: "c1" }))),
    );
  });

  it("demonstrates why the normalisation is needed at all", () => {
    // Written as a fact about `JSON.stringify` rather than about this project, so
    // that the reason survives even if the fix is ever refactored.
    expect(JSON.stringify({ a: 1, b: undefined })).toBe(JSON.stringify({ a: 1, b: undefined }));
    expect(JSON.stringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("monthRange", () => {
  it("covers the whole month", () => {
    expect(monthRange("2026-09")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("⚠️ computes the last day rather than assuming the 30th", () => {
    // A hand-written `-30` would silently drop the 31st from seven months a year —
    // a bug that appears once a month and looks like a lost entry.
    expect(monthRange("2026-10").to).toBe("2026-10-31");
    expect(monthRange("2026-01").to).toBe("2026-01-31");
  });

  it("handles February in a leap year", () => {
    expect(monthRange("2028-02").to).toBe("2028-02-29");
    expect(monthRange("2026-02").to).toBe("2026-02-28");
  });

  it("does not crash on a malformed month", () => {
    expect(monthRange("nonsense")).toEqual({ from: "nonsense", to: "nonsense" });
  });
});

describe("summaryFor", () => {
  const range = monthRange("2026-09");

  function entry(amountCents: number, kind: "expense" | "income", currency: string, date = "2026-09-10") {
    return { amountCents, kind, currency, occurredLocalDate: date } as never;
  }

  it("totals each currency separately, never converting", () => {
    // Adding ¥ to $ would be meaningless rather than wrong — which is worse,
    // because it looks like a number.
    const summary = summaryFor(
      [entry(3_800, "expense", "CNY"), entry(900, "expense", "USD")],
      "2026-09",
      range,
    );

    expect(summary.currencies).toHaveLength(2);
    expect(summary.currencies.find((row) => row.currency === "CNY")?.expenseCents).toBe(3_800);
  });

  it("ranks by volume, ignoring direction", () => {
    // 1000 spent and 500 earned is 1500 of activity, so it leads.
    const summary = summaryFor(
      [entry(1_000, "expense", "CNY"), entry(500, "income", "CNY"), entry(200, "expense", "USD")],
      "2026-09",
      range,
    );

    expect(summary.currencies.map((row) => row.currency)).toEqual(["CNY", "USD"]);
    expect(summary.currencies[0]?.volumeCents).toBe(1_500);
  });

  it("computes the balance as income minus expense", () => {
    const summary = summaryFor(
      [entry(1_000, "expense", "CNY"), entry(2_500, "income", "CNY")],
      "2026-09",
      range,
    );

    expect(summary.currencies[0]?.balanceCents).toBe(1_500);
  });

  it("counts each kind separately", () => {
    const summary = summaryFor(
      [entry(100, "expense", "CNY"), entry(200, "expense", "CNY"), entry(300, "income", "CNY")],
      "2026-09",
      range,
    );

    expect(summary.currencies[0]?.expenseCount).toBe(2);
    expect(summary.currencies[0]?.incomeCount).toBe(1);
  });

  it("leaves out another month's entries", () => {
    const summary = summaryFor(
      [entry(100, "expense", "CNY"), entry(900, "expense", "CNY", "2026-10-01")],
      "2026-09",
      range,
    );

    expect(summary.currencies[0]?.expenseCents).toBe(100);
  });

  it("reports an empty month honestly", () => {
    expect(summaryFor([], "2026-09", range)).toEqual({ month: "2026-09", currencies: [] });
  });
});

describe("the download manager's table", () => {
  it("names months the way a person says them", () => {
    expect(monthLabel("2026-09")).toBe("2026年9月");
    expect(monthLabel("2026-12")).toBe("2026年12月");
  });

  it("leaves a malformed key alone", () => {
    // Rather than producing "undefined年NaN月".
    expect(monthLabel("nonsense")).toBe("nonsense");
  });

  it("lists the months newest first", () => {
    expect(managerMonths(new Date(2026, 9, 11), 3)).toEqual(["2026-10", "2026-09", "2026-08"]);
  });

  it("crosses the year boundary", () => {
    expect(managerMonths(new Date(2026, 0, 15), 2)).toEqual(["2026-01", "2025-12"]);
  });

  it("marks a stored month as stored, with its entry count", () => {
    const rows = monthRows(
      [{ occurredLocalDate: "2026-09-01" }, { occurredLocalDate: "2026-09-02" }] as never,
      [],
      new Set(["2026-09"]),
      new Date(2026, 9, 11),
      2,
    );

    const september = rows.find((row) => row.month === "2026-09");

    expect(september?.state).toBe("stored");
    expect(september?.entryCount).toBe(2);
    expect(september?.bytesEstimated).toBe(false);
  });

  it("⚠️ calls a downloaded but empty month stored, not missing", () => {
    // The reason `stored` is a parameter rather than being inferred from the entry
    // count: a month with nothing in it is still a month that was fetched, and
    // calling it "未下载" invites the user to download nothing.
    const rows = monthRows([], [], new Set(["2026-09"]), new Date(2026, 9, 11), 2);

    expect(rows.find((row) => row.month === "2026-09")?.state).toBe("stored");
    expect(rows.find((row) => row.month === "2026-09")?.entryCount).toBe(0);
  });

  it("marks a month the user refused", () => {
    const rows = monthRows([], ["2026-09"], new Set(), new Date(2026, 9, 11), 2);

    expect(rows.find((row) => row.month === "2026-09")?.state).toBe("never");
    expect(rows.find((row) => row.month === "2026-10")?.state).toBe("missing");
  });

  it("estimates a missing month from the average of the stored ones", () => {
    // An estimate is honest about being one — the screen says 预计 — and the
    // alternative, showing nothing, tells the user less.
    expect(estimateBytes([{ bytes: 1_000 }, { bytes: 2_000 }])).toBe(1_500);
  });

  it("estimates nothing when nothing is stored", () => {
    expect(estimateBytes([])).toBe(0);
  });
});
