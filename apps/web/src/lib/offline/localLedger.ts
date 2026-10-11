import type { Transaction, TransactionListResponse } from "@libellum/shared";

import { logOffline } from "./diagnostics.js";
import { readSnapshot, readValue, writeValue } from "./storage.js";

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

/**
 * What this device intends for one entry — **the only record of unsent work, and the source of its colour.**
 *
 * ⚠️ **One record, two readings.** The row's colour is this mark, and the work a sync performs is this mark.
 * **They cannot disagree, because they are not two things** — which is the whole reason this replaced a
 * persisted queue: a queue can be lost, never written, or emptied while the marks say otherwise, and **that is
 * exactly what the owner's two stuck rows turned out to be.**
 *
 * | Field | Meaning |
 * |---|---|
 * | `deleted` | **Delete this.** The row is struck through and pale red, and a sync sends one `DELETE` |
 * | `pending` | **Not in step with the server yet** — either never sent, or changed since |
 * | `synced` | `false` means **the server has never had it**, so a sync must `POST`; otherwise it must `PATCH` |
 * | `tagIds` | Carried here because tags are not on the stored entry and a create needs them |
 */
/** The version both sides started from, when the device still knows it. */
export interface ConflictRecord {
  /** This device's copy — what the user typed. */
  readonly mine: Transaction;
  /** The server's copy — what everybody else has. */
  readonly theirs: Transaction;
  /**
   * The version both sides started from, or `null` when it is not known.
   *
   * ⚠️ **Without it every difference becomes a question**, which is the version of this feature that makes the
   * user do work the program could have done — see `merge.ts`.
   */
  readonly base: Transaction | null;
  /**
   * ⚠️ **The fields the server says are genuinely in dispute** — and nothing else is asked about.
   *
   * The rule is the owner's: **"只有在服务器的数值是 C，而某台设备上传的请求是把数字从 A 改成 B 时才会触发冲突
   * 机制"** — and only the server can tell, because only it knows whether the value the device read has moved.
   * **A field the server accepted is not here**, so the user is never asked about an edit nobody disagreed with.
   */
  readonly fields?: readonly { readonly field: string; readonly serverValue: unknown }[];
  /** When it was noticed, so the oldest unanswered conflict can be shown first. */
  readonly at: number;
}

export interface EntryMark {
  readonly pending?: boolean;
  readonly deleted?: boolean;
  /** `false` when the server has never accepted this entry. */
  readonly synced?: boolean;
  /** The tags to create it with, kept because `Transaction` does not carry their ids. */
  readonly tagIds?: readonly string[];
  /**
   * Every value this device passed through while working offline, one entry per field.
   *
   * ⚠️ **A change is remembered as "from A to B", not as "set it to B"** — the owner's rule, and the whole basis
   * of the conflict decision:
   *
   * > **"只有在服务器的数值是 C，而某台设备上传的请求是把数字从 A 改成 B 时才会触发冲突机制."**
   *
   * ⚠️ **And every step is kept, not just the two ends**: "设备本地在恢复网络上传时要把从断网开始的每一步改动都
   * 上传." The first link is the base the server compares against, the last is what the user wants, and **the ones
   * in between become the server's value history** — which is what lets a later device recognise a value the
   * server has already held.
   *
   * ⚠️ **This is the piece that was missing**, and its absence is why every offline edit looked like a conflict:
   * without a recorded base there was nothing to compare against, so the honest-looking fallback was to ask about
   * everything.
   */
  readonly chain?: Readonly<Record<string, readonly unknown[]>>;

  /**
   * Set when **this send is the user settling a conflict**.
   *
   * ⚠️ **Without it the server never closes the question**, and the conflict it raised is handed back on the next
   * pull for ever — **a row that stays yellow no matter how many times the user answers it**, which is exactly what
   * the owner reported: "即使我选择了一个保存，退出之后，它仍然是黄色的 20 元."
   */
  readonly settlesConflict?: boolean;

  /**
   * The version the server last confirmed for this entry, and what it held then.
   *
   * ⚠️ **This is the value a new edit's chain must start from, and using the local copy instead was a silent
   * data loss.** The owner's own test caught it: the tablet went 20 → 40 and synced; the phone changed it to 20;
   * the tablet — still showing 40 — edited again and **the server took the tablet's 40**, overwriting the phone's
   * change with nobody asked.
   *
   * ⚠️ **Why that happened**: the chain was built from `current`, the device's own copy, **and the version sent
   * was the device's own too — which the device had just incremented itself.** The server compared those two and
   * found them equal, so it read the change as "editing what I just saw" and accepted it. **The device was
   * describing a state the server had never been in.**
   *
   * ⚠️ **Both halves matter**: the version decides whether the server thinks anything has happened, and the
   * snapshot is the "from A" half of "from A to B". **A chain whose base is the device's own value is a claim
   * about the past that is not true.**
   */
  readonly serverVersion?: number;
  readonly serverEntry?: Transaction;

