import type { Transaction, TransactionListResponse } from "@libellum/shared";

import { logOffline } from "./diagnostics.js";
import { readValue, writeValue } from "./storage.js";

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
   * ⚠️ **A read that is already in flight is joined rather than repeated.**
   *
   * The owner's diagnostics showed the same read happening four and five times in the same
   * millisecond — `DIAGNOSTIC:local-read — 磁盘 115644 字节 → 138 条` repeated — because four screens
   * call this hook and each fired its own read. Every one of them parses a hundred-kilobyte blob and
   * merges 138 entries, **on the main thread**, and a tablet that is also suspending pages does not
   * absorb that. **The work was being done several times over and the screen was paying for it.**
   */
  if (inFlight !== null) return inFlight;

  inFlight = (async () => {
    /**
     * A hook the query layer installs, so the live cache can be consulted without this module
     * importing it — which would be a cycle, and would tie a storage concern to React.
     */
    const live = liveSource?.() ?? [];

    /**
     * ⚠️ **Our own store first, because it is the one nothing else can empty.**
     *
     * See `storeMonth`. The query cache is a *view of memory* and the persistence layer rewrites it
     * wholesale — which is how sixty downloaded months became six. **This map is only ever added to**, so
     * a month the user downloaded is available even when the query cache has forgotten it.
     */
    /**
     * ⚠️ **With one retry, because a first read can come back empty and the second does not.**
     *
     * The owner's report had `本机存储：60 个月 / 138 条` from the diagnostics page and an empty read
     * from the ledger **at the same time, on the same device, from the same store**. A `get` that
     * returns nothing while the value is demonstrably present is a known IndexedDB behaviour under load
     * and during page resumption ([WebKit #251203](https://wiki.webkit.org/show_bug.cgi?id=251203)
     * describes requests failing with no error).
     *
     * **One retry is the difference between "the device has nothing" and "this particular read did not
     * see it"** — and everywhere else in the program those two are indistinguishable.
     */
    let mine = await readStoredEntries();

    if (mine.length === 0) {
      await logOffline("DIAGNOSTIC:ledger-reread", "第一次读本机存储为空，重试一次");
      mine = await readStoredEntries();
    }

    const raw = await readValue<string>(CACHE_KEY);

    /**
     * ⚠️ **Through the memo**, because this runs for every screen and every filter change and the
     * blob is over a hundred kilobytes. See `transactionsFromCacheCached`.
     */
    const fromDisk = transactionsFromCacheCached(raw);

    const mergedEntries = mergeLocal(mergeLocal(fromDisk, live), mine);

    /**
     * ⚠️ **Recorded before the read is logged, so the report and the log cannot disagree.**
     *
     * `readLocalTransactions` is the only place that knows all four numbers at once: what the disk
     * held, what memory held, what they add up to after merging, and — when there is nothing — a
     * phrase a person can read.
     *
     * ⚠️ **`storedEntries` is counted separately, and that separation is the point.**
     *
     * The owner's report had `本机存储：60 个月 / 138 条` from the diagnostics page and `磁盘 0 条，
     * 内存 138 条` from this banner **at the same time** — so the data was stored and this read did not
     * see it. **One number that says "stored" and one that says "read" is what tells those apart**;
     * a merged total hides exactly the disagreement being investigated.
     */
    localRead = {
      at: Date.now(),
      diskBytes: raw === null ? 0 : raw.length,
      diskEntries: fromDisk.length,
      liveEntries: live.length,
      storedEntries: mine.length,
      total: mergedEntries.length,
      note:
        mine.length > 0
          ? `本机存储 ${String(mine.length)} 条`
          : raw === null
            ? "本机没有缓存"
            : fromDisk.length === 0
              ? "缓存里没有账目"
              : null,
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

    return mergedEntries;
  })()
    .then((entries) => {
      /**
       * ⚠️ **Published synchronously, before the promise resolves.**
       *
       * This is the whole point of the store: the value is in place for the *next render*, whichever
       * render that turns out to be, rather than waiting on a state update that might not arrive. The
       * caller still gets the entries as before — nothing about the read changed.
       */
      publishLedger(entries);

      return entries;
    })
    .finally(() => {
      /**
       * ⚠️ **Cleared in `finally`, so a failed read does not poison every later one.**
       *
       * The join is an optimisation; if the shared attempt failed, the next caller must be allowed to
       * try again rather than receive the same rejection for the rest of the session.
       */
      inFlight = null;
    });

  return inFlight;
}

