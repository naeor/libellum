import type { Transaction, TransactionListResponse } from "@libellum/shared";

import { readValue } from "./storage.js";

/**
 * Reading the ledger back out of the device.
 *
 * ⚠️ **This is the piece that was missing**, and the owner found it by trying:
 * with twenty megabytes stored locally, he could see every month's list and still
 * could not open an entry or look at the analysis screen — because both of those
 * went to the network for an answer that was already sitting on the device.
 *
 * The list is not a summary: `transactionSchema` carries the category name, the
 * payment method's name, the tags and the time zone, which is **everything the
 * detail screen needs**. So a locally stored month contains more than enough to
 * answer for any one of its entries, and enough to compute any statistic over the
 * range it covers. Nothing has to be downloaded twice; it only has to be *read*.
 *
 * The stored cache is one JSON string keyed by `query-cache` — TanStack Query's own
 * dehydrated form, written by the persister. Parsing it here rather than keeping a
 * second copy on the device is deliberate: one copy cannot disagree with itself.
 */

/** The key the query cache occupies. Mirrors `CACHE_KEY` in `cache.ts`. */
const CACHE_KEY = "query-cache";

/**
 * The shape TanStack Query's persister writes.
 *
 * Only the fields this module reads. A second definition of the whole structure
 * would be a copy of somebody else's format, and it would be the one that goes
 * stale when that library changes.
 */
interface PersistedCache {
  readonly clientState?: {
    readonly queries?: readonly {
      readonly queryKey?: readonly unknown[];
      readonly queryHash?: string;
      readonly state?: { readonly data?: unknown };
    }[];
  };
}

/**
 * Pull the stored transaction lists out of a dehydrated cache.
 *
 * **Pure**, so the parsing can be tested against fixtures instead of a browser —
 * and this is worth testing carefully, because every way it can go wrong is silent:
 * a changed key name would return an empty ledger, and the user would see an empty
 * app with no error anywhere.
 *
 * The query key is `["transactions", filters]`, matching `queryKeys.transactions`.
 */
export function transactionsFromCache(raw: string | null): readonly Transaction[] {
  if (raw === null || raw === "") return [];

  let parsed: PersistedCache;

  try {
    parsed = JSON.parse(raw) as PersistedCache;
  } catch {
    // A cache that cannot be parsed is a cache that is not there.
    return [];
  }

  const queries = parsed.clientState?.queries;
  if (!Array.isArray(queries)) return [];

  const found = new Map<string, Transaction>();

  for (const query of queries) {
    const key = query.queryKey;
    if (!Array.isArray(key) || key[0] !== "transactions") continue;

    /**
     * ⚠️ **`pages`, not `items` — the stored value is an infinite query's.**
     *
     * The screen reads this key with `useInfiniteQuery`, so the cache holds
     * `{ pages: [{items, nextCursor}, …], pageParams: […] }`. Reading `data.items`
     * here would find nothing and report an empty ledger: the app would look
     * perfectly fine and be empty, which is the worst way for this to fail.
     *
     * Both shapes are accepted anyway, because the fill writes the infinite form
     * and older caches may hold the plain one — and because being liberal here
     * costs one branch and removes a whole class of "worked yesterday".
     */
    const data = query.state?.data as
      | { readonly pages?: readonly TransactionListResponse[]; readonly items?: readonly Transaction[] }
      | undefined;

    if (data === undefined) continue;

    const pages = data.pages ?? (data.items === undefined ? [] : [{ items: data.items, nextCursor: null }]);

    for (const page of pages) {
      for (const item of page.items ?? []) {
        /**
         * Keyed by id, so the same entry seen twice — once from a month's first
         * page and once from a later one — is counted once. Adding totals twice
         * would produce a ledger that is wrong in a way nobody could spot.
         */
        found.set(item.id, item);
      }
    }
  }

  return [...found.values()];
}

/** Read the cache and return every entry it holds. */
export async function readLocalTransactions(): Promise<readonly Transaction[]> {
  return transactionsFromCache(await readValue<string>(CACHE_KEY));
}

/**
 * Find one entry among those stored.
 *
 * ⚠️ **This is what makes the detail screen work offline.** The screen asks
 * `GET /transactions/:id`, which cannot be answered without a network — but the
 * entry is already in the local copy of the month it belongs to, complete with
 * everything the screen displays. So the answer is looked up rather than fetched,
 * and the download the user already waited for is finally used for both things.
 */
export function findLocalTransaction(
  transactions: readonly Transaction[],
  id: string,
): Transaction | null {
  return transactions.find((transaction) => transaction.id === id) ?? null;
}

/**
 * The months present in the local copy, newest first.
 *
 * Read from `occurredLocalDate`, which is the date the entry belongs to **in the
 * zone it was recorded in** — the same field the server filters months by, so a
 * month here means the same month there.
 */
export function localMonths(transactions: readonly Transaction[]): readonly string[] {
  const months = new Set<string>();

  for (const transaction of transactions) {
    const date = transaction.occurredLocalDate;
    if (typeof date === "string" && date.length >= 7) months.add(date.slice(0, 7));
  }

  return [...months].sort((a, b) => b.localeCompare(a));
}

/** How many entries are stored for one month. */
export function localCountForMonth(transactions: readonly Transaction[], month: string): number {
  let count = 0;

  for (const transaction of transactions) {
    if (transaction.occurredLocalDate.slice(0, 7) === month) count += 1;
  }

  return count;
}

/** What a screen is asking for. Mirrors `TransactionFilters`. */
export interface LocalFilters {
  readonly month?: string | undefined;
  readonly kind?: "income" | "expense" | undefined;
  readonly categoryId?: string | undefined;
  readonly currency?: string | undefined;
}

/**
 * The entries that match what a screen is asking for.
 *
 * ⚠️ **This is what makes a *filtered* view work offline, and it was missing.**
 *
 * The fill downloads each month in full — one entry per row, not per view — but the
 * screens do not all ask the same question. The spending tab and the income tab are
 * different queries with different keys, and a category filter is a third. So even
 * with every month on the device, switching to 收入 or opening 分析 asked a question
 * the cache had never been asked and got nothing back.
 *
 * **Filtering the local copy answers all of them from one download**, which is the
 * point: the data is not per-view, so the answers should not be either.
 *
 * The rules mirror the server's `where` clause: the month by `occurredLocalDate`, then
 * kind, category and currency exactly. Deleted entries need no check — the list
 * endpoint never sends them, so they were never stored.
 */
export function filterLocally(
  transactions: readonly Transaction[],
  filters: LocalFilters,
): readonly Transaction[] {
  return transactions.filter((transaction) => {
    if (filters.month !== undefined && transaction.occurredLocalDate.slice(0, 7) !== filters.month) {
      return false;
    }

    if (filters.kind !== undefined && transaction.kind !== filters.kind) return false;
    if (filters.categoryId !== undefined && transaction.categoryId !== filters.categoryId) return false;
    if (filters.currency !== undefined && transaction.currency !== filters.currency) return false;

    return true;
  });
}

/**
 * The local entries, shaped like a page of the list endpoint.
 *
 * ⚠️ **`nextCursor: null` is not a placeholder.** Everything the device has is handed
 * over in one page, because there is no server to page through and the screen's
 * "载入更多" would be asking for data that is already here. Reporting a cursor would
 * make the screen offer a button that fetches nothing.
 *
 * Order is whatever was stored, which is the server's own order — it was stored as it
 * arrived — and the screen groups by day from there.
 */
export function asLocalPage(transactions: readonly Transaction[]): TransactionListResponse {
  return { items: [...transactions], nextCursor: null };
}
