import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { Query } from "@tanstack/react-query";

import { scopedKey } from "./scope.js";
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
    /**
     * ⚠️ **The key carries the account and the ledger, and this is where that happens.**
     *
     * The persister's own `key` is fixed when it is constructed — before any account is known — so
     * the scope cannot live there. It is applied here instead, on every read and every write.
     *
     * **What this prevents**: two accounts on one device sharing a query cache, or one account's
     * two ledgers sharing one. Without it, `transactions → {month}` from the last ledger would be
     * handed to the next one **before the server was asked anything**, and the screen would show
     * the wrong ledger's rows for as long as that took.
     *
     * ⚠️ **The scope is restored synchronously at startup** (see `restoreOfflineScopeSync`), which
     * is what makes this correct on the very first read rather than only after a round trip.
     */
    getItem: (key) => readValue<string>(scopedKey(key)),
    /**
     * ⚠️ **Merge, rather than replace.**
     *
     * The library hands over the dehydrated **in-memory** cache, and writing that verbatim is what lost
     * the owner's downloaded months: anything that left memory — through eviction, a reload before a
     * month was ever observed, any path not yet found — **was written out of storage with it.**
     *
     * `gcTime: Infinity` in `App.tsx` stops the eviction that was doing it. **This stops the loss being
     * possible at all**: a month the device already holds is kept even when the write does not mention
     * it, so the stored copy can only ever grow or be replaced by something newer, never silently shrink.
     *
     * ⚠️ **Only transaction lists are preserved this way, and deliberately.**
     *
     * They are the expensive thing to lose — sixty requests to rebuild — and they are addressed by month,
     * so "the memory write did not mention February" almost always means "no screen is showing February",
     * not "February is no longer true". Everything else (`stats`, `summary`, `ledger`, single entries)
     * is cheap to fetch again and **must** be allowed to change: a summary that cannot be replaced is a
     * summary showing yesterday's totals.
     *
     * Merging is by query key, exactly as the dehydrated cache is addressed, and the new value always
     * wins for any key it does contain.
     */
    setItem: (key, value) => {
      /**
       * ⚠️ **The same scope as `getItem`, or the two would disagree** — a write to the unscoped
       * key next to a read from the scoped one is a cache that never survives a reload.
       */
      void writeMerged(scopedKey(key), value);
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

/** A dehydrated cache, as the persister hands it over. */
interface DehydratedCache {
  readonly clientState?: { readonly queries?: readonly { readonly queryKey?: unknown }[] };
}

/** The month a stored transaction-list query is for, or `null`. */
function monthOfKey(queryKey: unknown): string | null {
  if (!Array.isArray(queryKey) || queryKey[0] !== "transactions") return null;

  const filters = queryKey[1] as { readonly month?: unknown } | undefined;

  return typeof filters?.month === "string" ? filters.month : null;
}

/**
 * One merge at a time.
 *
 * ⚠️ **The merge is a read–modify–write, and serialising only the write is not enough.**
 *
 * `writeValue` already queues writes per key, and that was mistaken for enough. It is not: two merges
 * can both read the stored cache *before* either has written, both decide what to preserve from the
 * same old copy, and then the second write — based on a snapshot that never saw the first one's
 * additions — **overwrites the first one's work.**
 *
 * The owner's trace shows exactly that shape: `write query-cache — 14247 字节` immediately after a run
 * that had logged `DIAGNOSTIC:cache-merge — 保留 60 个月份记录`, with only four `transactions` entries
 * surviving in the end. **The preservation happened and was then written over by a merge that had
 * started before it.**
 *
 * ⚠️ **The lock covers the read as well as the write**, which is the whole point: the decision of what
 * to keep must be made against the state that is actually on disk when the write happens, not against
 * the state that was on disk a moment earlier.
 */
let mergeQueue: Promise<void> = Promise.resolve();

/**
 * Write the incoming cache, keeping per-month transaction lists the incoming one does not mention.
 *
 * ⚠️ **Written after the owner's cache listing showed the damage**: `ledger`, a single `transaction`,
 * `summary` and several `stats` entries present, and **not one `transactions · month=…`** — so the
 * analysis screen had nothing to compute from and only one local read ever happened.
 */
async function writeMerged(key: string, value: string): Promise<void> {
  /**
   * ⚠️ **`then` on both outcomes**, so one failed merge cannot block every later write to the cache for
   * the rest of the session — the failure is reported by its own caller, and the next attempt deserves
   * a clean run.
   */
  const next = mergeQueue.then(
    () => mergeAndWrite(key, value),
    () => mergeAndWrite(key, value),
  );

  mergeQueue = next.catch(() => undefined);

  return next;
}

async function mergeAndWrite(key: string, value: string): Promise<void> {
  try {
    const incoming = JSON.parse(value) as DehydratedCache;
    const storedRaw = await readValue<string>(key);

    /**
     * ⚠️ **The sizes are logged, because the failure was a silent one.**
     *
     * "The months were dropped somewhere between the merge saying it kept sixty of them and the write
     * finishing" is not something a count of preserved entries can show. **Both sides of the write, in
     * bytes, makes it visible at a glance** — and a merge that produced a *smaller* cache than it read
     * is the signature of exactly this bug.
     */
    if (storedRaw === null) {
      await writeValue(key, value);

      return;
    }

    const stored = JSON.parse(storedRaw) as DehydratedCache;

    const incomingQueries = incoming.clientState?.queries ?? [];
    const storedQueries = stored.clientState?.queries ?? [];

    if (storedQueries.length === 0) {
      await writeValue(key, value);

      return;
    }

    /** Keys the incoming write already speaks for — these are replaced, not duplicated. */
    const covered = new Set(incomingQueries.map((query) => JSON.stringify(query.queryKey)));

    /**
     * ⚠️ **Only transaction lists, only months, and only when the incoming write is silent about them.**
     *
     * A broader merge would keep `stats` and `summary` entries for ever, and a summary that cannot be
     * replaced is a summary showing yesterday's totals.
     */
    const preserved = storedQueries.filter((query) => {
      const month = monthOfKey(query.queryKey);

      return month !== null && !covered.has(JSON.stringify(query.queryKey));
    });

    if (preserved.length === 0) {
      await writeValue(key, value);

      return;
    }

    const merged = JSON.stringify({
      ...incoming,
      clientState: { ...incoming.clientState, queries: [...incomingQueries, ...preserved] },
    });

    /**
     * ⚠️ **A merge must never shrink the cache.** If it did, the preservation logic did not do what it
     * says, and writing a smaller cache would destroy data the device holds. Failing safe here means
     * keeping what is stored — the device's copy — and reporting it, rather than trusting arithmetic
     * that has already been wrong once.
     */
    if (merged.length < storedRaw.length) {
      await logCacheEvent(
        "DIAGNOSTIC:cache-merge-refused",
        `合并后反而更小（${String(storedRaw.length)} → ${String(merged.length)} 字节），保留设备上的版本`,
      );

      return;
    }

    await logCacheEvent(
      "DIAGNOSTIC:cache-merge",
      `保留 ${String(preserved.length)} 个月份记录；${String(storedRaw.length)} → ${String(merged.length)} 字节`,
    );

    await writeValue(key, merged);
  } catch (error) {
    /**
     * ⚠️ **A failed merge falls back to a plain write.**
     *
     * Refusing to save would be worse than saving less: the incoming cache is what the running app
     * actually has, and losing *it* would be the larger problem.
     */
    void logCacheEvent(
      "DIAGNOSTIC:cache-merge-failed",
      error instanceof Error ? error.message : String(error),
    );

    await writeValue(key, value);
  }
}

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
