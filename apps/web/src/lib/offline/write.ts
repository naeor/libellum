import type { CreateTransactionInput, Transaction, UpdateTransactionInput } from "@libellum/shared";
import type { OutboxOp } from "./outbox.js";

import { ApiRequestError, apiFetch } from "../api.js";
import { isAccountOffline } from "./connectivity.js";
import { logOffline } from "./diagnostics.js";
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
import { queueChange, readOutbox, recordFailure, resolveChange, writeOutbox } from "./outbox.js";

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
 * Where the *store* layer asks for the pending set to be published.
 *
 * ⚠️ **Injected for the same reason as the query notifier**: `localLedger.ts` owns the published set, and this
 * module owns the queue that decides it. **Pointing one at the other is what keeps the colour from becoming a
 * second copy of the truth** \u2014 which is the whole failure this change is repairing.
 */
let publishPendingFromQueue: ((ids: ReadonlySet<string>) => void) | null = null;

/** Called once, by the store module. */
export function installPendingPublisher(publish: (ids: ReadonlySet<string>) => void): void {
  publishPendingFromQueue = publish;
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
  await repairMissingQueueRows();

  const ids = await pendingIds();

  if (publishPendingFromQueue !== null) publishPendingFromQueue(ids);
  else publishPending(ids);
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
  await setMark(entry.id, { pending: true });
  await afterWrite();

  await queueChange({
    id: entry.id,
    op: "create",
    payload: input,
    baseVersion: null,
  });

  if (isAccountOffline()) {
    await logOffline("DIAGNOSTIC:write-local", `新建 ${entry.id.slice(0, 8)}（离线）`);

    return { entry, pending: true };
  }

  const synced = await tryNow(entry.id);

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
  await setMark(id, { pending: true });
  await afterWrite();
  await queueChange({ id, op: "update", payload: input, baseVersion: current.version });

  if (isAccountOffline()) {
    await logOffline("DIAGNOSTIC:write-local", `修改 ${id.slice(0, 8)}（离线）`);

    return { entry: next, pending: true };
  }

  const synced = await tryNow(id);

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
  await queueChange({ id, op: "delete", baseVersion: current?.version ?? null });

  await setMark(id, { pending: true, deleted: true });
  await afterWrite();

  if (isAccountOffline()) {
    await logOffline("DIAGNOSTIC:write-local", `删除 ${id.slice(0, 8)}（离线）`);

    return;
  }

  if (await tryNow(id)) await afterWrite();
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

/**
 * Try to deliver one change right now.
 *
 * ⚠️ **Called after every local write, so a device with a connection never accumulates a queue.** The
 * queue exists for the times the server is unreachable; on a working connection it should stay empty, and
 * the user should never see a pending marker for something that is already saved.
 *
 * @returns whether the change reached the server.
 */
export async function tryNow(id: string): Promise<boolean> {
  return syncOne(id);
}

/**
 * Deliver one entry's change.
 *
 * ⚠️ **4xx and 5xx are handled differently, and that distinction is load-bearing.**
 *
 * | Response | Meaning | What happens |
 * |---|---|---|
 * | 2xx | delivered | the queue row goes, the pending mark goes |
 * | **409** | somebody else changed it | **the change is kept with its conflict information** — round 3 shows it |
 * | **4xx** | this will never work | **marked as needing attention, not retried** |
 * | 5xx / network | try later | stays queued |
 *
 * **Treating a 4xx as retryable is how a queue dies**: one entry the server will never accept sits at the
 * head, is retried for ever, and every change behind it waits. **The queue only moves forward if a
 * permanent failure is recognised as permanent.**
 */
async function syncOne(id: string): Promise<boolean> {
  const rows = await readOutbox();
  const row = rows.find((candidate) => candidate.id === id);

  if (row === undefined) return true;

  try {
    if (row.op === "create") {
      await apiFetch<Transaction>("/transactions", { method: "POST", body: row.payload });
    } else if (row.op === "update") {
      await apiFetch<Transaction>(`/transactions/${id}`, { method: "PATCH", body: row.payload });
    } else {
      await apiFetch<unknown>(`/transactions/${id}`, { method: "DELETE" });
    }

    await resolveChange(id);
    await setMark(id, row.op === "delete" ? { deleted: true } : null);

    await logOffline("DIAGNOSTIC:write-synced", `${row.op} ${id.slice(0, 8)}`);

    return true;
  } catch (error) {
    const status = error instanceof ApiRequestError ? error.status : 0;

    /**
     * ⚠️ **Every failure is recorded with its status, because "it did not work" is not a diagnosis.**
     *
     * The owner's complaint was two rows that stayed red through an offline/online cycle and a manual refresh:
     * "红色的部分没有被删除." **A 404, a 409, a 401 and a dropped connection all produce that same red row**, and
     * each needs a different fix. Without the status in the log there is no way to tell them apart from the
     * device — and the device is the only place the failure can be observed.
     */
    await logOffline(
      "DIAGNOSTIC:write-failed",
      `${row.op} ${id.slice(0, 8)} — ${status === 0 ? "无响应" : String(status)} ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    /**
     * ⚠️ **A conflict is not a failure — it is information the user has to be given.**
     *
     * The server says this entry changed since the device last saw it. Round 2 keeps both sides and
     * reports it; round 3 asks the user which one wins, and **the server's version is only available at
     * this moment** — asking again later would show a third version that neither side ever saw.
     */
    if (status === 409) {
      await recordFailure(id, "这笔记账在服务器上已被修改");

      return false;
    }

    /**
     * ⚠️ **A 404 on a delete means the entry is already gone, which is the outcome that was asked for.**
     *
     * The server answers `404 transaction_missing` when it cannot find the entry with `deletedAt: null`, which
     * covers "already deleted" — **including deleted from another device**. Treating that as a failure leaves a
     * row that can never succeed: every retry gets the same 404, **the entry is already invisible everywhere,
     * and the only thing left on screen is a red row accusing the user of an unfinished deletion they did
     * finish.**
     *
     * **The user wanted the entry not to exist. It does not exist. That is success**, and the row and the mark
     * are cleared on the same path as any other delivered change.
     *
     * ⚠️ **The same status on a create or an update is a real failure** and falls through to the permanent
     * branch below: a create that 404s means the endpoint is wrong, and an update that 404s means the entry
     * vanished underneath an edit the user is still making.
     */
    if (status === 404 && row.op === "delete") {
      await resolveChange(id);
      await setMark(id, { deleted: true });

      await logOffline("DIAGNOSTIC:write-already-gone", `删除 ${id.slice(0, 8)} — 服务器上已经没有它`);

      return true;
    }

    /** A 4xx other than 409 will never succeed, so it must not sit at the head of the queue. */
    if (status >= 400 && status < 500) {
      /**
       * ⚠️ **Recorded as permanent, which is what stops it from being retried for ever** — and from being
       * dropped after five attempts as though the network were the problem.
       */
      await recordFailure(id, error instanceof Error ? error.message : String(error), {
        permanent: true,
      });


      return false;
    }

    await recordFailure(id, error instanceof Error ? error.message : String(error));

    return false;
  }
}

/**
 * Deliver everything queued, oldest first.
 *
 * ⚠️ **One at a time, and oldest first.** Concurrency would make the order unpredictable, and the thing
 * the user can perceive is *whether the oldest change has gone up*. A batch that partially succeeds out
 * of order is harder to explain than one that is simply slow.
 *
 * @returns how many changes reached the server.
 */
export async function drainOutbox(): Promise<number> {
  /**
   * ⚠️ **The browser's opinion is logged before it is acted on, and this is the line that settles the
   * question the owner asked**: "我能看到 test05 和一个服务都被标红了…理论上我已经触发了，为什么他们没有被
   * 删掉呢？"
   *
   * **Two causes look identical on screen**: nothing ran, or it ran and the server refused. The old code
   * returned `0` silently in the first case, so the diagnostics showed *no* sync lines at all — which reads
   * the same as "the sync is fine and there was nothing to do".
   */
  const offline = isAccountOffline();

  await logOffline(
    "DIAGNOSTIC:drain",
    offline
      ? "浏览器认为当前离线，不投递"
      : `在线判定通过，队列 ${String((await readOutbox()).length)} 条`,
  );

  if (offline) return 0;

  const rows = await readOutbox();
  const ordered = [...rows].sort((left, right) => left.queuedAt - right.queuedAt);

  let delivered = 0;

  for (const row of ordered) {
    /**
     * ⚠️ **A change the server has refused outright is never retried, and never blocks the ones behind it.**
     *
     * `permanent` is set by `syncOne` when it sees a 4xx that is not a conflict. **Without this flag the queue
     * had no way to tell "try again later" from "this will never work"**, and the two were handled by the same
     * rule — attempts — which meant either retrying for ever or **dropping a change that only needed the
     * network to come back.** The owner's queue is exactly the situation where that shows: entries recorded on
     * a plane and delivered days later.
     */
    if (row.permanent === true) {
      /**
       * ⚠️ **Why it is being skipped is recorded.** A row that is quietly skipped for ever is indistinguishable
       * from a row that was never queued, and **the whole complaint is a colour that will not clear.**
       */
      await logOffline(
        "DIAGNOSTIC:drain-skip",
        `${row.op} ${row.id.slice(0, 8)} — 服务器已拒绝：${row.lastError ?? "未知"}`,
      );

      continue;
    }

    /**
     * A transient failure is retried, but not for ever: five failed attempts is not going to succeed on the
     * sixth without something changing.
     */
    if (row.attempts >= MAX_ATTEMPTS) {
      await logOffline(
        "DIAGNOSTIC:drain-skip",
        `${row.op} ${row.id.slice(0, 8)} — 已失败 ${String(row.attempts)} 次：${row.lastError ?? "未知"}`,
      );

      continue;
    }

    if (await syncOne(row.id)) delivered += 1;
  }

  if (delivered > 0) {
    await logOffline("DIAGNOSTIC:outbox-drained", `投递 ${String(delivered)} 条`);
  }

  return delivered;
}

/**
 * How many times a *transient* failure is retried before the change is left for the user.
 *
 * ⚠️ **A bounded number, because an unbounded one is a battery drain** — and because a change that has failed
 * five times is not going to succeed on the sixth without something changing. It stays in the queue with its
 * error, visible in the diagnostics screen, and **the user is told rather than the program quietly retrying
 * for ever.**
 *
 * ⚠️ **It does not apply to a permanent failure**, which is not retried at all — see `drainOutbox`.
 */
const MAX_ATTEMPTS = 5;

/** Whether anything is waiting. Cheap enough for a banner. */
export async function hasPendingWrites(): Promise<boolean> {
  return (await readOutbox()).length > 0;
}

/**
 * Put a queued change back for anything that is marked but not queued.
 *
 * ⚠️ **Written because the owner's device was already in that state, and a fix for new deletions alone would
 * not have released it.**
 *
 * His diagnostics showed the contradiction plainly:
 *
 * ```
 * read ledger-marks — 对象，键：01a128d9-…, 01a128cf-…
 * DIAGNOSTIC:drain — 在线判定通过，队列 0 条
 * ```
 *
 * Two entries marked as deleted, and an empty queue — so the drain had nothing to send, and the rows stayed
 * pale red for ever. He confirmed it from the other side by signing in on his phone: **the entries were still
 * on the server, so the delete had never left the device.**
 *
 * ⚠️ **A mark is a claim and the queue is the work. When they disagree, the work is what is missing** — and
 * the repair is to rebuild the claim's work rather than to drop the claim. **Dropping the mark would silently
 * undelete something the user asked to delete**, which is the one outcome worse than a colour that will not
 * clear.
 *
 * ⚠️ **It runs on every `refreshPending`**, which is called after every read and every write — so this is not
 * a one-off migration that has to be got right once. **It is the invariant being enforced continuously**:
 * anything marked pending has a queued change, or it gets one.
 */
async function repairMissingQueueRows(): Promise<number> {
  const marks = await readMarks();
  const rows = await readOutbox();
  const queued = new Set(rows.map((row) => row.id));

  const missing = Object.entries(marks).filter(([id, mark]) => {
    const pending = mark.pending === true || mark.deleted === true;

    return pending && !queued.has(id);
  });

  if (missing.length === 0) return 0;

  /**
   * ⚠️ **A deletion is repaired as a deletion, and anything else as an update.**
   *
   * A deletion is the only one that can be reconstructed without a payload — `DELETE /transactions/:id` needs
   * nothing else. **An entry marked pending but not deleted has no payload to rebuild**, so it is queued as an
   * update with no body: the server will reject it, the row is recorded as a permanent failure, and **the user
   * is told rather than the program inventing a body it does not have.** In practice this only happens for an
   * entry created offline whose create row was somehow lost, which the create path cannot produce.
   */
  const next = [
    ...rows,
    ...missing.map(([id, mark]) => ({
      id,
      op: (mark.deleted === true ? "delete" : "update") as OutboxOp,
      baseVersion: null,
      queuedAt: Date.now(),
      attempts: 0,
    })),
  ];

  await writeOutbox(next);

  await logOffline(
    "DIAGNOSTIC:queue-repaired",
    `补回 ${String(missing.length)} 条只标记未入队的改动`,
  );

  return missing.length;
}

/**
 * Which entries have not reached the server — read from the queue, which is the only thing that knows.
 *
 * ⚠️ **The owner's proposal, with one change of storage, and his reasoning is why**: "给每笔记账新增一个变量。
 * 例如'是否被同步'…如果这个变量为 0，意味着它还没被同步到服务器端，也就显示背景为淡红色."
 *
 * He is right that the state belongs with the entry. **What he is really fixing is that the colour was
 * decided by two things that could disagree** — the entry list and a separate map of marks — and every bug in
 * this area has been an attempt to keep them in step. **Two facts about one thing will eventually differ; one
 * fact cannot.**
 *
 * So the flag is not stored twice. **The queue *is* the "not yet sent" state**, and it cannot be stale about
 * itself: an entry is unsynced exactly while the queue holds a row for it, and stops being unsynced the
 * moment the row goes — **whatever route delivered it, and with nothing having to remember to clear a mark.**
 *
 * ⚠️ **A delete is not "unsynced" for colouring.** The entry is gone from the screen, so colouring it would
 * colour nothing; its queue row exists to tell the server, not to warn the user.
 */
export async function pendingIds(): Promise<ReadonlySet<string>> {
  const rows = await readOutbox();

  return new Set(rows.filter((row) => row.op !== "delete").map((row) => row.id));
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
