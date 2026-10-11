import type { CreateTransactionInput, Transaction } from "@libellum/shared";

import { ApiRequestError, apiFetch } from "../api.js";
import { readMarks, readStoredMonths, readStoredEntries, setMark, type EntryMark } from "./localLedger.js";
import { logOffline } from "./diagnostics.js";
import { republishLedger } from "./write.js";

/**
 * Delivering the device's intentions to the server.
 *
 * ⚠️ **This replaces a persisted queue, and the owner's objection to that queue is why.**
 *
 * His model: **"它是红色的，也就证明它的删除印记变量为一…每次刷新时会触发一次联网核对，而联网核对应该从上到
 * 下遍历所有订单，把所有绿色的订单加入到服务器中，同时删在服务器和本地上删掉所有的红色订单."**
 *
 * Mine had a second store — a queue of pending changes, keyed by entry id — and **that store is what kept going
 * wrong**: it could be lost, never written, or emptied while the marks said something else. His iPad ended up
 * with `队列 0 条` and rows that stayed red for ever, and **the two facts were not even contradictory in my
 * design** — they were two independent records that had drifted.
 *
 * ⚠️ **In his model they cannot drift, because there is only one record.** A mark says what the device intends;
 * walking the entries and acting on the marks *is* the queue. **There is nothing to persist, nothing to
 * repair, and no second copy to disagree with the first.**
 *
 * ⚠️ **The work list is derived on every run, not stored.** A queue that is rebuilt from the marks cannot be
 * missing an entry the marks mention — which is exactly the failure that produced the stuck rows.
 *
 * ⚠️ **Only the retry bookkeeping lives in memory**, and losing it on reload is the correct behaviour: it is a
 * record of failures observed in this session, not user data.
 */

/** One piece of intended work, derived from an entry's mark. */
interface Intent {
  readonly entry: Transaction;
  readonly op: "create" | "update" | "delete";
  readonly mark: EntryMark;
}

/**
 * Failure bookkeeping, in memory only.
 *
 * ⚠️ **Not persisted, deliberately.** A stored error outlives the situation that caused it — **"permanent"
 * was a judgement about one response at one moment**, and a persisted version of it can leave a row rejected
 * for ever. In memory it simply expires, and the next session tries again.
 */
const failures = new Map<string, { attempts: number; message: string; permanent: boolean }>();

/** How many times one change is retried in a session before the user is told. */
const MAX_ATTEMPTS = 5;

/**
 * Turn the device's marks into the list of things to do, in the order the user sees them.
 *
 * ⚠️ **Every entry with a mark produces exactly one intent**, so a red row always has work behind it and a
 * green row always has work behind it. **That equivalence is the whole point** — the colour and the work are
 * two readings of one record rather than two records that can disagree.
 *
 * ⚠️ **A locally deleted entry is still in storage**, which is what makes this possible: `readStoredMonths`
 * returns it even though `readStoredEntries` filters it out of the screens.
 */
async function intents(): Promise<readonly Intent[]> {
  const marks = await readMarks();
  const months = await readStoredMonths();

  const byId = new Map<string, Transaction>();

  for (const entries of Object.values(months)) {
    for (const entry of entries) byId.set(entry.id, entry);
  }

  const found: Intent[] = [];

  for (const [id, mark] of Object.entries(marks)) {
    const entry = byId.get(id);

    /** ⚠️ A mark with no entry behind it has nothing to send — it is dropped when read, not before. */
    if (entry === undefined) continue;

    if (mark.deleted === true) {
      found.push({ entry, op: "delete", mark });
      continue;
    }

    if (mark.pending === true) {
      /**
       * ⚠️ **`synced` is the discriminator between "not yet created there" and "changed since they last saw it".**
       * Without it a new entry would be sent as a `PATCH` and 404, and an edit would be sent as a `POST` and
       * create a duplicate.
       */
      found.push({ entry, op: mark.synced === false ? "create" : "update", mark });
    }
  }

  /**
   * ⚠️ **Sorted by the entry's own instant, oldest first** — the same clock the ledger is displayed by, so the
   * work is done in the order the user would read it. **A create is sent before the edits that depend on it**
   * because it is older, which is the ordering that matters here.
   */
  return found.sort((left, right) => {
    const leftAt = Date.parse(left.entry.occurredAt);
    const rightAt = Date.parse(right.entry.occurredAt);

    if (Number.isNaN(leftAt) || Number.isNaN(rightAt)) return 0;

    return leftAt - rightAt;
  });
}

/** What a sync run did, so a caller can say something true about it. */
export interface SyncReport {
  readonly delivered: number;
  readonly waiting: number;
  /** Rows the server refused outright; they stay visible and are not retried this session. */
  readonly refused: number;
}

/**
 * Walk the entries and bring the server into line with them.
 *
 * ⚠️ **This is the "联网核对" the owner described, and it is a walk over the entries — not over a queue.**
 * Every marked entry is examined, in order, every time this runs. **An entry cannot be skipped because some
 * separate record forgot about it**, which is what happened to his two rows.
 */
