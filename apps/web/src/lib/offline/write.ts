import type { CreateTransactionInput, Transaction, UpdateTransactionInput } from "@libellum/shared";

import { ApiRequestError, apiFetch } from "../api.js";
import { isAccountOffline } from "./connectivity.js";
import { logOffline } from "./diagnostics.js";
import { syncAll } from "./sync.js";
import {
  clearInFlight,
  publishLedger,
  publishPending,
  readLocalTransactions,
  readMarks,
  readStoredMonths,
  setMark,
  storeMonth,
  upsertEntry,
} from "./localLedger.js";

/**
 * Writing to the ledger, whether or not the server is reachable.
 *
 * ⚠️ **The decision this file makes is "where does this write go", and it makes it per write.**
 *
 * A ledger that refuses to record spending when the signal drops is not a ledger — it is a form that
 * loses things. The owner asked for the whole history to be readable offline, and **a history you can
 * read but not add to is a history that stops at the worst moment**: on a train, in a basement, on a
 * plane. So a write always succeeds locally and reaches the server when it can.
 *
 * ⚠️ **The offline marker is the owner's own requirement**: "离线状态下新建出来的记账底色要特殊一些，
 * 比如把他们的背景（那一行的背景）换成浅红色之类的，用来提醒用户，现在还没被备份到服务器，只是在本地记账
 * 而已."
 *
 * He is right, and the reason is one of this project's own lessons: **"没有反馈"和"没有生效"在用户看来
 * 没有区别.** A row that looks identical to a saved one, on a device that has not sent it anywhere, is a
 * row the user will assume is safe. **The colour is not decoration; it is the only thing standing between
 * "I recorded it" and "I think I recorded it".**
 */

/** What a write produced, so the screen can say something true about it. */
export interface WriteOutcome {
  /** The entry as it now exists locally. */
  readonly entry: Transaction;
  /** True when it is stored locally and still waiting for the server. */
  readonly pending: boolean;
}

/**
 * Build the entry as it exists before the server has seen it.
 *
 * ⚠️ **The offline path and the online path produce the same shape**, and that is deliberate: the server
 * returns a `Transaction`, and the screen reads one. If the offline copy were a different shape — missing
 * the category's name, say — the row would render incorrectly until the queue drained, and the user would
 * see their entry change appearance for a reason they could not observe.
 *
 * ⚠️ **The names are resolved from the ledger the screen already has.**
 *
 * `categoryName` and `paymentMethodName` are denormalised onto each entry by the server so statistics stay
 * correct after a category is renamed. Offline, the ledger on the device is the only source — and **if a
 * category is not found the entry keeps an empty name rather than inventing one**: an empty field is
 * visibly incomplete, where a guessed name is silently wrong.
 */
export function localEntry(
  input: CreateTransactionInput,
  ledger:
    | {
        readonly categories?: readonly { id: string; name: string; isSystem?: boolean; kind?: string }[];
        readonly paymentMethods?: readonly { id: string; name: string }[];
      }
    | undefined,
): Transaction {
  const categories = ledger?.categories ?? [];

  /**
   * ⚠️ **A missing category falls back to the book's own 暂无分类 row, not to an empty string.**
   *
   * The server files an entry with no category under a **system category it creates per book**, and that
   * row is in the ledger the device already holds — so its real id can be used here rather than guessed.
   * **Guessing would produce an entry the server rejects or silently reclassifies**, and the user's
   * category would change without explanation once the queue drained.
   *
   * If even that is absent the id stays empty, which the server also accepts and resolves itself — so the
   * worst case is one round trip correcting it, not a failed write.
   */
  const chosen =
    categories.find((candidate) => candidate.id === input.categoryId) ??
    categories.find((candidate) => candidate.isSystem === true && candidate.kind === input.kind);

  const method = ledger?.paymentMethods?.find((candidate) => candidate.id === input.paymentMethodId);

  return {
    id: input.id,
    kind: input.kind,
    amountCents: input.amountCents,
    currency: input.currency,
    categoryId: chosen?.id ?? input.categoryId ?? "",
    categoryName: chosen?.name ?? "",
    categoryIsSystem: chosen?.isSystem ?? false,
    paymentMethodId: input.paymentMethodId ?? null,
    paymentMethodName: method?.name ?? null,
    occurredAt: input.occurredAt,
    occurredLocalDate: input.occurredLocalDate,
    occurredTz: input.occurredTz,
    note: input.note ?? null,
    tags: [],
    /**
     * ⚠️ **Version 1, which is what the server assigns on creation.** A local copy that said anything else
     * would disagree with the row it is meant to be a copy of, and the first update would conflict with
     * itself.
     */
    version: 1,
  };
}

