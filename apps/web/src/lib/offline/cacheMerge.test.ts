import { describe, expect, it } from "vitest";

/**
 * ⚠️ **The owner's downloaded history was being written out of storage, and his cache listing proved it.**
 *
 * ```
 * ledger                                4 KB
 * transaction · 01a125a1-ce30-...     865 B
 * summary · 2026-10                   806 B
 * stats · 6字段 · from=2026-10-04 …   723 B
 * stats · 6字段 · from=2026-09-11 …   710 B
 * stats · 4字段 · from=2026-01-01 …   565 B
 * ```
 *
 * **Not one `transactions · month=…` entry** — and those are the sixty months he had downloaded. The
 * persistence layer saves the **in-memory** cache wholesale, and TanStack's default `gcTime` is five
 * minutes: a month whose screen had not been open for five minutes was evicted from memory, and the next
 * write removed it from storage with it. The analysis screen then had nothing to compute from, and only
 * one local read ever appeared.
 *
 * Two fixes, and these tests pin the second. The first is `gcTime: Infinity` in `App.tsx`. **The second
 * is here: a write may not delete a month it simply does not mention**, because "the write did not
 * include February" almost always means "no screen is showing February", not "February is no longer
 * true".
 */

/** The month a stored transaction-list query is for, copied from `cache.ts` so its contract is asserted. */
function monthOfKey(queryKey: unknown): string | null {
  if (!Array.isArray(queryKey) || queryKey[0] !== "transactions") return null;

  const filters = queryKey[1] as { readonly month?: unknown } | undefined;

  return typeof filters?.month === "string" ? filters.month : null;
}

/**
 * A query as the cache stores it.
 *
 * ⚠️ **The wrapper matters.** An earlier version of this helper returned the bare key and the test
 * passed it where a `{ queryKey }` object was expected, so every lookup read `undefined` and the
 * assertion failed against the *fixture* rather than the behaviour. **A test that fails for its own
 * reasons is worse than no test**, because it sends the reader to the implementation.
 */
interface StoredQuery {
  readonly queryKey: unknown;
}

const monthQuery = (month: string): StoredQuery => ({
  queryKey: ["transactions", { month, kind: undefined }],
});

/** Which stored queries a merge would keep, given what the incoming write already covers. */
function preservedBy(
  storedQueries: readonly StoredQuery[],
  incomingQueries: readonly StoredQuery[],
): readonly StoredQuery[] {
  const covered = new Set(incomingQueries.map((query) => JSON.stringify(query.queryKey)));

  return storedQueries.filter((query) => {
    const month = monthOfKey(query.queryKey);

    return month !== null && !covered.has(JSON.stringify(query.queryKey));
  });
}

describe("merging a cache write with what is stored", () => {
  it("⚠️ keeps a downloaded month the incoming write does not mention", () => {
    // The failure exactly as it happened: memory holds October because that screen is open, so the
    // write says nothing about the other fifty-nine months.
    const stored = [monthQuery("2026-09"), monthQuery("2026-08")];
    const incoming = [monthQuery("2026-10")];

    const kept = preservedBy(stored, incoming);

    expect(kept).toHaveLength(2);
    expect(kept.map((query) => monthOfKey(query.queryKey)).sort()).toEqual(["2026-08", "2026-09"]);
  });

  it("lets the incoming write replace a month it does mention", () => {
    // A month that was re-fetched must be able to change — otherwise the merge would freeze old entries
    // and the fix would become the next bug.
    expect(preservedBy([monthQuery("2026-10")], [monthQuery("2026-10")])).toHaveLength(0);
  });

  it("⚠️ does not preserve anything except per-month transaction lists", () => {
    // A summary that cannot be replaced is a summary showing yesterday's totals, and stats are derived
    // from entries — they must be allowed to change or be absent.
    const stored: readonly StoredQuery[] = [
      { queryKey: ["summary", "2026-10"] },
      { queryKey: ["stats", { from: "2026-10-01" }] },
      { queryKey: ["ledger"] },
      { queryKey: ["transaction", "abc"] },
    ];

    expect(preservedBy(stored, [])).toHaveLength(0);
  });

  it("ignores a transaction key with no month, which it cannot place", () => {
    // Not a per-month list, so the same rule does not apply and it is left to the normal write.
    expect(preservedBy([{ queryKey: ["transactions", {}] }], [])).toHaveLength(0);
  });

  it("keeps every month when the write covers none of them", () => {
    const stored = [monthQuery("2026-01"), monthQuery("2026-02"), monthQuery("2026-03")];

    expect(preservedBy(stored, [{ queryKey: ["ledger"] }])).toHaveLength(3);
  });

  it("adds nothing when everything stored is already covered", () => {
    expect(preservedBy([monthQuery("2026-10")], [monthQuery("2026-10")])).toHaveLength(0);
  });
});