export async function syncAll(): Promise<SyncReport> {
  const work = await intents();

  let delivered = 0;
  let refused = 0;

  await logOffline("DIAGNOSTIC:sync", `核对 ${String(work.length)} 条待处理`);

  for (const intent of work) {
    const failure = failures.get(intent.entry.id);

    /**
     * ⚠️ **A refusal is respected for the rest of the session, and re-tried in the next one.** Retrying a
     * request the server has rejected outright would hammer it, and **persisting the refusal would condemn the
     * row for ever** — the middle path is what the owner's experience asks for: **it stops now, and it starts
     * again next time.**
     */
    if (failure?.permanent === true) {
      refused += 1;
      continue;
    }

    if (failure !== undefined && failure.attempts >= MAX_ATTEMPTS) {
      refused += 1;
      continue;
    }

    if (await deliver(intent)) delivered += 1;
    else if (failures.get(intent.entry.id)?.permanent === true) refused += 1;
  }

  const waiting = (await intents()).length;

  if (delivered > 0) await logOffline("DIAGNOSTIC:sync-done", `投递 ${String(delivered)} 条`);

  if (waiting > 0) {
    await logOffline("DIAGNOSTIC:sync-waiting", `仍有 ${String(waiting)} 条未投递`);
  }

  return { delivered, waiting, refused };
}

/**
 * Send one intention, and clear its mark if it lands.
 *
 * ⚠️ **Clearing the mark is what removes the colour, and it happens in the same step as the delivery** — so
 * there is no moment where the server has the change and the screen still claims it does not.
 */
async function deliver(intent: Intent): Promise<boolean> {
  const { entry, op } = intent;
  const short = entry.id.slice(0, 8);

  try {
    if (op === "create") {
      await apiFetch<Transaction>("/transactions", {
        method: "POST",
        body: createBody(entry, intent.mark),
      });
    } else if (op === "update") {
      await apiFetch<Transaction>(`/transactions/${entry.id}`, {
        method: "PATCH",
        body: updateBody(entry),
      });
    } else {
      await apiFetch<unknown>(`/transactions/${entry.id}`, { method: "DELETE" });
    }

    /**
     * ⚠️ **The mark is cleared, and for a deletion that means the entry stops being rendered at all.**
     *
     * A delivered deletion leaves `deleted: true` out of the mark entirely, so the entry is filtered from the
     * screens — **"removed from the server and from here", which is what the owner asked for in as many words.**
     */
    await setMark(entry.id, null);
    failures.delete(entry.id);

    await logOffline("DIAGNOSTIC:sync-ok", `${op} ${short}`);

    return true;
  } catch (error) {
    const status = error instanceof ApiRequestError ? error.status : 0;

    /**
     * ⚠️ **A 404 on a delete is NOT success, and treating it as success is what made the owner's rows
     * undeletable.** His diagnostics show the whole sequence:
     *
     * ```
     * write-failed — delete 01a128c9 — 404 找不到这笔记账。
     * write-already-gone — 删除 01a128c9 — 服务器上已经没有它
     * sync-ok — delete 01a128c9（服务器上本就没有）        <- the mark was cleared
     * ```
     *
     * The mark was cleared, the colour went, **and the entry was still there** — which is exactly what he
     * reported: "我刷新的时候，他会直接把删除印记给去掉，东西是实际上并没删除."
     *
     * ⚠️ **The server answers 404 in two situations that must not be conflated**: the row has already been
     * soft-deleted, **or this id does not exist in this book at all.** The second happens for an entry that was
     * never uploaded — **and clearing the mark then means the program forgets the deletion while the entry is
     * still in front of the user.**
     *
     * **So a delete is succeeded by the server's own list, and by nothing else** — see `recordServerList`,
     * which clears a deletion precisely when the month's list comes back without that entry. **One authority
     * for "is it gone", and it is the server's list rather than an inference from an error code.**
     */

    const message = error instanceof Error ? error.message : String(error);

    await logOffline(
      "DIAGNOSTIC:sync-failed",
      `${op} ${short} — ${status === 0 ? "无响应" : String(status)} ${message}`,
    );

    const previous = failures.get(entry.id);

    failures.set(entry.id, {
      attempts: (previous?.attempts ?? 0) + 1,
      message,
      /**
       * ⚠️ **A conflict is not a refusal.** The entry changed elsewhere; the user has to be asked, which is
       * round 3 — so it is retried rather than written off.
       */
      permanent: status >= 400 && status < 500 && status !== 409,
    });

    return false;
  }
}

/**
 * The body for creating an entry.
 *
 * ⚠️ **The idempotency key is the entry's own id**, which is what makes a replayed create harmless: the
 * server's `idempotency_key` is unique, so the second delivery finds the row it already made.
 */
