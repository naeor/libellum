import { describe, expect, it } from "vitest";

import { isCurrentTransactionKey } from "./downloadManager.js";

/**
 * ⚠️ **The check that decides what a "clean up stale records" button is allowed to
 * delete — written after the first version deleted the owner's entire download.**
 *
 * That version compared stored keys against the **live query cache**: "is anything in
 * memory using this key". `PersistQueryClientProvider` restores that cache
 * **asynchronously**, so pressing the button early meant an empty memory, every stored
 * month looked unreferenced, and all sixty were removed. The manager then correctly
 * showed 0 笔 / 0 B for every month — "看起来似乎是把真正有用的数据删了".
 *
 * **A destructive decision must not depend on something that may not have finished
 * loading.** What "stale" means here is decidable from the stored data alone, which is
 * what makes it safe: an entry is stale when its key has a shape this version no longer
 * writes. No memory, no restore, no timing.
 */
describe("isCurrentTransactionKey", () => {
  const current = { month: "2026-10", kind: undefined, categoryId: undefined, currency: undefined };

  it("accepts the shape this version writes", () => {
    expect(isCurrentTransactionKey(["transactions", current])).toBe(true);
  });

  it("accepts a filtered variant, which has the same fields", () => {
    // The income tab and a category filter produce the same field set with different
    // values. They are live entries, not leftovers.
    expect(
      isCurrentTransactionKey([
        "transactions",
        { month: "2026-10", kind: "income", categoryId: undefined, currency: undefined },
      ]),
    ).toBe(true);
  });

  it("⚠️ rejects a key with a field short — the older shape", () => {
    // This is the specific key shape that changed, and the reason a cleanup was offered
    // at all: `{month, kind, categoryId}` with no `currency`.
    expect(
      isCurrentTransactionKey(["transactions", { month: "2026-10", kind: undefined, categoryId: undefined }]),
    ).toBe(false);
  });

  it("rejects a key with an extra field this version does not write", () => {
    expect(
      isCurrentTransactionKey([
        "transactions",
        { month: "2026-10", kind: undefined, categoryId: undefined, currency: undefined, tagId: undefined },
      ]),
    ).toBe(false);
  });

  it("rejects a key whose filters are not an object", () => {
    expect(isCurrentTransactionKey(["transactions", "2026-10"])).toBe(false);
    expect(isCurrentTransactionKey(["transactions"])).toBe(false);
  });

  it("⚠️ leaves every non-transaction query alone", () => {
    // The ledger, the summaries, the statistics — none of them is this function's
    // business, and a cleanup that touched them would delete things nobody asked about.
    expect(isCurrentTransactionKey(["ledger"])).toBe(true);
    expect(isCurrentTransactionKey(["summary", "2026-10"])).toBe(true);
    expect(isCurrentTransactionKey(["stats", { from: "2026-01-01" }])).toBe(true);
    expect(isCurrentTransactionKey([])).toBe(true);
  });
});
