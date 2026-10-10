import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { forgetMonth, storedMonthsIn } from "./downloadManager.js";

/**
 * ⚠️ **The bug the owner found by pressing the button eight times.**
 *
 * His download log said the same three lines every time:
 *
 *     手动下载 — 月份：2026-10
 *     开始 — 计划 1 个月
 *     跳过（已完整） — 2026-10
 *
 * Nothing was fetched, and the storage figure grew anyway. The cause was a split
 * between the two copies of the cache:
 *
 *  * **`storedMonths` and `forgetMonth` read and wrote the *persisted blob*.**
 *  * **TanStack Query's persistence flows one way** — the in-memory cache is written
 *    over storage whenever it changes.
 *
 * So deleting a month edited the blob, the month stayed in memory, memory was written
 * back a moment later, and the next download correctly reported "already complete".
 * **The month could not stay deleted, and no download could ever happen again.**
 *
 * These tests pin the rule that replaced it: **the live client is the only thing that
 * knows what is stored, and a deletion has to go through it.**
 */

/** A transaction-list query key, the way `queryKeys.transactions` builds one. */
function key(month: string): readonly unknown[] {
  return ["transactions", { month, kind: undefined, categoryId: undefined, currency: undefined }];
}

function clientWith(months: readonly string[]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  for (const month of months) {
    client.setQueryData(key(month), {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });
  }

  return client;
}

describe("storedMonthsIn", () => {
  it("reports the months the client holds", () => {
    // Asked of the live cache, not of the stored blob — the blob says what was saved at
    // some point, and memory is what the app is using and what gets written back.
    const months = storedMonthsIn(clientWith(["2026-09", "2026-10"]));

    expect([...months].sort()).toEqual(["2026-09", "2026-10"]);
  });

  it("ignores queries that are not the transaction list", () => {
    const client = clientWith(["2026-10"]);
    client.setQueryData(["ledger"], { book: { name: "我的账本" } });

    expect([...storedMonthsIn(client)]).toEqual(["2026-10"]);
  });

  it("is empty for a fresh client", () => {
    expect(storedMonthsIn(new QueryClient()).size).toBe(0);
  });
});

describe("forgetMonth", () => {
  it("removes the month from the client", () => {
    const client = clientWith(["2026-09", "2026-10"]);

    const removed = forgetMonth(client, "2026-10");

    expect(removed).toBe(1);
    expect([...storedMonthsIn(client)]).toEqual(["2026-09"]);
  });

  it("⚠️ stays removed, which is what the old version could not do", () => {
    // The old implementation edited the persisted blob only. The month survived in
    // memory and the persister wrote it straight back, so the next download said
    // "跳过（已完整）" and the user saw a deletion that did not stick.
    const client = clientWith(["2026-10"]);

    forgetMonth(client, "2026-10");

    // Anything that reads the live client now sees it gone — including the manager, and
    // including whatever the persister is about to write.
    expect(storedMonthsIn(client).has("2026-10")).toBe(false);
  });

  it("removes every query for that month, not just the first", () => {
    // A month can hold more than one entry: the unfiltered list and a filtered one.
    // Leaving any of them behind would keep the month "stored" for ever.
    const client = clientWith(["2026-10"]);
    client.setQueryData(
      ["transactions", { month: "2026-10", kind: "income", categoryId: undefined, currency: undefined }],
      { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] },
    );

    const removed = forgetMonth(client, "2026-10");

    expect(removed).toBe(2);
    expect(storedMonthsIn(client).size).toBe(0);
  });

  it("leaves other months alone", () => {
    const client = clientWith(["2026-08", "2026-09", "2026-10"]);

    forgetMonth(client, "2026-09");

    expect([...storedMonthsIn(client)].sort()).toEqual(["2026-08", "2026-10"]);
  });

  it("reports zero when the month was not there", () => {
    expect(forgetMonth(clientWith(["2026-09"]), "2020-01")).toBe(0);
  });
});