function createBody(entry: Transaction, mark: EntryMark): CreateTransactionInput {
  return {
    id: entry.id,
    idempotencyKey: entry.id,
    kind: entry.kind,
    amountCents: entry.amountCents,
    currency: entry.currency,
    categoryId: entry.categoryId === "" ? null : entry.categoryId,
    paymentMethodId: entry.paymentMethodId,
    occurredAt: entry.occurredAt,
    occurredLocalDate: entry.occurredLocalDate,
    occurredTz: entry.occurredTz,
    note: entry.note,
    tagIds: mark.tagIds === undefined ? [] : [...mark.tagIds],
  };
}

/** The body for changing an entry: everything the screen can edit, and the version it is based on. */
function updateBody(entry: Transaction) {
  return {
    version: entry.version,
    amountCents: entry.amountCents,
    categoryId: entry.categoryId === "" ? null : entry.categoryId,
    paymentMethodId: entry.paymentMethodId,
    currency: entry.currency,
    note: entry.note,
    occurredAt: entry.occurredAt,
    occurredLocalDate: entry.occurredLocalDate,
    occurredTz: entry.occurredTz,
  };
}

/**
 * Record what the server says exists, and settle the three cases it decides.
 *
 * ⚠️ **This is the part the device cannot work out for itself**: the marks say what *this* device intends, and
 * the server's list says what everyone still has. **Comparing them is the only way to notice a change made
 * somewhere else** — and the owner's iPad reached a state with no marks at all, which no amount of local
 * reasoning could recover from.
 *
 * Three cases, and each has exactly one sensible outcome:
 *
 * | On the server | On this device | What it means | What happens |
 * |---|---|---|---|
 * | yes | marked deleted | **the deletion never arrived** | it is delivered on the next walk |
 * | **yes** | **not here at all** | **someone else deleted it, or it was never downloaded** | **nothing is invented** — the entry is not on screen either way |
 * | **no** | marked `synced: false` | **created here, not delivered yet** | it is uploaded on the next walk |
 * | **no** | not here | nothing to do | — |
 *
 * ⚠️ **Only a month fetched to its end may be handed over.** Comparing a partial page would treat everything on
 * the next page as deleted — **the most destructive mistake available in this file.**
 *
 * ⚠️ **The one thing this must never do is delete an entry nobody asked to delete**, so it only ever *removes*
 * intentions that the server confirms have been carried out.
 */
export async function recordServerList(ids: readonly string[]): Promise<void> {
  const onServer = new Set(ids);

  /**
   * ⚠️ **A mark for an entry the server confirms is gone is finished work, and it is cleared here.**
   *
   * This is what releases a row that was stuck: the entry was deleted somewhere — here, from another device, or
   * by a delivery whose mark was never cleared — **and the server's list is the authority on that.** Without
   * this the row keeps its colour for ever while there is nothing left to send, **which is precisely the
   * "钉子户" the owner reported: a row that cannot be deleted even from a working connection.**
   */
  const marks = await readMarks();

  let cleared = 0;

  for (const [id, mark] of Object.entries(marks)) {
    if (onServer.has(id)) continue;

    if (mark.deleted !== true && mark.synced === false) {
      /** Created here and not there yet: that is the green case, and the walk will upload it. */
      continue;
    }

    /**
     * ⚠️ **`mark.synced !== false` here means the server once had it.** An entry the device never created is
     * one it downloaded, so its absence from the list means it was deleted by somebody — **and the deletion the
     * user asked for has therefore happened, whichever route it took.**
     */
    if (mark.deleted === true || mark.synced !== false) {
      await setMark(id, null);
      cleared += 1;
    }
  }

  /**
   * ⚠️ **The screens are republished, because clearing a mark is not visible on its own.**
   *
   * `setMark` publishes the marks, but the row is drawn from the ledger snapshot — and a deletion disappears
   * only when that snapshot is rebuilt. **Without this the mark is gone and the entry is still on screen**,
   * which is precisely what the owner reported: "我刷新的时候，他会直接把删除印记给去掉，东西是实际上并没删除."
   */
  if (cleared > 0) {
    await logOffline("DIAGNOSTIC:server-list", `服务器确认 ${String(cleared)} 条已完成，印记已清`);

    await republishLedger();
  }
}

/**
 * Entries the server has that this device also has, and that this device believes are deleted.
 *
 * ⚠️ **These are the deletions still to be carried out**, and they are read from the marks rather than from a
 * separate queue — so a deletion cannot be recorded and then forgotten, **which is the failure that left the
 * owner's rows red with an empty queue behind them.**
 */
export async function undeletedOnServer(ids: readonly string[]): Promise<number> {
  const onServer = new Set(ids);
  const marks = await readMarks();
  const stored = await readStoredMonths();

  const held = new Set<string>();

  for (const entries of Object.values(stored)) {
    for (const entry of entries) held.add(entry.id);
  }

  let waiting = 0;

  for (const [id, mark] of Object.entries(marks)) {
    if (mark.deleted === true && onServer.has(id) && held.has(id)) waiting += 1;
  }

  return waiting;
}
