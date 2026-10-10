import type { QueryClient } from "@tanstack/react-query";

import { readValue, writeValue } from "./storage.js";

/**
 * What the download manager shows and controls, month by month.
 *
 * The owner's design: "用户可以在里面看到已经下载内容的明细，颗粒度到月就可以……
 * 并且可以控制不同月份账本的下载设置（比如删除已下载的某月账本，设置为永不下载等等）."
 *
 * ⚠️ **Month is the right granularity, and it is the one the app already thinks in.**
 * The list screen is per month, the download walks months, and a month is a unit a
 * person recognises — "September is downloaded" means something in a way that
 * "12.4 MB of 20.1 MB" does not. Sizing a month needs no new data either: the entries
 * for it are already stored, so its weight is measured rather than guessed.
 *
 * **A month marked "never" is a decision, not a gap.** Somebody may not want five
 * years of 2019 on a phone, and "do not keep this one" is not the same as "not yet",
 * so the fill skips it and says nothing about it, rather than re-fetching it for ever.
 */

/** Months the user has told us not to keep. */
export const NEVER_DOWNLOAD_KEY = "offline-never-months";

/** The key the query cache occupies. Mirrors `CACHE_KEY` in `cache.ts`. */
const CACHE_KEY = "query-cache";

/** How many months the manager lists. Matches the fill's own horizon. */
export const MANAGER_MONTHS = 60;

export interface MonthRow {
  /** `YYYY-MM`. */
  readonly month: string;
  /** How it is said on screen: `2026年9月`. */
  readonly label: string;
  readonly state: "stored" | "missing" | "never";
  readonly entryCount: number;
  /** Measured for a stored month, estimated from the average for a missing one. */
  readonly bytes: number;
  /** Whether `bytes` is a measurement rather than an estimate. */
  readonly bytesEstimated: boolean;
}

/** How a month reads on screen. */
export function monthLabel(month: string): string {
  const [year, rawMonth] = month.split("-");

  // Not `Number()` and not `parseInt`: a malformed key should come out unchanged
  // rather than as "undefined年NaN月".
  if (year === undefined || rawMonth === undefined) return month;

  return `${year}年${String(Number(rawMonth))}月`;
}

/**
 * How much room one month takes.
 *
 * **Measured, not guessed**, for a stored month: the entries are here, so the bytes are
 * the bytes. Counting them rather than asking the browser keeps the figure attached to
 * a month — `storage.estimate()` reports a total for the whole origin and cannot say
 * which month it belongs to.
 */
export function bytesForMonth(transactions: readonly { readonly occurredLocalDate: string }[], month: string): number {
  let bytes = 0;

  for (const transaction of transactions) {
    if (transaction.occurredLocalDate.slice(0, 7) !== month) continue;

    // The stored form is JSON. Measuring the entry as it would be written is close
    // enough for "which months are worth deleting", and needs no walking of the blob.
    bytes += JSON.stringify(transaction).length;
  }

  return bytes;
}

/**
 * The estimate for a month that is not stored.
 *
 * The average of the months that are, or zero when nothing is stored yet. An estimate
 * is honest about being one — the screen says 预计 — and the alternative, showing
 * nothing, tells the user less than a rough figure does.
 */
export function estimateBytes(stored: readonly { readonly bytes: number }[]): number {
  if (stored.length === 0) return 0;

  let total = 0;
  for (const month of stored) total += month.bytes;

  return Math.round(total / stored.length);
}

