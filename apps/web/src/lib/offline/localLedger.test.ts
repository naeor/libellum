import { describe, expect, it } from "vitest";

import { findLocalTransaction, localCountForMonth, localMonths, transactionsFromCache } from "./localLedger.js";

/**
 * Reading the ledger back out of the device.
 *
 * ⚠️ Worth testing carefully because **every way this can go wrong is silent**. A
 * changed key name, a `pages` read as `items`, a dedupe that misses — none of them
 * raise anything. The app simply shows an empty ledger, or a total that is wrong by
 * one entry, and the user is offline with no way to check.
 */

/** One entry, with only the fields these functions read. */
function entry(id: string, date: string, cents = 100) {
  return { id, occurredLocalDate: date, amountCents: cents } as never;
}

/** The shape TanStack Query's persister writes, for one month. */
function cacheWith(months: readonly { readonly month: string; readonly items: readonly unknown[] }[]): string {
  return JSON.stringify({
    clientState: {
      queries: months.map((month) => ({
        queryKey: ["transactions", { month: month.month, kind: undefined, categoryId: undefined, currency: undefined }],
        state: {
          data: {
            pages: [{ items: month.items, nextCursor: null }],
            pageParams: [undefined],
          },
        },
      })),
    },
  });
}

describe("transactionsFromCache", () => {
  it("reads the entries out of an infinite query's stored shape", () => {
    // ⚠️ `{ pages: [...] }`, not `{ items: [...] }`. Reading `data.items` here would
    // find nothing and report an empty ledger — which is how this would have failed
    // if it had not been checked.
    const raw = cacheWith([{ month: "2026-09", items: [entry("a", "2026-09-01")] }]);

    expect(transactionsFromCache(raw)).toHaveLength(1);
  });

  it("also accepts a plain list, for caches written another way", () => {
    const raw = JSON.stringify({
      clientState: {
        queries: [{ queryKey: ["transactions", { month: "2026-09" }], state: { data: { items: [entry("a", "2026-09-01")] } } }],
      },
    });

    expect(transactionsFromCache(raw)).toHaveLength(1);
  });

  it("gathers entries from every stored month", () => {
    const raw = cacheWith([
      { month: "2026-09", items: [entry("a", "2026-09-01"), entry("b", "2026-09-02")] },
      { month: "2026-08", items: [entry("c", "2026-08-01")] },
    ]);

    expect(transactionsFromCache(raw)).toHaveLength(3);
  });

  it("⚠️ counts an entry once even when two pages hold it", () => {
    // The same entry can arrive on a month's first page and again from a later one.
    // Adding it twice would produce a total that is wrong with nothing to show for
    // it — the worst kind of wrong, because it looks right.
    const raw = JSON.stringify({
      clientState: {
        queries: [
          {
            queryKey: ["transactions", { month: "2026-09" }],
            state: { data: { pages: [{ items: [entry("a", "2026-09-01")] }, { items: [entry("a", "2026-09-01")] }], pageParams: [] } },
          },
        ],
      },
    });

    expect(transactionsFromCache(raw)).toHaveLength(1);
  });

  it("ignores queries that are not the transaction list", () => {
    const raw = JSON.stringify({
      clientState: {
        queries: [
          { queryKey: ["ledger"], state: { data: { book: { name: "我的账本" } } } },
          { queryKey: ["transactions", { month: "2026-09" }], state: { data: { items: [entry("a", "2026-09-01")] } } },
        ],
      },
    });

    expect(transactionsFromCache(raw)).toHaveLength(1);
  });

  it("returns nothing for an absent or unreadable cache", () => {
    expect(transactionsFromCache(null)).toEqual([]);
    expect(transactionsFromCache("")).toEqual([]);
    expect(transactionsFromCache("not json")).toEqual([]);
    expect(transactionsFromCache("{}")).toEqual([]);
    expect(transactionsFromCache('{"clientState":{}}')).toEqual([]);
  });
});

describe("findLocalTransaction", () => {
  it("finds an entry by id", () => {
    // ⚠️ This is what makes the detail screen work offline: the entry is looked up
    // rather than fetched.
    const entries = [entry("a", "2026-09-01"), entry("b", "2026-09-02")];

    expect(findLocalTransaction(entries, "b")?.id).toBe("b");
  });

  it("returns null for an entry the device has never seen", () => {
    // Which the caller must treat as "cannot show this offline" rather than as an
    // empty screen.
    expect(findLocalTransaction([entry("a", "2026-09-01")], "z")).toBeNull();
  });
});

describe("localMonths", () => {
  it("lists the months present, newest first", () => {
    const entries = [entry("a", "2026-08-01"), entry("b", "2026-10-05"), entry("c", "2026-09-30")];

    expect(localMonths(entries)).toEqual(["2026-10", "2026-09", "2026-08"]);
  });

  it("counts entries per month", () => {
    const entries = [entry("a", "2026-09-01"), entry("b", "2026-09-30"), entry("c", "2026-08-01")];

    expect(localCountForMonth(entries, "2026-09")).toBe(2);
    expect(localCountForMonth(entries, "2026-07")).toBe(0);
  });
});
