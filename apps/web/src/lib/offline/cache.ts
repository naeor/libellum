import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { Query } from "@tanstack/react-query";

import { readValue, removeValue, writeValue } from "./storage.js";

/**
 * Keeping the server's answers on the device, so the app opens with no network.
 *
 * The query cache is already "everything the server has told us" — every ledger,
 * every entry, every response — so persisting **it** is what makes the whole app
 * readable offline, rather than a hand-written copy of the database that would
 * drift from the server's schema the first time a column was added.
 *
 * ⚠️ **At most one user's worth of data lives here**, which is why signing out
 * wipes it. The cache holds somebody's spending history on a device that may be
 * shared; leaving it behind after logout would let the next person read it, and
 * the offline feature must not be the reason that happens.
 */

/**
 * How long a cached answer stays usable: **forever**.
 *
 * ⚠️ There was a thirty-day limit here first, and it was wrong in a way worth
 * recording. The reasoning behind it — "do not show a year-old ledger as if it
 * were current" — is sound, but **the remedy was in the wrong place.** An expiry
 * on the cache means that after a month without a network the app shows *nothing*:
 * the ledger the user has been keeping on their phone becomes unreadable, which is
 * precisely the opposite of what an offline-first program promises, and it is
 * exactly when they have no network that they need it most.
 *
 * Staleness is real, but it belongs where it can be **said out loud** — a banner
 * reading "offline, showing what was last synced at 18:04" is honest and useful,
 * whereas silent emptiness is neither. That banner arrives with the rest of the
 * offline interface; until then, keeping the data is strictly better than
 * discarding it.
 *
 * So this is `Infinity` and stays `Infinity`: what is cached is the user's own
 * ledger, and there is no version of "your own records have expired" that helps
 * them.
 */
export const CACHE_MAX_AGE_MS = Number.POSITIVE_INFINITY;

/** The key this cache occupies in the store. */
export const CACHE_KEY = "query-cache";

/**
 * Which queries are worth keeping.
 *
 * ⚠️ **Queries only, and only ones that can be re-read.**
 *
 * Mutations are never in the query cache at all, which is the first safeguard —
 * a persisted mutation cache would replay writes on every launch, and a user who
 * closed the app after saving would find the entry saved again. The filter below
 * is the second: it also drops anything explicitly marked as volatile, which is
 * how a question like "is this a duplicate?" stays out. That one is a *question
 * asked once*, and answering it from yesterday's cache would be answering a
 * different question.
 */
export function shouldPersistQuery(query: Query): boolean {
  const meta = query.meta as { readonly volatile?: boolean } | undefined;

  return meta?.volatile !== true;
}

/**
 * Mark a query as not worth keeping.
 *
 * Applied at the query definition, so the decision sits next to the thing it is
 * about. The screenshot recogniser and the transcriber are `useMutation` and
 * therefore never persisted at all; this is for the day one of them becomes a
 * query.
 */
export const VOLATILE = { volatile: true } as const;

/**
 * The persister, backed by the same key–value store as everything else.
 *
 * `createAsyncStoragePersister` rather than the `localStorage` one: localStorage holds about 5 MB
 * for the whole origin and blocks the main thread while it writes. A ledger's history is meant to
 * be cached in full — the owner asked for exactly that — and it will outgrow 5 MB long before it
 * outgrows a phone.
 *
 * ⚠️ **`removeClient` is deliberately inert, and that is the fix for a real data loss.**
 *
 * TanStack's restore logic is:
 *
 * ```js
 * try {
 *   const persistedClient = await persister.restoreClient()
 *   ...
 *   else hydrate(queryClient, persistedClient.clientState, hydrateOptions)
 * } catch (err) {
 *   console.warn('...the persisted cache will be discarded.')
 *   await persister.removeClient()
 *   throw err
 * }
 * ```
 *
 * **Any throw — a read interrupted, a value that is not valid JSON, a hydration that fails —
 * deletes the whole stored cache.** In a normal web app that is defensible housekeeping: the data
 * can be fetched again. **In this one the stored cache is the user's only offline copy of their own
 * ledger, and "as a precaution" it is thrown away.**
 *
 * The owner produced the proof by measuring twice on his tablet:
 *
 * ```
 * 缓存条目：63 条，缓存大小：113998 字节       (connected)
 * 缓存条目： 0 条，缓存大小：      0 字节       (after an offline/online cycle)
 * ```
 *
 * Nothing in this codebase deletes that key except signing out, and he had not signed out.
 *
 * **He also suggested the fix before I found the cause** — "退出之后自动清除缓存导致的问题，
 * 要不要把这个机制删掉？" — and he was right about what to do: **make the deletion ours, and make it
 * happen only when we decide it should.**
 *
 * So `removeClient` does nothing. What remains is `readCacheValue` below, which is forgiving: a
 * cache that cannot be read is a cache that is not there, and the app re-downloads. **Discarding a
 * corrupt copy is fine; discarding a *readable* one because a read was interrupted is not, and the
 * library's version cannot tell the difference.**
 */
export const cachePersister = createAsyncStoragePersister({
  key: CACHE_KEY,
  /**
   * ⚠️ **A tolerant deserializer, which is the second half of the same fix.**
   *
   * The library's restore is a `try`/`catch` whose catch calls `removeClient`. **So the way to stop
   * it deleting the cache is to stop it throwing** — and the only thing in that path that can throw
   * on ordinary bad data is `JSON.parse`.
   *
   * A cache that cannot be parsed is a cache that is not usable; returning `undefined` says exactly
   * that, and the library treats an absent client as "nothing to restore" rather than as an error.
   * **The unreadable copy stays on the device rather than being deleted**, so it can still be
   * inspected, and the next successful save replaces it.
   *
   * This is not a defensive flourish: the failure being guarded against is what a **suspended page
   * produces** — a write interrupted part-way — which is precisely the tablet's situation.
   */
  deserialize: (cached: string) => {
    try {
      return JSON.parse(cached) as never;
    } catch (error) {
      void logCacheEvent(
        "DIAGNOSTIC:cache-unreadable",
        `缓存无法解析，按「没有缓存」处理并保留原值：${error instanceof Error ? error.message : String(error)}`,
      );

      return undefined as never;
    }
  },
  storage: {
    getItem: (key) => readValue<string>(key),
    setItem: (key, value) => {
      void writeValue(key, value);
    },
    /**
     * ⚠️ **Never called by us, and inert if the library calls it.**
     *
     * See the note above: this is where a dropped read turned into a lost ledger. Deleting the cache
     * is a decision with a reason — signing out, or the user asking for it — and it belongs in
     * `clearQueryCache`, not in an error path.
     */
    removeItem: () => {
      void logCacheEvent("DIAGNOSTIC:cache-keep", "库要求删除缓存，已拒绝");
    },
  },
  throttleTime: 1_000,
});

/** A breadcrumb, so a refused deletion is visible in the report rather than silent. */
async function logCacheEvent(what: string, detail: string): Promise<void> {
  const { logOffline } = await import("./diagnostics.js");

  await logOffline(what, detail);
}

/**
 * Throw the cache away.
 *
 * Called on sign-out. Deliberately does **not** delete the whole database: the
 * outbox lives in the same store, and clearing the database would also discard
 * writes the user made that have not reached the server yet — spending that would
 * then vanish without ever being recorded.
 */
export async function clearQueryCache(): Promise<void> {
  await removeValue(CACHE_KEY);
}