/** The months the manager lists, newest first, ending at `count` months back. */
export function managerMonths(now: Date, count: number): readonly string[] {
  const months: string[] = [];

  for (let back = 0; back < count; back += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - back, 1);
    months.push(`${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  }

  return months;
}

/**
 * Build the table the manager draws.
 *
 * ⚠️ **`stored` is passed in, and that is the point.** The first version inferred
 * "downloaded" from whether a month had any entries, and it was wrong in a way that
 * matters: **a month can be downloaded and empty** — nobody spent anything in it — and
 * calling that "未下载" invites the user to fetch a month that will never have anything
 * in it. Whether a month was ever fetched is a fact about the query cache; how many
 * entries it holds is a fact about the ledger. Only the caller knows the first.
 *
 * Pure, so the arithmetic that decides what "预计" means is testable — and worth
 * testing, because a wrong estimate is what makes somebody delete a month they wanted.
 */
export function monthRows(
  transactions: readonly { readonly occurredLocalDate: string }[],
  never: readonly string[],
  stored: ReadonlySet<string>,
  now: Date,
  count: number = MANAGER_MONTHS,
): readonly MonthRow[] {
  const counts = new Map<string, number>();

  for (const transaction of transactions) {
    const month = transaction.occurredLocalDate.slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }

  /**
   * The average weight of a downloaded month, for estimating the others.
   *
   * Taken over the months actually stored rather than over every month with entries:
   * an estimate built from months nobody downloaded would describe a different set of
   * data than the one it is being added to.
   */
  const measured = [...stored].map((month) => ({ bytes: bytesForMonth(transactions, month) }));
  const average = estimateBytes(measured);
  const neverSet = new Set(never);

  return managerMonths(now, count).map((month): MonthRow => {
    const isStored = stored.has(month);

    return {
      month,
      label: monthLabel(month),
      state: neverSet.has(month) ? "never" : isStored ? "stored" : "missing",
      entryCount: counts.get(month) ?? 0,
      bytes: isStored ? bytesForMonth(transactions, month) : average,
      bytesEstimated: !isStored,
    };
  });
}

/** The months marked "never download". */
export async function readNeverMonths(): Promise<readonly string[]> {
  const stored = await readValue<readonly string[]>(NEVER_DOWNLOAD_KEY);

  return Array.isArray(stored) ? stored : [];
}

/** Remember that a month should not be kept. */
export async function setNeverMonth(month: string, never: boolean): Promise<readonly string[]> {
  const current = await readNeverMonths();
  const next = never ? [...new Set([...current, month])] : current.filter((value) => value !== month);

  await writeValue(NEVER_DOWNLOAD_KEY, next);

  return next;
}

/** Read the persisted query cache as JSON. */
async function readCache(): Promise<{
  readonly clientState?: { readonly queries?: readonly { readonly queryKey?: readonly unknown[] }[] };
} | null> {
  const raw = await readValue<string>(CACHE_KEY);
  if (raw === null) return null;

  try {
    return JSON.parse(raw) as {
      clientState?: { queries?: readonly { queryKey?: readonly unknown[] }[] };
    };
  } catch {
    return null;
  }
}

/** The month a stored transaction-list query is for, or `null`. */
function monthOfQuery(queryKey: unknown): string | null {
  if (!Array.isArray(queryKey) || queryKey[0] !== "transactions") return null;

  const filters = queryKey[1] as { readonly month?: unknown } | undefined;

  return typeof filters?.month === "string" ? filters.month : null;
}

/**
 * The filter fields this version writes into a transaction key.
 *
 * ⚠️ **This is the whole basis of "which stored entries are stale", and it is a shape
 * check rather than a comparison against memory.**
 *
 * The first version compared stored keys against the live query cache — "is anything in
 * memory using this key" — and **deleted the user's entire download.** The flaw is
 * timing: `PersistQueryClientProvider` restores the cache asynchronously, so a person
 * who presses the button early has an **empty** memory, every stored month looks
 * unreferenced, and all sixty are removed. The download manager then correctly reported
 * 0 笔 and 0 B for every month, with nothing left anywhere to put back.
 *
 * **A destructive operation must not depend on something that may not have finished
 * loading.** What a *stale* entry means here is much narrower and knowable offline: it
 * is an entry under a key shape this version no longer writes. That can be judged from
 * the stored data alone, which is the property that makes it safe.
 */
const CURRENT_FILTER_FIELDS: readonly string[] = ["categoryId", "currency", "kind", "month"];

/**
 * Whether a stored transaction key was written by this version.
 *
 * A key from an older build is either missing one of these fields or carries one this
 * version does not write. Either way nothing will ever read it again — which is exactly
 * what makes it safe to delete, and exactly what the user was invited to clean up.
 */
export function isCurrentTransactionKey(queryKey: unknown): boolean {
  if (!Array.isArray(queryKey) || queryKey[0] !== "transactions") return true;

  const filters = queryKey[1];
  if (typeof filters !== "object" || filters === null) return false;

  const fields = Object.keys(filters).sort();

  return (
    fields.length === CURRENT_FILTER_FIELDS.length &&
    fields.every((field, index) => field === CURRENT_FILTER_FIELDS[index])
  );
}

/** Every stored key that is not a transaction list, kept untouched. */
function isTransactionKey(queryKey: unknown): boolean {
  return Array.isArray(queryKey) && queryKey[0] === "transactions";
}

/**
 * Which months the query cache holds **in memory**.
 *
 * ⚠️ **This replaced a version that read the persisted blob, and the difference is the
 * bug the owner hit.**
 *
 * TanStack Query's persistence flows **one way**: the in-memory cache is written to
 * storage whenever it changes. So reading the *stored* blob tells you what was saved at
 * some point in the past, while the app's actual state is in memory — and the next time
 * anything in the cache changes, memory is written back over whatever the blob said.
 *
 * The old `forgetMonth` edited the blob directly. The month vanished from the download
 * manager and stayed in memory, got written back a moment later, and the next download
 * reported **"跳过（已完整）"** — which is exactly what the log showed, eight times in a
 * row, while the storage figure kept climbing.
 *
 * So this asks the live client. It is the only place that knows.
 *
 * ⚠️ **And it is only ever used to *show* things.** Nothing destructive may depend on it,
 * because it is empty until the persister has finished restoring — see
 * `isCurrentTransactionKey` for what deletion is allowed to look at.
 */
export function storedMonthsIn(queryClient: QueryClient): ReadonlySet<string> {
  const months = new Set<string>();

  for (const query of queryClient.getQueryCache().getAll()) {
    const month = monthOfQuery(query.queryKey);
    if (month !== null) months.add(month);
  }

  return months;
}

/**
 * Forget one month, in memory and on disk.
 *
 * ⚠️ **This is the "delete a downloaded month" control, and it must go through the
 * query client.** Removing it only from storage — which is what this used to do — leaves
 * it in memory, and the persister puts it straight back. The user sees a month that will
 * not stay deleted, which is precisely what he reported.
 *
 * `removeQueries` clears the client; the persister then writes a cache without the
 * month, so both halves agree.
 */
export function forgetMonth(queryClient: QueryClient, month: string): number {
  const keys = queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => monthOfQuery(query.queryKey) === month)
    .map((query) => query.queryKey);

  for (const key of keys) queryClient.removeQueries({ queryKey: key, exact: true });

  return keys.length;
}

/**
 * How much room the persisted cache takes, and how much of it is still in use.
 *
 * ⚠️ **Written because the owner watched the figure climb** — "每次下载全部，占用的空间都会
 * 增加" — and there was no way to see what was in there. The answer turned out to be
 * partly real downloads and partly **entries for query keys this version no longer
 * reads**, left behind when the key shape changed (see `transactionFilters`). They are
 * invisible, they are never read again, and they count towards the total.
 */
export interface CacheFootprint {
  /** Bytes of the stored blob. */
  readonly cacheBytes: number;
  /** Queries in it, and how many this version would actually read. */
  readonly queryCount: number;
  readonly liveQueryCount: number;
  /** Bytes held by months the user has marked "never download". */
  readonly deadBytes: number;
  /**
   * The heaviest stored entries: a label and its share of the blob.
   *
   * ⚠️ **Added because the owner reported 44.5 MB on a ledger that holds about two.**
   *
   * Sixty months of his entries is roughly 2 MB of JSON, so a total five times that had
   * to be explained before anything could be fixed — and **there was no way to see inside
   * the blob.** Every guess about what was in it would have been another round of the
   * same mistake: reasoning instead of measuring.
   *
   * The list answers "what is actually taking the room" directly. If the biggest entries
   * are months, the figure is real and the data is real. If they are something else —
   * a summary, a statistic, a key from an older build — that is the answer, and it is an
   * answer no amount of reading the code would have produced.
   */
  readonly heaviest: readonly { readonly label: string; readonly bytes: number }[];
}

/** Measure the stored cache. */
export async function cacheFootprint(queryClient: QueryClient): Promise<CacheFootprint> {
  const raw = (await readValue<string>(CACHE_KEY)) ?? "";
  const parsed = await readCache();

  const stored = parsed?.clientState?.queries ?? [];
  const live = queryClient.getQueryCache().getAll();

  /**
   * Compared as strings, because that is what the persister's own hashing does — and
   * because the objects come back from JSON with the same fields in the same order.
   */
  const liveHashes = new Set(live.map((query) => JSON.stringify(query.queryKey)));
  const storedHashes = new Set(stored.map((query) => JSON.stringify(query.queryKey)));

  let liveQueryCount = 0;
  for (const hash of storedHashes) {
    if (liveHashes.has(hash)) liveQueryCount += 1;
  }

  /**
   * The heaviest entries, measured rather than estimated.
   *
   * Serialised again per entry, which costs a pass over the blob — acceptable for a
   * screen the user opens deliberately, and the only way to answer "what is in here"
   * without guessing.
   */
  const weighed = stored
    .map((query) => {
      const key = JSON.stringify(query.queryKey);
      const label = describeKey(query.queryKey);
      const bytes = JSON.stringify(query).length + key.length;

      return { label, bytes };
    })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 8);

  return {
    cacheBytes: raw.length,
    queryCount: stored.length,
    liveQueryCount,
    deadBytes: Math.max(0, raw.length - raw.length * (stored.length === 0 ? 1 : liveQueryCount / stored.length)),
    heaviest: weighed,
  };
}

/** A query key as a short label a person can read. */
export function describeKey(queryKey: unknown): string {
  if (!Array.isArray(queryKey)) return String(queryKey);

  const name = typeof queryKey[0] === "string" ? queryKey[0] : "?";
  const rest = queryKey[1];

  if (rest === undefined) return name;
  if (typeof rest === "string") return `${name} · ${rest}`;

  if (typeof rest === "object" && rest !== null) {
    const sorted = Object.entries(rest as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .map(([field, value]) => `${field}=${String(value)}`)
      .join(" ");

    /**
     * ⚠️ **The field names are printed, not just the values.**
     *
     * A count of four fields versus three is exactly what told this project which stored
     * entries were leftovers, and it is invisible if only the values are shown.
     */
    return `${name} · ${String(Object.keys(rest).length)}字段 · ${sorted === "" ? "(全空)" : sorted}`;
  }

  return `${name} · ${String(rest)}`;
}

/**
 * Throw away entries no version will read again.
 *
 * ⚠️ **The first version of this deleted the user's entire download**, and the mistake is
 * worth stating plainly because the operation is destructive.
 *
 * It compared stored keys against the **live query cache** — "is anything in memory using
 * this key" — and `PersistQueryClientProvider` restores that cache **asynchronously**. So
 * pressing the button before the restore finished meant an **empty** memory, every stored
 * month counted as unreferenced, and all sixty were removed. The manager then showed
 * 0 笔 / 0 B for every month, correctly, with nothing anywhere to restore.
 *
 * **A destructive operation must not depend on something that may not have loaded yet.**
 *
 * What "stale" means here is narrower and, crucially, **decidable from the stored data
 * alone**: an entry under a key shape this version no longer writes. Judging that needs
 * no memory, no restore, and no timing — which is what makes it safe to offer.
 *
 * And it refuses to act when it finds nothing, so an unexpected shape cannot turn a
 * cleanup into a wipe.
 */
export async function forgetStaleEntries(): Promise<number> {
  const parsed = await readCache();
  if (parsed === null) return 0;

  const queries = parsed.clientState?.queries ?? [];
  if (queries.length === 0) return 0;

  const kept = queries.filter(
    (query) => !isTransactionKey(query.queryKey) || isCurrentTransactionKey(query.queryKey),
  );

  const removed = queries.length - kept.length;

  /**
   * ⚠️ **Nothing to remove means nothing is written.**
   *
   * A cleanup that rewrites the cache when it has no reason to is a cleanup that can lose
   * data for no benefit. The only thing this function is allowed to do is drop entries it
   * has positively identified as unreadable.
   */
  if (removed === 0) return 0;

  await writeValue(
    CACHE_KEY,
    JSON.stringify({ ...parsed, clientState: { ...parsed.clientState, queries: kept } }),
  );

  return removed;
}

/**
 * Delete every downloaded month.
 *
 * The owner asked for this beside "下载全部": "可以在下载管理的主页'下载全部'按钮下面加一个
 * 删除全部按钮，这个按钮用红底."
 *
 * ⚠️ **It goes through the query client, and that is not optional.** Removing the entries
 * from storage alone leaves them in memory, and the persister writes memory back over
 * storage a moment later — which is the bug that took two rounds to find. Clearing the
 * client first means both copies agree, and the persister's next write is the one that
 * makes the deletion stick.
 *
 * Returns how many months were cleared, so the caller can say so rather than showing an
 * empty list with no explanation.
 */
export function forgetAllMonths(queryClient: QueryClient): number {
  const keys = queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => isTransactionKey(query.queryKey))
    .map((query) => query.queryKey);

  for (const key of keys) queryClient.removeQueries({ queryKey: key, exact: true });

  return keys.length;
}
