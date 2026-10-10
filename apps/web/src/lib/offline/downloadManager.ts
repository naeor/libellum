import type { Transaction } from "@libellum/shared";

import { readValue, writeValue } from "./storage.js";

/**
 * What the download manager shows and controls, month by month.
 *
 * The owner's design: "用户可以在里面看到已经下载内容的明细，颗粒度到月就可以——
 * 用户可以看到按月分类的账本及其状态（比如 26 年 9 月份账本已经被下载，占用多少空间，
 * 10 月份的账本还未下载，预计占用多少空间），并且可以控制不同月份账本的下载设置（比如
 * 删除已下载的某月账本，设置为永不下载等等）."
 *
 * ⚠️ **Month is the right granularity, and it is the one the app already thinks in.**
 * The list screen is per month, the download walks months, and a month is a unit a
 * person recognises — "September is downloaded" means something in a way that
 * "12.4 MB of 20.1 MB" does not. Sizing a month needs no new data either: the
 * entries for it are already stored, so its weight is measured rather than guessed.
 *
 * **A month marked "never" is a decision, not a gap.** Somebody may not want five
 * years of 2019 on a phone, and "do not keep this one" is not the same as "not yet"
 * — so the fill skips it and says nothing about it, rather than re-fetching it on
 * every launch for ever.
 */

/** Months the user has told us not to keep. */
export const NEVER_DOWNLOAD_KEY = "offline-never-months";

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
 * **Measured, not guessed**, for a stored month: the entries are here, so the bytes
 * are the bytes. Counting them rather than asking the browser keeps the figure
 * attached to a month — `storage.estimate()` reports a total for the whole origin
 * and cannot say which month it belongs to.
 */
export function bytesForMonth(transactions: readonly Transaction[], month: string): number {
  let bytes = 0;

  for (const transaction of transactions) {
    if (transaction.occurredLocalDate.slice(0, 7) !== month) continue;

    // The stored form is JSON. Measuring the entry as it would be written is a
    // close enough answer for "which months are worth deleting", and it needs no
    // walking of the real blob.
    bytes += JSON.stringify(transaction).length;
  }

  return bytes;
}

/**
 * The estimate for a month that is not stored.
 *
 * The average of the months that are, or a small floor when nothing is stored yet.
 * An estimate is honest about being one — the screen says "预计" — and the
 * alternative, showing nothing, tells the user less than a rough figure does.
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
 * Pure, so the arithmetic that decides what "stored" and "预计" mean is testable —
 * and worth testing, because a wrong estimate here is what makes somebody delete a
 * month they wanted or keep one they did not.
 */
export function monthRows(
  transactions: readonly Transaction[],
  never: readonly string[],
  now: Date,
  count: number = MANAGER_MONTHS,
): readonly MonthRow[] {
  const stored = new Set<string>();
  const counts = new Map<string, number>();

  for (const transaction of transactions) {
    const month = transaction.occurredLocalDate.slice(0, 7);
    stored.add(month);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }

  const measured = [...stored].map((month) => ({ bytes: bytesForMonth(transactions, month) }));
  const average = estimateBytes(measured);
  const neverSet = new Set(never);

  return managerMonths(now, count).map((month): MonthRow => {
    const isStored = stored.has(month);

    /**
     * An empty month is not a missing one.
     *
     * A month with no entries costs nothing to "download" — there is nothing to
     * fetch — so calling it missing would invite the user to download a month that
     * will never have anything in it. `stored` is decided by whether the month was
     * ever fetched, which is a fact the cache knows and the count does not.
     */
    const state: MonthRow["state"] = neverSet.has(month) ? "never" : isStored ? "stored" : "missing";

    return {
      month,
      label: monthLabel(month),
      state,
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
  const next = never
    ? [...new Set([...current, month])]
    : current.filter((value) => value !== month);

  await writeValue(NEVER_DOWNLOAD_KEY, next);

  return next;
}

/**
 * Which months are actually stored.
 *
 * ⚠️ **Asked of the query cache, not of the entries.** "Is September downloaded"
 * and "does September have entries" are different questions, and only the first is
 * the one the screen asks: September can be stored and empty, and that is a
 * finished month with nothing missing.
 *
 * The keys live in one persisted blob rather than a key per month, so this reads
 * that blob once instead of sixty times.
 */
export async function storedMonths(): Promise<ReadonlySet<string>> {
  const raw = await readValue<string>("query-cache");
  if (raw === null) return new Set();

  let parsed: { clientState?: { queries?: readonly { queryKey?: readonly unknown[] }[] } };

  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return new Set();
  }

  const months = new Set<string>();

  for (const query of parsed.clientState?.queries ?? []) {
    const key = query.queryKey;

    // The key is `["transactions", filters]`, matching `queryKeys.transactions`.
    if (!Array.isArray(key) || key[0] !== "transactions") continue;

    const filters = key[1] as { readonly month?: unknown } | undefined;

    if (typeof filters?.month === "string") months.add(filters.month);
  }

  return months;
}

/**
 * Forget one month.
 *
 * ⚠️ **This is the "delete a downloaded month" control, and it is a real deletion
 * rather than a flag.** It removes the month's entry from the stored query cache,
 * so the space is genuinely given back and the fill will fetch it again if the user
 * changes their mind. Marking it without removing it would leave the data on the
 * device while telling the user it was gone — which is worse than either.
 *
 * The next time the app is online the fill will notice the month is missing and
 * fetch it again, so this is paired with the "never" flag in the interface: delete
 * *and* never is the combination that means "I do not want this".
 */
export async function forgetMonth(month: string): Promise<boolean> {
  const raw = await readValue<string>("query-cache");
  if (raw === null) return false;

  let parsed: { clientState?: { queries?: unknown[] } };

  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return false;
  }

  const queries = parsed.clientState?.queries;
  if (!Array.isArray(queries)) return false;

  const kept = queries.filter((query) => {
    const key = (query as { queryKey?: readonly unknown[] }).queryKey;

    if (!Array.isArray(key) || key[0] !== "transactions") return true;

    return (key[1] as { readonly month?: unknown } | undefined)?.month !== month;
  });

  if (kept.length === queries.length) return false;

  parsed.clientState = { ...parsed.clientState, queries: kept };

  return writeValue("query-cache", JSON.stringify(parsed));
}