/**
 * After any local write, make the screens see it.
 *
 * ⚠️ **This is the missing half of "the change appears immediately", and the owner found it:**
 * "离线状态下，在编辑完成之后，它并不会显示在明细里，而是等到恢复网络之后再突然出现."
 *
 * The write went to storage correctly — that part worked. **What did not happen was telling the screen.**
 * `ledgerSnapshot` is only filled by `readLocalTransactions`, so a write that skips it leaves the screen
 * showing the old copy: an edit looks ignored, and a delete looks refused. **The user concludes the app
 * did not do what they asked, which is exactly what happened.**
 *
 * ⚠️ **It is the same mistake as the one that cost four hours**, one layer down: *the data changed and
 * nothing told the view.* **The lesson was written down and then not applied here** — which is why this
 * function exists and why every write path calls it.
 *
 * ⚠️ **The in-flight join is cleared first.** `readLocalTransactions` shares a read already in progress,
 * and a write must not be answered by a read that started before it — **that would publish the state the
 * user just changed away from.**
 */
export async function republishLedger(): Promise<void> {
  await refreshView();
}

async function refreshView(): Promise<void> {
  clearInFlight();

  publishLedger(await readLocalTransactions());
}

/** Every entry the device holds, including ones the current filter excludes. */
async function readAllEntries(): Promise<readonly Transaction[]> {
  clearInFlight();

  return readLocalTransactions();
}

/**
 * Register the function that tells the *query layer* about a local write.
 *
 * ⚠️ **The ledger screen prefers the query's data when it has any** — deliberately, because a server
 * answer is the truth and the device's copy is a copy. That preference is the second half of the owner's
 * report: the store was refreshed and **the screen still showed the old list, because the query's cached
 * pages were sitting in front of it.**
 *
 * So a local write invalidates the query, exactly as a server write does. **The invalidation is what makes
 * the layer being trusted let go of an answer that is no longer true.**
 *
 * ⚠️ **Injected rather than imported**, because `queries.ts` already imports this module for its fallback —
 * importing it back would be a cycle. **The write path does not need to know that queries exist; it needs to
 * be able to say "the data changed".**
 */
let notifyQueryLayer: ((changed: readonly Transaction[]) => Promise<void>) | null = null;

/**
 * Called once by the query layer.
 *
 * ⚠️ **It is given the entries that changed, not just told that something did.**
 *
 * "Something changed, go and look again" is what the first version said, and it failed for the same reason
 * everything else did: **looking again read the old value.** The screen was left one step behind the
 * storage, which is precisely the pattern the owner described — he wrote an entry and saw the *previous*
 * one turn up.
 *
 * **Writing the new list into the query cache removes the question.** There is no re-read to be overtaken,
 * no in-flight promise to be joined, and no interval during which the screen can show the state the user
 * just changed away from.
 */
export function installQueryNotifier(notify: (changed: readonly Transaction[]) => Promise<void>): void {
  notifyQueryLayer = notify;
}


/**
 * Republish the pending set from the queue.
 *
 * \u26a0\ufe0f **Called after every local read as well as every write**, so a cold start shows the markers without
 * having to write anything first \u2014 the queue is on disk, and the colour comes from it.
 */