/**
 * The ledger, stored by us, in a shape we control.
 *
 * ⚠️ **This exists because the query cache is not a safe place for the user's data.**
 *
 * The owner's evidence, gathered over many rounds, is that the persistence layer loses months:
 *
 * ```
 * 01:11:56.582  cache-merge — kept 60 month entries
 * 01:11:58.580  cache-merge — kept 1 month entry        ← one second later
 * 01:13:28.149  write query-cache — 14247 bytes         ← from 124447
 * ```
 *
 * And the cache listing that started it: `ledger`, a single `transaction`, `summary` and several
 * `stats` entries, and **six `transactions` where sixty were downloaded**.
 *
 * **Why the query cache cannot be trusted with this.** It is a *view* of what the app currently has in
 * memory, and the persistence layer writes that view wholesale. Anything that leaves memory — an
 * eviction, a reload before a month was ever observed, a throttled write that is overtaken — is written
 * out of storage with it. **The owner asked for his whole history to be on the device; a structure
 * whose job is to forget things is the wrong place to keep it.**
 *
 * ⚠️ **His own explanation of why this should be simple is the design brief**: "数据保存到本地，然后它就
 * 可以直接拿这些本地的数据去计算去显示，毕竟我用电脑直接调一个本地的文件可没出现过这么多问题."
 * He is right, and this is that: **a plain map from month to entries, written when entries are fetched,
 * read when they are needed, with nothing in between that can decide to drop them.**
 *
 * ```
 * ledger-months  →  { "2026-10": [ …entries… ], "2026-09": [ … ], … }
 * ```
 *
 * No expiry, no eviction, no dehydrate/hydrate, no throttled whole-file rewrite. **A month is written
 * once when it is downloaded and stays until something deliberately removes it** — which is exactly what
 * "downloaded for offline use" means.
 */
export const LEDGER_MONTHS_KEY = "ledger-months";

/**
 * Which entries have not reached the server, and which were deleted on this device.
 *
 * ⚠️ **A separate key, not a field on the entries.**
 *
 * The entries are the server's response, stored as it arrived — that is what makes them usable for
 * conflict comparison in round 3. **Sprinkling our own bookkeeping through them would mean every
 * future schema change to `Transaction` has to account for fields the server never sent.**
 *
 * | Value | Meaning |
 * |---|---|
 * | `pending: true` | The entry exists locally and has not been accepted by the server yet |
 * | `deleted: true` | The entry was deleted on this device; the server has not been told |
 *
 * ⚠️ **A locally deleted entry stays in `ledger-months` rather than being removed.**
 *
 * Its stored copy is exactly what round 3 needs to show the user *what they deleted* while asking
 * whether the delete should stand. **Keeping it costs a few hundred bytes; losing it costs the
 * comparison.**
 */
export const LEDGER_MARKS_KEY = "ledger-marks";

export interface EntryMark {
  readonly pending?: boolean;
  readonly deleted?: boolean;
}

/** Marks by entry id. */
export type LedgerMarks = Record<string, EntryMark>;

/** Which entries are unsynced or deleted-locally. Never throws. */
export async function readMarks(): Promise<LedgerMarks> {
  const stored = await readValue<LedgerMarks>(LEDGER_MARKS_KEY);

  return stored === null || typeof stored !== "object" ? {} : stored;
}