  /**
   * Both versions of an entry that could not be sent because somebody else changed it.
   *
   * ⚠️ **The two copies are stored here rather than fetched again when the screen opens.** The server's copy
   * arrives with the refusal, mine is what the device holds right now, and **the very next refresh would
   * replace mine with theirs** — so a conflict that is not captured at the moment it is detected has already
   * lost the thing the user typed.
   */
  readonly conflict?: ConflictRecord;
}

/** Marks by entry id. */
export type LedgerMarks = Record<string, EntryMark>;

/** Which entries are unsynced or deleted-locally. Never throws. */
export async function readMarks(): Promise<LedgerMarks> {
  /**
   * ⚠️ **The memory copy wins when it exists, because it is the one this process last wrote.**
   *
   * ⚠️ **A missing key is not the same as an empty map, and this distinction has cost the user twice**: the
   * iPad reported `read ledger-marks — 键不存在` while marks had been written there, and **a device with no
   * marks cannot know what its owner asked to delete.**
   */
  const cached = readSnapshot<LedgerMarks>(LEDGER_MARKS_KEY);

  if (cached !== null && typeof cached === "object") return cached;

  const stored = await readOwn<LedgerMarks>(LEDGER_MARKS_KEY);

  return stored === null || typeof stored !== "object" ? {} : stored;
}

/**
 * Forget every mark — "stop telling me about these, I have looked".
 *
 * ⚠️ **An escape hatch the owner asked for by implication**: "一个你明确要求删掉、却删不掉的记录，比一个颜色不对
 * 更糟." Every automatic path in this area has now been wrong at least once, and **when the program cannot carry
 * out an instruction, the person who gave it must be able to withdraw it.**
 *
 * ⚠️ **It does not touch the entries** — only the intentions. Anything already deleted on the server stays
 * deleted; anything still there stays there and is simply no longer announced. **Nothing is created, nothing is
 * removed, and the ledger is left exactly as the server sees it.**
 */
export async function clearAllMarks(): Promise<void> {
  const before = await readMarks();
  const hadConflict = Object.values(before).some((mark) => mark.conflict !== undefined);

  await writeOwn(LEDGER_MARKS_KEY, {});

  publishPending(new Set());
  publishDeleted(new Set());
  /**
   * ⚠️ **The questions are cleared locally too, and the server is told separately** — see `deferConflictsToServer`.
   * Without the second half the rows stayed on the server, the next pull returned them, **and the button looked
   * like it did nothing.**
   */
  publishConflicts([]);

  await logOffline(
    "DIAGNOSTIC:marks-cleared",
    hadConflict ? "用户清空印记：不再选择，以服务器为准" : "用户清空了全部待同步印记",
  );
}

/**
 * Remember that this entry could not be sent, and keep both versions.
 *
 * ⚠️ **A conflict is a question, not an error.** The entry stays exactly as the user left it on screen — **their
 * edit is not discarded to make the conflict go away** — and the row carries a mark until they answer.
 */
/**
 * Conflicts waiting for an answer — held outside React, like everything else the screens read.
 *
 * ⚠️ **The same external store as the ledger and the marks, for the same reason.** This is a list the conflict
 * screen draws from, and **a list that travels through a React state update is the thing that silently fails on
 * the device this feature exists for** — see the note on `ledgerSnapshot`.
 */
let conflictsSnapshot: readonly ConflictRecord[] = [];
const conflictListeners = new Set<() => void>();

/** Every conflict waiting for an answer, oldest first. */
export function conflictsValue(): readonly ConflictRecord[] {
  return conflictsSnapshot;
}

/** Subscribe to changes, for `useSyncExternalStore`. */
export function subscribeConflicts(listener: () => void): () => void {
  conflictListeners.add(listener);

  return () => {
    conflictListeners.delete(listener);
  };
}

/** Replace the conflict list and tell React. */
export function publishConflicts(next: readonly ConflictRecord[]): void {
  conflictsSnapshot = next;

  for (const listener of conflictListeners) listener();
}