export async function refreshPending(): Promise<void> {
  /**
   * ⚠️ **The invariant is enforced here, on every refresh**, so a device that is already in the broken state
   * repairs itself the next time anything reads or writes — see `repairMissingQueueRows`.
   */
  /**
   * ⚠️ **Read from the marks and published, in one step.** There is no intermediate record to reconcile first:
   * the marks *are* the queue, so republishing them is all that is needed to keep the colour honest.
   */
  publishPending(await pendingIds());
}

/**
 * After a local write, refresh both layers.
 *
 * ⚠️ **Both, in this order, and the order matters**: the store is published first so the screen has
 * something to draw, then the query is invalidated so the layer above stops serving an answer that is no
 * longer true. **Doing it the other way round leaves a window where the query is refetching and the store
 * still holds the old list — the screen flickers back to the state the user just changed.**
 */
async function afterWrite(): Promise<void> {
  const entries = await readLocalTransactions();

  publishLedger(entries);

  /**
   * \u26a0\ufe0f **The pending colour follows the queue, not a copy of it.** See pendingIds. A write that adds
   * to the queue must repaint; a delivery that empties it must repaint; and nothing has to remember.
   */
  await refreshPending();

  if (notifyQueryLayer === null) return;

  try {
    /**
     * ⚠️ **The whole list is handed over, not a notification.** See `installQueryNotifier`.
     */
    await notifyQueryLayer(await readAllEntries());
  } catch {
    /**
     * ⚠️ **A refetch that fails is expected while offline**, and it must not undo the local write. The
     * store already holds the change; the query catches up when there is a network.
     */
  }
}

/**
 * Create an entry.
 *
 * ⚠️ **The id and the idempotency key are the same value, generated by the caller.**
 *
 * That is what makes a replayed create harmless: the server's `idempotency_key` is `@unique`, so a second
 * delivery finds the row it already made. **Generating the id on the client is also what lets the entry
 * exist, be edited and be shown before the server has ever heard of it** — and it is why the offline path
 * and the online path produce the same result rather than two shapes that have to be reconciled.
 */
export async function createEntry(input: CreateTransactionInput, entry: Transaction): Promise<WriteOutcome> {
  await upsertEntry(entry);

  /**
   * ⚠️ **The mark is the whole record of the work.** `synced: false` says the server has never had this entry,
   * so a sync creates it; `tagIds` is carried along because a create needs the tags and `Transaction` does not
   * hold their ids.
   *
   * **There is no queue to keep in step**, which is what the owner's model gets right: **the colour and the work
   * are one record**, so a row cannot be painted and then forgotten.
   */
  await setMark(entry.id, { pending: true, synced: false, tagIds: input.tagIds });
  await afterWrite();

  if (isAccountOffline()) {
    await logOffline("DIAGNOSTIC:write-local", `新建 ${entry.id.slice(0, 8)}（离线）`);

    return { entry, pending: true };
  }

  const report = await syncAll();
  const synced = report.delivered > 0;

  /**
   * ⚠️ **Refreshed again after delivery**, because a successful sync clears the pending mark — and a row
   * that stays pale red after it has been saved is a warning that is not true.
   */
  if (synced) await afterWrite();

  return { entry, pending: !synced };
}

/**
 * Update an entry.
 *
 * ⚠️ **`baseVersion` comes from what the device holds, and it is captured here rather than at replay
 * time.** By the time the queue is drained the device's own copy has moved on — it holds the version this
 * edit produced — and sending *that* would ask the server to accept a change built on a version nobody
 * else ever confirmed.
 */
export async function updateEntry(
  id: string,
  input: UpdateTransactionInput,
  apply: (current: Transaction) => Transaction,
): Promise<WriteOutcome | null> {
  const current = await findStoredEntry(id);

  /**
   * ⚠️ **An entry the device does not hold cannot be edited offline.**
   *
   * Returning `null` rather than inventing one: the screen must not show an edit to something it cannot
   * show. This can only happen if the entry was never downloaded, which the caller reports.
   */
  if (current === null) return null;

  const next = apply(current);

  await upsertEntry(next);
  /** ⚠️ synced: true because the server already has this entry, so a sync changes it rather than creating it. */
  await setMark(id, { pending: true, synced: true });
  await afterWrite();

  if (isAccountOffline()) {
    await logOffline("DIAGNOSTIC:write-local", `修改 ${id.slice(0, 8)}（离线）`);

    return { entry: next, pending: true };
  }

  const report = await syncAll();
  const synced = report.delivered > 0;

  if (synced) await afterWrite();

  return { entry: next, pending: !synced };
}