/** Set or clear one entry's mark. */
export async function setMark(id: string, mark: EntryMark | null): Promise<void> {
  const all = await readMarks();
  const next = { ...all };

  if (mark === null || (mark.pending !== true && mark.deleted !== true)) delete next[id];
  else next[id] = mark;

  await writeValue(LEDGER_MARKS_KEY, next);

  /**
   * ⚠️ **The stored marks and the in-memory set are updated together**, so the row colouring on
   * screen cannot disagree with what is actually queued. Two sources of truth for one fact is how the
   * ledger's own cache went wrong.
   */
  publishPending(pendingFromMarks(next));
}

/** The entries a marks map says are stored but not yet on the server. */
export function pendingFromMarks(marks: LedgerMarks): ReadonlySet<string> {
  /**
   * ⚠️ **A locally deleted entry is not "pending" for display purposes** — it is gone from the
   * screen, so marking it would colour nothing. Its queue row still exists and still needs delivering.
   */
  return new Set(
    Object.entries(marks)
      .filter(([, mark]) => mark.pending === true && mark.deleted !== true)
      .map(([id]) => id),
  );
}

/** Every month's entries, keyed by `YYYY-MM`. */
export type StoredMonths = Record<string, readonly Transaction[]>;

/** Read the stored months. Never throws: an unreadable store is an empty one. */
export async function readStoredMonths(): Promise<StoredMonths> {
  const stored = await readValue<StoredMonths>(LEDGER_MONTHS_KEY);

  return stored === null || typeof stored !== "object" ? {} : stored;
}

/**
 * Write one month's entries.
 *
 * ⚠️ **Read-modify-write, and it goes through `writeValue`, which is serialised per key** — so two
 * months finishing at once cannot lose each other. That is the bug this file has already been bitten by
 * once in the cache layer, and it is not going to be repeated here.
 */
export async function storeMonth(month: string, entries: readonly Transaction[]): Promise<void> {
  const all = await readStoredMonths();

  await writeValue(LEDGER_MONTHS_KEY, { ...all, [month]: entries });
}

/**
 * Add or replace one entry in its month.
 *
 * ⚠️ **Used by the offline write path**, and it is the whole of "the change appears immediately":
 * the screen reads this store, so a write here is on screen before the server hears anything.
 */
export async function upsertEntry(entry: Transaction): Promise<void> {
  const month = entry.occurredLocalDate.slice(0, 7);
  const all = await readStoredMonths();
  const existing = all[month] ?? [];

  const without = existing.filter((candidate) => candidate.id !== entry.id);

  await writeValue(LEDGER_MONTHS_KEY, { ...all, [month]: [...without, entry] });
}

/**
 * Every entry the device holds, from every stored month.
 *
 * ⚠️ **Locally deleted entries are left out**, because the screen must not show them. They stay in
 * storage for the conflict comparison in round 3 — see `LEDGER_MARKS_KEY` — so the filtering happens
 * here, at the one place everything reads through.
 */
export async function readStoredEntries(): Promise<readonly Transaction[]> {
  const all = await readStoredMonths();
  const marks = await readMarks();
  const found = new Map<string, Transaction>();

  for (const entries of Object.values(all)) {
    for (const entry of entries) {
      if (marks[entry.id]?.deleted === true) continue;

      found.set(entry.id, entry);
    }
  }

  return [...found.values()];
}

