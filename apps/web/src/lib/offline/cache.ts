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
 * `createAsyncStoragePersister` rather than the `localStorage` one: localStorage
 * holds about 5 MB for the whole origin and blocks the main thread while it
 * writes. A ledger's history is meant to be cached in full — the owner asked for
 * exactly that — and it will outgrow 5 MB long before it outgrows a phone.
 */
export const cachePersister = createAsyncStoragePersister({
  key: CACHE_KEY,
  storage: {
    getItem: (key) => readValue<string>(key),
    setItem: (key, value) => {
      void writeValue(key, value);
    },
    removeItem: (key) => {
      void removeValue(key);
    },
  },
  throttleTime: 1_000,
});

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
