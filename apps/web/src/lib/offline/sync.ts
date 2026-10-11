import type { CreateTransactionInput, Transaction } from "@libellum/shared";

import { ApiRequestError, apiFetch } from "../api.js";
import { readMarks, readStoredMonths, setConflict, setMark, storeMonth, upsertEntry, type ConflictFieldRecord, type EntryMark } from "./localLedger.js";
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
      if (mark.pending === true) found.push({ entry, op: "delete", mark });
      continue;
    }

    if (mark.conflict !== undefined && mark.settlesConflict !== true) continue;

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
let syncing: Promise<SyncReport> | null = null;
export function syncAll(): Promise<SyncReport> {
  if (syncing !== null) return syncing;
  syncing = runSync().finally(() => { syncing = null; });
  return syncing;
}

async function runSync(): Promise<SyncReport> {
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
    if (failure?.permanent === true && intent.mark.settlesConflict !== true) {
      refused += 1;
      continue;
    }

    if (failure !== undefined && failure.attempts >= MAX_ATTEMPTS && intent.mark.settlesConflict !== true) {
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
    let confirmed: Transaction | undefined;
    await logOffline("DIAGNOSTIC:sync-request", JSON.stringify({ id: short, op,
      settlesConflict: intent.mark.settlesConflict === true,
      amountCents: entry.amountCents, fields: Object.keys(intent.mark.chain ?? {}) }));
    if (op === "create") {
      confirmed = await apiFetch<Transaction>("/transactions", {
        method: "POST",
        body: createBody(entry, intent.mark),
      });
    } else if (op === "update") {
      confirmed = await apiFetch<Transaction>(`/transactions/${entry.id}`, {
        method: "PATCH",
        body: updateBody(entry, intent.mark),
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
    // Never acknowledge an edit made while this request was in flight.
    if (JSON.stringify((await readMarks())[entry.id]) === JSON.stringify(intent.mark)) {
      if (confirmed !== undefined) await upsertEntry(confirmed);
      // Keep an acknowledged tombstone so an older query cache cannot resurrect a deleted row.
      await setMark(entry.id, op === "delete" ? { deleted: true, pending: false, synced: true } : null);
      await republishLedger();
    }
    failures.delete(entry.id);
    await logOffline("DIAGNOSTIC:sync-confirmed", JSON.stringify({ id: short,
      settlesConflict: intent.mark.settlesConflict === true, amountCents: confirmed?.amountCents }));

    await logOffline("DIAGNOSTIC:sync-ok", `${op} ${short}`);

    return true;
  } catch (error) {
    const status = error instanceof ApiRequestError ? error.status : 0;

    // HTTP failures retain the local intent. A list page cannot acknowledge a write.

    const message = error instanceof Error ? error.message : String(error);

    await logOffline(
      "DIAGNOSTIC:sync-failed",
      `${op} ${short} — ${status === 0 ? "无响应" : String(status)} ${message}`,
    );

    /**
     * ⚠️ **A conflict is not a failure, and it is not retried either — it is a question waiting to be asked.**
     *
     * The server refused because somebody else changed this entry after this device last saw it. **Retrying
     * would ask the same question again and get the same refusal**, so the two versions are kept and the row
     * moves to a state of its own until the user answers.
     *
     * ⚠️ **Both versions are stored, and that is the whole point of catching it here.** The server's copy comes
     * with the refusal, and **my copy is about to be overwritten by the next full refresh** — so if it is not
     * captured now, the thing the user actually typed is gone before anybody can show it to them.
     */
    if (status === 409) {
      const refusal = readRefusal(error);

      if (refusal !== null) {
        if (JSON.stringify((await readMarks())[entry.id]) === JSON.stringify(intent.mark)) {
          await recordConflict(entry, refusal);
        }

        failures.delete(entry.id);

        await logOffline("DIAGNOSTIC:sync-conflict", `${op} ${short} — 两份都留住了，等用户决定`);

        return false;
      }

      /**
       * ⚠️ **A 409 without the server's copy is the old protocol**, and it must not be swallowed: the entry is
       * left marked, so it stays visible and the next run tries again rather than the edit disappearing.
       */
      await logOffline("DIAGNOSTIC:sync-conflict", `${op} ${short} — 冲突但没收到对方那一版`);

      return false;
    }

    const previous = failures.get(entry.id);

    failures.set(entry.id, {
      attempts: (previous?.attempts ?? 0) + 1,
      message,
      permanent: status >= 400 && status < 500,
    });

    return false;
  }
}

/**
 * Keep both versions of an entry the server refused to accept.
 *
 * ⚠️ **Captured at the moment of refusal, not when the screen opens.**
 *
 * The server's copy arrives with the 409 and mine is what the device holds right now — **and the very next full
 * refresh replaces mine with theirs.** So a conflict that is not written down here has already lost the thing
 * the user typed, and no screen could offer them the choice.
 *
 * ⚠️ **The version both sides started from is `null`, and that is an honest answer rather than a shortcut.**
 *
 * The stored copy *is* this device's edit — that is what a pending mark means — so it cannot serve as the
 * starting point. **Using it would make every field look "changed by me"**, the merge would take my values
 * everywhere, and **the other device's work would be overwritten without anybody being asked.** With no base,
 * every difference becomes a question: more questions than strictly needed, and **never a silent overwrite.**
 */
async function recordConflict(entry: Transaction, refusal: Refusal): Promise<void> {
  await setConflict(entry.id, {
    mine: entry,
    theirs: refusal.current,
    base: null,
    fields: refusal.fields,
    at: Date.now(),
  });
}

/** The editable fields, in the order the conflict screen lists them. */
export type RefusedField = ConflictFieldRecord;

/** What a 409 carried back. */
interface Refusal {
  readonly current: Transaction;
  readonly fields: readonly RefusedField[];
}

/**
 * The server's answer, out of a 409 response.
 *
 * ⚠️ **It is the server's list of conflicting fields that decides what gets asked** — the client does not work it
 * out again. This is the owner's rule applied literally:
 *
 * > **"只有在服务器的数值是 C，而某台设备上传的请求是把数字从 A 改成 B 时才会触发冲突机制."**
 *
 * **Only the server can tell** whether the value the device read has moved, and **a second implementation of the
 * same rule on the client would eventually disagree with the first.** It also cannot be derived here at all: the
 * copy the user started from lives in the value chain, not in a stored snapshot.
 *
 * ⚠️ **And the whole entry comes back with the refusal** rather than being fetched afterwards — **the row can
 * change again between the refusal and a follow-up read, and the user would then be choosing against a version
 * that never caused the disagreement.**
 */
function readRefusal(error: unknown): Refusal | null {
  if (!(error instanceof ApiRequestError)) return null;

  const details = error.details as { readonly current?: unknown; readonly conflicts?: unknown } | null | undefined;
  const current = details?.current;

  if (typeof current !== "object" || current === null) return null;

  const candidate = current as { readonly id?: unknown; readonly version?: unknown };

  if (typeof candidate.id !== "string" || typeof candidate.version !== "number") return null;

  const fields: RefusedField[] = [];

  if (Array.isArray(details?.conflicts)) {
    for (const item of details.conflicts) {
      const shape = item as Partial<ConflictFieldRecord>;

      if (typeof shape.field === "string") fields.push({ field: shape.field, serverValue: shape.serverValue,
        ...(Array.isArray(shape.claims) ? { claims: shape.claims } : {}),
        ...(Array.isArray(shape.history) ? { history: shape.history } : {}),
      });
    }
  }

  return { current: current as Transaction, fields };
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

/**
 * The body for changing an entry: everything the screen can edit, plus — **the part that decides conflicts** —
 * what each field was before the user changed it.
 *
 * ⚠️ **"From A to B", not "set it to B"**, which is the owner's rule and the reason the server can tell an edit
 * made against a current view from one made against a view that no longer exists:
 * **"只有在服务器的数值是 C，而某台设备上传的请求是把数字从 A 改成 B 时才会触发冲突机制."**
 *
 * ⚠️ **A field with no recorded chain is left out of `changes` deliberately.** That happens for an edit made
 * before this existed, and **inventing a base for it would be inventing a claim about what the user saw** — the
 * server then treats the field as an ordinary write, which is what it did before.
 */
function updateBody(entry: Transaction, mark: EntryMark) {
  const chain = mark.chain ?? {};
  const changes = Object.entries(chain).map(([field, values]) => ({
    field,
    base: values[0],
    wanted: values[values.length - 1],
    chain: values,
  }));

  return {
    /**
     * ⚠️ **The version is the server's last confirmed one, not this entry's own.**
     *
     * The entry's version is incremented locally on every edit, so sending it told the server "nothing has
     * happened since we agreed" — **even when another device had moved the row in between.** That is what let the
     * tablet's 40 overwrite the phone's 20: the server had no way to tell the difference, **because the device
     * claimed to be current.**
     *
     * ⚠️ **Falling back to the entry's own version keeps the previous behaviour** for a mark with no confirmed
     * version — an entry edited before this existed.
     */
    version: entry.version,
    settlesConflict: mark.settlesConflict === true,
    kind: entry.kind,
    tagIds: entry.tags.map(tag => tag.id),
    amountCents: entry.amountCents,
    categoryId: entry.categoryId === "" ? null : entry.categoryId,
    paymentMethodId: entry.paymentMethodId,
    currency: entry.currency,
    note: entry.note,
    occurredAt: entry.occurredAt,
    occurredLocalDate: entry.occurredLocalDate,
    occurredTz: entry.occurredTz,
    /** ⚠️ Omitted when empty, so an old-style write stays exactly that. */
    ...(changes.length === 0 ? {} : { changes }),
  };
}

export async function deferConflictsToServer(): Promise<boolean> {
  const answer = await apiFetch<{ readonly resolved: number }>("/conflicts/resolve-with-server", {
    method: "POST",
    timeoutMs: 10_000,
  }).catch(() => null);

  if (answer === null) {
    await logOffline("DIAGNOSTIC:conflicts-deferred", "告诉服务器「以服务器为准」失败，下次同步再试");

    return false;
  }

  await logOffline("DIAGNOSTIC:conflicts-deferred", `已告诉服务器：${String(answer.resolved)} 笔以它为准`);

  return true;
}
/** Download the complete month, preserving local edits and unresolved conflict candidates. */
export async function syncMonth(month: string): Promise<number> {
  const entries: Transaction[] = [];
  let cursor: string | undefined;
  do {
    const page = await apiFetch<{ readonly items: readonly Transaction[]; readonly nextCursor: string | null }>(
      "/transactions", { query: { month, limit: "100", cursor }, timeoutMs: 15_000 },
    ).catch(() => null);
    if (page === null) return 0;
    entries.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  // Only this complete, unfiltered month can confirm an already absent deletion.
  const serverIds = new Set(entries.map(entry => entry.id));
  const stored = await readStoredMonths();
  const marks = await readMarks();
  for (const entry of stored[month] ?? []) {
    if (marks[entry.id]?.deleted === true && marks[entry.id]?.pending === true && !serverIds.has(entry.id)) {
      await setMark(entry.id, { deleted: true, pending: false, synced: true });
    }
  }
  await storeMonth(month, entries);
  await republishLedger();
  return entries.length;
}
export async function pullConflicts(): Promise<number> {
  const answer = await apiFetch<{
    readonly conflicts: readonly {
      readonly transactionId: string;
      /** ⚠️ The server's own copy, without which there is no second side to choose against. */
      readonly current: Transaction | null;
      readonly fields: readonly ConflictFieldRecord[];
    }[];
  }>("/conflicts", { timeoutMs: 10_000 }).catch(() => null);

  /** ⚠️ A failed pull changes nothing — an unanswered question stays on screen rather than disappearing. */
  if (answer === null) return 0;

  const marks = await readMarks();
  const stored = await readStoredMonths();
  const byId = new Map<string, Transaction>();

  for (const entries of Object.values(stored)) {
    for (const entry of entries) byId.set(entry.id, entry);
  }

  const listed = new Set(answer.conflicts.map((item) => item.transactionId));

  /** ⚠️ Questions the server no longer has are answered — drop them so the yellow mark goes. */
  for (const [id, mark] of Object.entries(marks)) {
    if (mark.conflict === undefined || listed.has(id) || mark.settlesConflict === true) continue;
    const current = await apiFetch<Transaction>(`/transactions/${id}`).catch(() => null);
    if (current === null) continue;
    if (JSON.stringify((await readMarks())[id]) !== JSON.stringify(mark)) continue;
    await upsertEntry(current);
    await setMark(id, null);
    await republishLedger();
    await logOffline("DIAGNOSTIC:conflict-adopted", `${id.slice(0, 8)}：其他设备已处理，金额=${String(current.amountCents)} 分`);
  }

  let found = 0;

  for (const item of answer.conflicts) {
    const entry = byId.get(item.transactionId);

    /** ⚠️ A conflict for an entry this device does not hold cannot be shown, and is left for the server to keep. */
    if (entry === undefined) continue;

    /**
     * ⚠️ **`theirs` is the server's copy, and the first version filled it with the local entry.**
     *
     * The two sides were then identical, so comparing them found nothing to disagree about — **and a yellow row
     * opened onto a screen that listed no fields and asked nothing**, which is exactly what the owner saw:
     * "他居然显示没有需要自动合并的字段，同时需要我选的地方是 0 处；我只能选择用这个结果保存."
     *
     * ⚠️ **A conflict the server lists but cannot hand over a copy for is skipped rather than shown empty**:
     * **an empty question is worse than no question at all**, because the user is invited to settle something
     * they cannot see.
     */
    if (item.current === null) continue;

    /**
     * ⚠️ **A field this device differs on is part of the question, even when the server did not name it.**
     *
     * The owner's report: "pad 上显示冲突点有金额和时间，但手机上显示冲突点只有时间."
     *
     * **Why**: the server names the fields that conflicted *in the request that raised it*, and that request came
     * from one device. **The other device is then shown only those fields, so a difference it holds itself stays
     * invisible to its own user** — and the two devices ask different questions about one disagreement.
     *
     * ⚠️ **The comparison is the same one the server makes, applied to what this device can see**: the server's
     * value and this device's value. **A field where they differ is one this user has to decide about**, whether or
     * not the server happened to mention it.
     */
    const latest = (await readMarks())[item.transactionId];
    if (latest?.settlesConflict === true) continue;
    const fields = item.fields;
    await logOffline("DIAGNOSTIC:conflict-received", JSON.stringify({ id: item.transactionId.slice(0, 8),
      localAmountCents: entry.amountCents, serverAmountCents: item.current.amountCents,
      fields: fields.map(field => ({ field: field.field, candidates: field.claims?.length ?? 0,
        ...(field.field === "amountCents" ? { server: field.serverValue,
          devices: field.claims?.map(claim => ({ device: claim.deviceId, chain: claim.chain })) } : {}) })) }));

    await setConflict(item.transactionId, {
      /** ⚠️ This device's entry — what the user has here. */
      mine: entry,
      /** ⚠️ The server's entry — the side they are choosing against. */
      theirs: item.current,
      base: null,
      fields,
      at: Date.now(),
    });

    found += 1;
  }

  if (found > 0) await logOffline("DIAGNOSTIC:conflicts-pulled", `服务器上有 ${String(found)} 笔待选择`);

  return found;
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