/** Whether the device holds anything for a month. */
export async function hasStoredMonth(month: string): Promise<boolean> {
  const all = await readStoredMonths();

  return (all[month]?.length ?? 0) > 0;
}
/**
 * The ledger as the screens read it, held outside React.
 *
 * ⚠️ **This exists because a React state update was called and did not render.**
 *
 * The owner's tablet read the ledger successfully — `local-read — 磁盘 … → 138 条；内存 138 条` — the
 * banner reported the same count, **and the ledger screen stayed on its placeholder rows through
 * several attempts**, including one that bypassed the query layer entirely and passed the result
 * straight into `useState`.
 *
 * That combination has a name: **the state updater ran and the component did not re-render**, which is
 * a reported WebKit/React interaction rather than anything about this application's data
 * ([React #22459](https://github.com/facebook/react/issues/22459),
 * [WebKit #251203](https://wiki.webkit.org/show_bug.cgi?id=251203)). The device is an iPad Pro — the
 * rendering is not the weak link, so the answer is not to make the work smaller. It is to **stop
 * routing the answer through a mechanism that can drop it.**
 *
 * So the entries live here, in a plain module-level value, and screens read them with
 * `useSyncExternalStore` — **the API React provides for exactly this: a data source that lives outside
 * it.**
 */
let ledgerSnapshot: readonly Transaction[] = [];
const ledgerListeners = new Set<() => void>();

/** The ledger as last read from the device. Synchronous, for render. */
export function ledgerSnapshotValue(): readonly Transaction[] {
  return ledgerSnapshot;
}

/** Subscribe to changes, for `useSyncExternalStore`. */
export function subscribeLedger(listener: () => void): () => void {
  ledgerListeners.add(listener);

  return () => {
    ledgerListeners.delete(listener);
  };
}

/** Publish a new snapshot, and tell React. */
function publishLedger(entries: readonly Transaction[]): void {
  ledgerSnapshot = entries;

  for (const listener of ledgerListeners) listener();
}

/**
 * Which entries are stored but not yet on the server — held outside React, like the ledger itself.
 *
 * ⚠️ **The same mechanism as the ledger, for the same reason.**
 *
 * The owner asked for offline entries to be visually marked: "离线状态下新建出来的记账底色要特殊一些…
 * 用来提醒用户，现在还没被备份到服务器". That is a *value the screen reads*, and this project has already
 * learned what happens when such a value travels through a React state update on his tablet: **it is
 * dropped, and the screen shows a state that is not true.**
 *
 * ⚠️ **A `Set` replaced wholesale, never mutated.** `useSyncExternalStore` compares snapshots by
 * identity, so mutating one would be "no change" as far as React is concerned — **and the marker would
 * never appear, which is precisely the failure mode being avoided.**
 */
let pendingSnapshot: ReadonlySet<string> = new Set();
const pendingListeners = new Set<() => void>();

/** Entry ids that are stored locally and not yet accepted by the server. */
export function pendingEntriesValue(): ReadonlySet<string> {
  return pendingSnapshot;
}

/** Subscribe to changes, for `useSyncExternalStore`. */
export function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener);

  return () => {
    pendingListeners.delete(listener);
  };
}

/**
 * Replace the pending set and tell React.
 *
 * ⚠️ **Skips the notification when nothing changed**, because this is called after every write and every
 * read — and a notify that changes nothing is a render that changes nothing.
 */
export function publishPending(ids: ReadonlySet<string>): void {
  if (ids.size === pendingSnapshot.size && [...ids].every((id) => pendingSnapshot.has(id))) return;

  pendingSnapshot = new Set(ids);

  for (const listener of pendingListeners) listener();
}

/**
 * The read currently in progress, so concurrent callers share it.
 *
 * ⚠️ **Not a cache — a join.** The value is not kept: a completed read is forgotten immediately, so
 * a later caller always sees what the device holds now. Only *overlapping* calls are merged, which is
 * exactly the case the diagnostics showed — four screens reading the same blob in the same
 * millisecond.
 */
let inFlight: Promise<readonly Transaction[]> | null = null;

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
  /** Entries our own month-keyed store held. Counted apart from `diskEntries` on purpose. */
  readonly storedEntries: number;
  readonly total: number;
  /** A plain-language reason, when there is nothing to show. */
  readonly note: string | null;
}

let localRead: LocalReadReport = {
  at: 0,
  diskBytes: 0,
  diskEntries: 0,
  liveEntries: 0,
  storedEntries: 0,
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