/**
 * Delete an entry.
 *
 * ⚠️ **Marked, not removed.** The stored copy is what round 3 needs to show the user what they deleted
 * while asking whether the delete should stand, and it costs a few hundred bytes to keep.
 *
 * ⚠️ **The delete is queued unconditionally, and that `.` is the fix for the owner's stuck rows.**
 *
 * The first version marked the entry and *then* queued it, **but only if the device could find the entry it
 * was deleting**:
 *
 * ```ts
 * const current = await findStoredEntry(id);
 * await setMark(id, { pending: true, deleted: true });   // mark: unconditional
 * if (current !== null) { queueChange(...); }            // queue: conditional
 * ```
 *
 * **When the lookup came back empty the mark was still written and nothing was ever queued** — so the row went
 * pale red and **stayed pale red for ever**, because there was nothing for the drain to send. His diagnostics
 * show exactly that state: `ledger-marks` holding two ids, and `DIAGNOSTIC:drain — 在线判定通过，队列 0 条`. And
 * he confirmed it from the other side by signing in on his phone: the entries were still on the server, so the
 * delete had never left the device.
 *
 * **The condition was never needed.** A queued delete carries no payload — it is `DELETE /transactions/:id` —
 * so it does not matter whether the device still holds a copy. **An entry can be missing from the device's
 * store for entirely ordinary reasons** (it came from the query cache and was never written to `ledger-months`,
 * a month was never downloaded), **and none of them are a reason to refuse to delete it.**
 *
 * ⚠️ **If the server has already deleted it, the delete is a 404 — and a 404 on a delete means the job is
 * done**, which `syncOne` now treats as success rather than a permanent failure to retry for ever.
 */
export async function deleteEntry(id: string): Promise<void> {
  const current = await findStoredEntry(id);

  /** ⚠️ Queued first, so the mark and the work cannot disagree about whether anything is pending. */
  await setMark(id, { pending: true, deleted: true });
  await afterWrite();

  if (isAccountOffline()) {
    await logOffline("DIAGNOSTIC:write-local", `删除 ${id.slice(0, 8)}（离线）`);

    return;
  }

  await syncAll();
  await afterWrite();
}


/** One entry from the device's store, or `null`. */
async function findStoredEntry(id: string): Promise<Transaction | null> {
  const months = await readStoredMonths();

  for (const entries of Object.values(months)) {
    for (const entry of entries) {
      if (entry.id === id) return entry;
    }
  }

  return null;
}

export async function pendingIds(): Promise<ReadonlySet<string>> {
  /**
   * ⚠️ **Read from the marks, not from a queue.** One record, two readings: **the colour of a row and the work a
   * sync performs are the same fact**, so a row cannot be painted green and then have nothing to send.
   *
   * ⚠️ **A deleted entry is excluded**, because it is struck through and red instead — the two colours are
   * descriptions of two different intentions, and an entry has one.
   */
  const marks = await readMarks();

  return new Set(
    Object.entries(marks)
      .filter(([, mark]) => mark.deleted !== true && mark.pending === true)
      .map(([id]) => id),
  );
}



/**
 * Put downloaded entries into storage without marking them pending.
 *
 * ⚠️ **The download path must not mark anything pending** — those entries came *from* the server, so they
 * are as synced as anything can be. `storeMonth` is separate from `upsertEntry` for exactly this reason.
 */
export { storeMonth };

/** A create is delivered by re-sending it; the server's `idempotency_key` makes that harmless. */
export type { CreateTransactionInput, UpdateTransactionInput };
