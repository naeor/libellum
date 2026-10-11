import type { Transaction, TransactionListResponse } from "@libellum/shared";

import { logOffline } from "./diagnostics.js";
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

/**
 * The parsed ledger, remembered against the exact string it came from.
 *
 * ⚠️ **Written because the tablet's reads were slow and the phone's were not, with the same work to
 * do.**
 *
 * Every consumer calls `transactionsFromCache(raw)`, and every call parses the whole blob: on the
 * owner's device that is **115 KB of JSON, parsed afresh, for every month lookup, every filter
 * change, every screen**. A phone absorbs that; a tablet that is also suspending pages does not, and
 * the symptom is a screen sitting on its loading state while the data is right there.
 *
 * **The memo is keyed by the string itself**, not by a flag or a timestamp — so it cannot return
 * something the stored value does not say. If the cache is written the string changes and the parse
 * happens once more; if it is not written, nothing is recomputed. **There is no invalidation logic
 * to get wrong, because the key is the content.**
 *
 * One entry is enough: the app writes one cache key, and alternating between two versions of it
 * would mean re-parsing anyway.
 */
let parsedFrom: string | null = null;
let parsedResult: readonly Transaction[] = [];

/** The entries in a stored cache, parsing only when the stored text has changed. */
export function transactionsFromCacheCached(raw: string | null): readonly Transaction[] {
  if (raw === null || raw === "") return [];

  if (raw === parsedFrom) return parsedResult;

  parsedResult = transactionsFromCache(raw);
  parsedFrom = raw;

  return parsedResult;
}

/**
 * Read the cache and return every entry it holds.
 *
 * ⚠️ **The stored copy first, then the live one — and the second half is not belt and
 * braces, it is a real difference between two devices.**
 *
 * The owner reported that this worked on his phone and not on his iPad: same ledger, same
 * download, and the tablet still showed nothing offline. **The two copies of the cache are
 * not equally up to date**, and the reason is in the persister: it writes to storage on a
 * throttle, so between a change and the write there is a window where the *live* cache has
 * data the stored one does not.
 *
 * On the phone the window had always closed by the time the user unplugged the network. On
 * the tablet it had not — so the fallback read the stored copy, found a month missing, and
 * showed nothing, with the data sitting in memory the whole time.
 *
 * **Reading both and merging closes that window by construction.** Whichever copy is newer,
 * the answer includes what it has; and this is the same principle as the rest of this file,
 * one layer down.
 */
export async function readLocalTransactions(): Promise<readonly Transaction[]> {
  /**
   * A hook the query layer installs, so the live cache can be consulted without this module
   * importing it — which would be a cycle, and would tie a storage concern to React.
   */
  const live = liveSource?.() ?? [];

  const raw = await readValue<string>(CACHE_KEY);

  /**
   * ⚠️ **Through the memo**, because this runs for every screen and every filter change and the
   * blob is over a hundred kilobytes. See `transactionsFromCacheCached`.
   */
  const fromDisk = transactionsFromCacheCached(raw);

  /**
   * ⚠️ **Recorded before the read is logged, so the report and the log cannot disagree.**
   *
   * `readLocalTransactions` is the only place that knows all four numbers at once: what the disk
   * held, what memory held, what they add up to after merging, and — when there is nothing — a
   * phrase a person can read.
   */
  localRead = {
    at: Date.now(),
    diskBytes: raw === null ? 0 : raw.length,
    diskEntries: fromDisk.length,
    liveEntries: live.length,
    total: mergeLocal(fromDisk, live).length,
    note: raw === null ? "本机没有缓存" : fromDisk.length === 0 ? "缓存里没有账目" : null,
  };

  /**
   * ⚠️ **Both counts, and they are the whole point of this line.**
   *
   * "Shows nothing offline" has at least five causes and one symptom: the stored blob absent,
   * present but unparsable, parsable with no transaction queries under it, full of
   * transactions the filter then excludes, or a read that threw. Every one looks identical on
   * screen, and each needs a different fix.
   *
   * `readValue` traces the disk half itself — including *why* a read failed — so this line
   * records the outcome, and the storage trace records the steps that produced it.
   */
  await logOffline(
    "DIAGNOSTIC:local-read",
    `磁盘 ${raw === null ? "无缓存键" : `${String(raw.length)} 字节`} → ${String(fromDisk.length)} 条；` +
      `内存 ${String(live.length)} 条；合计 ${String(localRead.total)} 条`,
  );

  return mergeLocal(fromDisk, live);
}

/**
 * What the last attempt to read the device's ledger found.
 *
 * ⚠️ **Module state read at render time, and that is deliberate.**
 *
 * The owner asked for exactly this: "如果此时没有读到数据或者出现了任何问题，就显示尝试读取数据但失败
 * （也可以分得详细些）". **A message that says what was tried is worth more than one that says
 * something went wrong**, because the person reading it can tell a missing download from a broken
 * database — and the numbers belong on the screen rather than in a log they must open another page
 * to read.
 */
export interface LocalReadReport {
  readonly at: number;
  readonly diskBytes: number;
  readonly diskEntries: number;
  readonly liveEntries: number;
  readonly total: number;
  /** A plain-language reason, when there is nothing to show. */
  readonly note: string | null;
}

let localRead: LocalReadReport = {
  at: 0,
  diskBytes: 0,
  diskEntries: 0,
  liveEntries: 0,
  total: 0,
  note: "还没有读过本机数据",
};

/** The last local read, so a waiting screen can say what was tried. */
export function lastLocalRead(): LocalReadReport {
  return localRead;
}

/**
 * Both copies, by id.
 *
 * ⚠️ **The two are not equally new, and neither is authoritative.** The live cache changes
 * immediately; the stored one is written on a throttle. On the owner's phone that window had
 * always closed before the network was unplugged; on his tablet it had not — so the fallback
 * read the disk, found a month missing, and rendered nothing while the data sat in memory.
 *
 * Merging closes the window by construction, which is the same principle as the rest of this
 * file one layer down: do not assume which copy is right, combine them.
 */
function mergeLocal(
  fromDisk: readonly Transaction[],
  live: readonly Transaction[],
): readonly Transaction[] {
  if (fromDisk.length === 0) return live;
  if (live.length === 0) return fromDisk;

  const merged = new Map<string, Transaction>();

  for (const transaction of fromDisk) merged.set(transaction.id, transaction);
  for (const transaction of live) merged.set(transaction.id, transaction);

  return [...merged.values()];
}

/**
 * Where the live cache is read from.
 *
 * Installed once by the query layer. A module-level hook rather than an import because the
 * alternative is a cycle — `queries.ts` imports this file for the fallback — and because a
 * storage module has no business knowing about React.
 */
let liveSource: (() => readonly Transaction[]) | null = null;

/** Called by the query layer, once, with a reader for the in-memory cache. */
export function installLiveSource(reader: () => readonly Transaction[]): void {
  liveSource = reader;
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