export async function setConflict(id: string, conflict: ConflictRecord): Promise<void> {
  const all = await readMarks();

  await writeOwn(LEDGER_MARKS_KEY, { ...all, [id]: { ...all[id], pending: true, conflict } });

  publishConflicts(conflictsFromMarks({ ...all, [id]: { ...all[id], pending: true, conflict } }));
}

/** Every entry waiting for an answer about a conflict. */
export function conflictsFromMarks(marks: LedgerMarks): readonly ConflictRecord[] {
  return Object.values(marks)
    .map((mark) => mark.conflict)
    .filter((conflict): conflict is ConflictRecord => conflict !== undefined)
    .sort((left, right) => left.at - right.at);
}

/** Set or clear one entry''s mark. */
export async function setMark(id: string, mark: EntryMark | null): Promise<void> {
  /**
   * ⚠️ **Read from the synchronous snapshot, not from the disk.**
   *
   * The owner's iPad reported `read ledger-marks — 键不存在` while marks had demonstrably been written on that
   * device earlier — **and a read that misses is exactly how this file has lost data before**: the write path is
   * fired without being awaited, so an `await`-based read can be answered from before it.
   *
   * `readSnapshot` returns what is already in memory, which is what this process last wrote. **If nothing is in
   * memory yet the marks have never been touched in this session, so an empty object is the truth** — and the
   * first `writeOwn` will persist it together with the new mark.
   */
  const cached = readSnapshot<LedgerMarks>(LEDGER_MARKS_KEY);
  const all: LedgerMarks = cached ?? {};
  const next = { ...all };

  if (mark === null || (mark.pending !== true && mark.deleted !== true)) delete next[id];
  else next[id] = mark;

  await writeOwn(LEDGER_MARKS_KEY, next);

  /**
   * ⚠️ **The stored marks and the in-memory set are updated together**, so the row colouring on
   * screen cannot disagree with what is actually queued. Two sources of truth for one fact is how the
   * ledger's own cache went wrong.
   */
  publishPending(pendingFromMarks(next));
  publishDeleted(
    new Set(
      Object.entries(next)
        .filter(([, mark]) => mark.deleted === true)
        .map(([id]) => id),
    ),
  );
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

/**
 * In-memory authority for the two stores this file owns.
 *
 * The owner's account of the symptom was exact, and it named the cause:
 *
 * | What he did | What he saw |
 * |---|---|
 * | wrote `test02` offline | it did not appear; it appeared after reconnecting |
 * | wrote `test03` offline | `test02` and `test03` turned red together |
 * | wrote `test04` offline | `test04` did not appear; `test03` and `test02` turned red |
 *
 * **Every write showed up one write late.** That pattern has one cause: a read issued after a write
 * returned the state from before it. The read was `await readValue(...)` against IndexedDB and the write
 * was `void writeValue(...)` fired without being awaited, so the read ran first and the screen was shown
 * the previous version. **The data was never wrong; the view was always one step behind** — which is why
 * it looked like a timing ghost rather than a bug.
 *
 * IndexedDB is where this data is *kept*; it is not where the current truth is while the app runs.
 * **Memory is.** These maps are loaded once and are what every read uses; every write updates memory first
 * and persists second, so **a read cannot be answered by an older value because it does not go to the
 * disk at all.**
 *
 * This is the same shape as the mistake that cost four hours (see the lessons document): a store's
 * persisted contents are a report about the past, and the ledger being edited is the present.
 */
const memory = new Map<string, unknown>();

/** Read one of our stores from memory, loading it once per session. */
async function readOwn<T>(key: string): Promise<T | null> {
  if (memory.has(key)) return (memory.get(key) ?? null) as T | null;

  const stored = await readValue<T>(key);

  /** Re-checked after the await: two callers can both miss, and the second must not undo the first. */
  if (memory.has(key)) return (memory.get(key) ?? null) as T | null;

  memory.set(key, stored);

  return stored;
}

/** Write one of our stores: memory first, then the disk. */
async function writeOwn(key: string, value: unknown): Promise<void> {
  memory.set(key, value);

  await writeValue(key, value);
}

/** Read the stored months. Never throws: an unreadable store is an empty one. */
export async function readStoredMonths(): Promise<StoredMonths> {
  const stored = await readOwn<StoredMonths>(LEDGER_MONTHS_KEY);

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

  await writeOwn(LEDGER_MONTHS_KEY, { ...all, [month]: entries });
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

  await writeOwn(LEDGER_MONTHS_KEY, { ...all, [month]: [...without, entry] });
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

  /**
   * ⚠️ **The deleted set is published from the same read that filters them out.**
   *
   * The filtering here removes them from *this* list, which is not enough: **the screen merges this list with
   * the query's, and the query still holds the entry the server has not been told about.** Publishing the set
   * is what gives the merge a way to express "this one is gone" — without it, **adding nothing cannot remove
   * anything**, and the entry the user deleted comes straight back. That is what the owner saw:
   * "我尝试去删掉 test04。但是在离线删除时…他都在那儿，好像没什么变化."
   */
  publishDeleted(
    new Set(
      Object.entries(marks)
        .filter(([, mark]) => mark.deleted === true)
        .map(([id]) => id),
    ),
  );
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
 * Stop calling entries pending once the server has confirmed it has them.
 *
 * Written because a stale mark outlived its reason, and the result was a real contradiction on screen. The
 * owner reported entries that disappeared after a refresh and, at the same time, stayed red: gone from the
 * list while still wearing the marker that says "not saved yet".
 *
 * The mark was written when the entry was created and cleared only along the one path that delivers it.
 * Any other path that makes the server's copy authoritative - a refetch, a reinstall, a version whose queue
 * had already drained - left the mark behind for ever. A warning that cannot be cleared is worse than no
 * warning: it teaches the user to ignore the colour, which is the only thing standing between "I recorded
 * it" and "I think I recorded it".
 *
 * Only entries the server has actually returned are cleared, so an entry still waiting to be sent is not
 * silently marked as saved. And `deleted` is left alone: an entry deleted on this device and not yet deleted
 * on the server is still mid-journey, and must stay hidden.
 */
export async function reconcileMarks(serverIds: ReadonlySet<string>): Promise<void> {
  const all = await readMarks();
  const next: LedgerMarks = {};

  let cleared = 0;

  for (const [id, mark] of Object.entries(all)) {
    const confirmed = serverIds.has(id);

    if (mark.pending === true && confirmed && mark.deleted !== true) {
      cleared += 1;
      continue;
    }

    next[id] = mark;
  }

  if (cleared === 0) return;

  await writeOwn(LEDGER_MARKS_KEY, next);
  publishPending(pendingFromMarks(next));

  await logOffline("DIAGNOSTIC:marks-reconciled", `清除 ${String(cleared)} 个已同步的标记`);
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

/**
 * Which entries were deleted on this device — held outside React, like the ledger itself.
 *
 * ⚠️ **Needed because a locally deleted entry comes back through the merge, and the owner hit exactly that**:
 * "我尝试去删掉 test04。但是在离线删除时，不管是离线还是在线，他都在那儿，好像没什么变化."
 *
 * The stored copy is kept on purpose — round 3 needs to show the user what they deleted while asking whether
 * the delete should stand — and `readStoredEntries` filters it out. **But the screen merges the device's
 * entries with the query's, and the query still holds the entry the server has not yet been told about.
 * Adding nothing cannot remove anything**: the merge had no way to express "this one is gone", so the entry
 * it was told to forget came straight back.
 *
 * ⚠️ **A published set rather than a filter buried in the merge**, because this is the same external-store
 * mechanism that has been proved to work on the tablet — see the note on `ledgerSnapshot`.
 */
let deletedSnapshot: ReadonlySet<string> = new Set();
const deletedListeners = new Set<() => void>();

/** Entry ids deleted on this device and not yet deleted on the server. */
export function deletedEntriesValue(): ReadonlySet<string> {
  return deletedSnapshot;
}

/** Subscribe to changes, for `useSyncExternalStore`. */
export function subscribeDeleted(listener: () => void): () => void {
  deletedListeners.add(listener);

  return () => {
    deletedListeners.delete(listener);
  };
}

/** Replace the deleted set and tell React. */
export function publishDeleted(ids: ReadonlySet<string>): void {
  if (ids.size === deletedSnapshot.size && [...ids].every((id) => deletedSnapshot.has(id))) return;

  deletedSnapshot = new Set(ids);

  for (const listener of deletedListeners) listener();
}

/**
 * Publish a new snapshot, and tell React.
 *
 * ⚠️ **Exported because the write path needs it.** A write that changes storage without telling the
 * view is the mistake this project spent four hours on, one layer down — see `refreshView` in `write.ts`.
 */
export function publishLedger(entries: readonly Transaction[]): void {
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
 * Forget a read that is still in progress.
 *
 * ⚠️ **Called after a write, so the write is not answered by a read that began before it.**
 * The join exists to stop four screens reading the same blob at once; it must not serve a stale answer to
 * the code that just changed the data.
 */
export function clearInFlight(): void {
  inFlight = null;
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
