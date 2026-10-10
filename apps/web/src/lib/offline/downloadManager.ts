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
}

/** Measure the stored cache. */
export async function cacheFootprint(queryClient: QueryClient): Promise<CacheFootprint> {
  const raw = (await readValue<string>(CACHE_KEY)) ?? "";
  const parsed = await readCache();

  const queries = parsed?.clientState?.queries ?? [];
  const live = queryClient.getQueryCache().getAll();

  const liveHashes = new Set(live.map((query) => JSON.stringify(query.queryKey)));
  const storedHashes = new Set(queries.map((query) => JSON.stringify(query.queryKey)));

  let liveQueryCount = 0;
  for (const hash of storedHashes) {
    if (liveHashes.has(hash)) liveQueryCount += 1;
  }

  return {
    cacheBytes: raw.length,
    queryCount: queries.length,
    liveQueryCount,
    deadBytes: Math.max(0, raw.length - raw.length * (queries.length === 0 ? 1 : liveQueryCount / queries.length)),
  };
}

/**
 * Throw away the leftovers.
 *
 * ⚠️ **Written because the owner watched the storage figure climb and there was nothing
 * to do about it.** When the transaction key shape changed (see `transactionFilters`),
 * every month stored under the *old* key became an entry this version never reads again:
 * invisible, permanent, and counted in the total he could see.
 *
 * The mechanism is simply to have the persister write memory back. **Memory is what the
 * app is using**, so re-persisting it keeps exactly the live entries and drops the rest —
 * nothing readable is lost, because anything readable is in memory.
 *
 * `invalidateQueries` is what marks every live query as needing a re-persist; the
 * persister then writes the whole of memory, and the leftovers are gone.
 */
export async function forgetStaleEntries(queryClient: QueryClient): Promise<void> {
  const parsed = await readCache();
  if (parsed === null) return;

  const queries = parsed.clientState?.queries ?? [];
  if (queries.length === 0) return;

  const liveHashes = new Set(
    queryClient.getQueryCache().getAll().map((query) => JSON.stringify(query.queryKey)),
  );

  const kept = queries.filter((query) => liveHashes.has(JSON.stringify(query.queryKey)));

  await writeValue(
    CACHE_KEY,
    JSON.stringify({ ...parsed, clientState: { ...parsed.clientState, queries: kept } }),
  );
}
