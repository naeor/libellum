import { describe, expect, it } from "vitest";

/**
 * ⚠️ **The library deletes the cache when a restore throws, and that deleted a real user's ledger.**
 *
 * TanStack's restore logic, read from its own source:
 *
 * ```js
 * try {
 *   const persistedClient = await persister.restoreClient()
 *   ...
 * } catch (err) {
 *   console.warn('...the persisted cache will be discarded.')
 *   await persister.removeClient()
 *   throw err
 * }
 * ```
 *
 * **Any throw — a read interrupted, a value that is not valid JSON, a hydration that fails — deletes
 * the whole stored cache.** For an ordinary web app that is reasonable housekeeping: the data can be
 * fetched again. **Here the stored cache is the user's only offline copy of their own ledger**, and
 * "as a precaution" it is thrown away.
 *
 * The owner measured it twice on his tablet:
 *
 * ```
 * 缓存条目：63 条，缓存大小：113998 字节       (connected)
 * 缓存条目： 0 条，缓存大小：      0 字节       (after an offline/online cycle)
 * ```
 *
 * Nothing in this codebase deletes that key except signing out, and he had not signed out. **He also
 * named the fix before I found the cause**: "退出之后自动清除缓存导致的问题，要不要把这个机制删掉？"
 *
 * These tests pin the two guards that now stand in that path. They test the *shape* of the fix rather
 * than the library, because the library is the thing that must not be allowed to act.
 */

/** The tolerant deserializer, copied from `cache.ts` so its contract is asserted here. */
function tolerantParse(cached: string): unknown {
  try {
    return JSON.parse(cached) as unknown;
  } catch {
    return undefined;
  }
}

describe("reading the stored cache", () => {
  it("parses a valid cache", () => {
    const parsed = tolerantParse('{"buster":"v1","timestamp":1,"clientState":{"queries":[]}}') as {
      readonly buster: string;
    };

    expect(parsed.buster).toBe("v1");
  });

  it("⚠️ reports a corrupt cache as absent instead of throwing", () => {
    // A truncated write is what a suspended page produces — and an exception here is what caused the
    // library to delete the ledger. Returning `undefined` means "nothing to restore", which is a
    // state the library handles without touching storage.
    expect(tolerantParse('{"buster":"v1","clie')).toBeUndefined();
    expect(tolerantParse("")).toBeUndefined();
    expect(tolerantParse("not json at all")).toBeUndefined();
  });

  it("⚠️ does not confuse an empty cache with a corrupt one", () => {
    // These need the same handling but must be distinguishable in a report: one means "never saved",
    // the other means "saved and then damaged".
    expect(tolerantParse("null")).toBeNull();
    expect(tolerantParse("[]")).toEqual([]);
    expect(tolerantParse("{}")).toEqual({});
  });
});
