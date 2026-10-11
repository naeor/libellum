import type { CreateTransactionInput, UpdateTransactionInput } from "@libellum/shared";

import { logOffline } from "./diagnostics.js";
import { readValue, removeValue, writeValue } from "./storage.js";

/**
 * The queue of changes that have not reached the server yet.
 *
 * ⚠️ **One row per entry, holding that entry's intended final state — not a log of operations.**
 *
 * The owner may edit the same entry three times on a train. A log would replay all three, and the
 * server would perform three writes to arrive at the third — which is right, but wasteful, and it
 * makes *order* matter everywhere. **What the user wants is the last version**, so that is what is
 * stored: **editing again replaces the row rather than adding one.**
 *
 * | Stored as a log | Stored as final intent ✅ |
 * |---|---|
 * | three rows, three replays, order matters | **one row, one replay, order irrelevant** |
 * | intermediate states can reach the server | **only the state the user chose** |
 *
 * ⚠️ **`baseVersion` is the field that makes conflicts detectable**, and it cannot be reconstructed
 * later: it is *the version this device saw when it went offline*. With it, the server's optimistic
 * lock answers "has anyone else touched this since". Without it, a device that was offline for a week
 * would silently overwrite a week of somebody else's edits — **and a ledger that loses an entry
 * quietly is worse than one that refuses to save it.**
 */
export const OUTBOX_KEY = "outbox";

/** What the device intends to do with one entry. */
export type OutboxOp = "create" | "update" | "delete";

export interface OutboxRow {
  /** The entry's id. **The row's identity too** — one row per entry, always. */
  readonly id: string;
  readonly op: OutboxOp;
  /** The intended state. Absent for a delete, which carries no payload. */
  readonly payload?: CreateTransactionInput | UpdateTransactionInput;
  /**
   * The version this device saw when it queued the change.
   *
   * `null` for a create, which has no version yet. Sent as `version` on an update, so the server's
   * optimistic lock can refuse a change built on a stale view.
   */
  readonly baseVersion: number | null;
  /** When it was queued. Used to report how long the oldest change has waited, not to order replays. */
  readonly queuedAt: number;
  readonly attempts: number;
  /** The last failure, in words. Kept so the user can be told why something is stuck. */
  readonly lastError?: string;
  /**
   * The server refused this outright, so it will never be accepted.
   *
   * ⚠️ **Distinct from a failure that will pass**, and the distinction is what stops the queue from dying.
   * A dropped connection, a 5xx or a timeout must be retried — **an entry recorded on a plane is delivered
   * days later, and that is the whole point of the queue.** A 4xx that is not a conflict (the category was
   * deleted, the payload is malformed) will fail identically for ever.
   *
   * **Without this flag both were handled by the same rule — attempts — which is either an infinite retry or
   * a dropped change that only needed the network back.**
   */
  readonly permanent?: boolean;
  /**
   * The server's current version, when it refused the change.
   *
   * ⚠️ **Kept so the conflict screen has something to show.** Round 3 compares "mine" with "theirs",
   * and *theirs* is only available at the moment of refusal — asking again later would show a third
   * version that neither side ever saw.
   */
  readonly conflictVersion?: number;
}

/** Every row currently queued. Never throws: an unreadable queue is an empty one. */
export async function readOutbox(): Promise<readonly OutboxRow[]> {
  const stored = await readValue<readonly OutboxRow[]>(OUTBOX_KEY);

  return Array.isArray(stored) ? stored : [];
}

/** How many changes are waiting, and how many are stuck needing a decision. */
export interface OutboxSummary {
  readonly pending: number;
  readonly conflicts: number;
  /** Milliseconds the oldest change has been waiting. Zero when the queue is empty. */
  readonly oldestWaitMs: number;
}

/** A summary for the interface. Cheap enough to call on every render of a banner. */
export async function outboxSummary(): Promise<OutboxSummary> {
  const rows = await readOutbox();
  const conflicts = rows.filter((row) => row.conflictVersion !== undefined).length;
  const oldest = rows.reduce<number | null>(
    (earliest, row) => (earliest === null || row.queuedAt < earliest ? row.queuedAt : earliest),
    null,
  );

  return {
    pending: rows.length,
    conflicts,
    oldestWaitMs: oldest === null ? 0 : Date.now() - oldest,
  };
}

/**
 * Queue a change, replacing any change already queued for the same entry.
 *
 * ⚠️ **A create followed by edits stays a create**, and **a create followed by a delete removes the
 * row entirely** — the entry never reached the server, so there is nothing to delete, and sending a
 * delete for an id the server has never seen would be a guaranteed 404 to retry for ever.
 *
 * **These two rules are what keep the queue honest about intent rather than about history.**
 */
export async function queueChange(row: Omit<OutboxRow, "queuedAt" | "attempts">): Promise<void> {
  const rows = await readOutbox();
  const existing = rows.find((candidate) => candidate.id === row.id);

  /**
   * A create that is then deleted never happened.
   *
   * ⚠️ **Removed from the queue rather than queued as a delete.** The server has never heard of this
   * id, so a `DELETE /transactions/:id` would 404 — and a 404 on a delete is a permanent failure that
   * would sit at the head of the queue for ever.
   */
  if (existing?.op === "create" && row.op === "delete") {
    await writeOutbox(rows.filter((candidate) => candidate.id !== row.id));

    return;
  }

  /**
   * ⚠️ **The later change keeps the earlier `baseVersion`.**
   *
   * The optimistic lock is about *what this device started from*, not about the most recent edit. If
   * an edit replaced it with the version the device now holds — which it produced itself — the server
   * would be asked to accept a change based on a version nobody else ever confirmed, and **two edits
   * would collapse into one silent overwrite.**
   */
  const baseVersion =
    existing !== undefined && existing.op !== "create" ? existing.baseVersion : row.baseVersion;

  const merged: OutboxRow = {
    ...row,
    baseVersion: existing?.op === "create" ? null : baseVersion,
    queuedAt: existing?.queuedAt ?? Date.now(),
    attempts: 0,
    ...(existing?.lastError === undefined ? {} : { lastError: existing.lastError }),
  };

  /**
   * ⚠️ **A create stays a create through later edits.**
   *
   * Editing an entry that was created offline must not become an `update`: the server has never seen
   * that id, so an update would 404 for ever. The whole point of one row per entry is that the *first*
   * interaction with the server decides the verb.
   */
  const op: OutboxOp = existing?.op === "create" ? "create" : row.op;
  const next = [...rows.filter((candidate) => candidate.id !== row.id), { ...merged, op }];

  await writeOutbox(next);

  await logOffline(
    "DIAGNOSTIC:outbox-queue",
    `${op} ${row.id.slice(0, 8)}，共 ${String(next.length)} 条待同步`,
  );
}

/**
 * Clear the marks that make the automatic path give up on a row.
 *
 * ⚠️ **Called when a person explicitly asks for a sync, and only then.**
 *
 * The queue has two reasons to stop retrying a row: the server refused it outright (`permanent`), or it has
 * failed `MAX_ATTEMPTS` times. **Both are right for a background retry** — a phone must not hammer a server it
 * cannot satisfy — **and both are wrong for a person standing there pressing a button**, which is what the
 * owner described: "绿色的新增部分会被固定下来，但是红色的部分没有被删除."
 *
 * **"Permanent" is a judgement about one response at one moment.** The category may have been recreated, the
 * session refreshed, the book restored — **and none of that changes the stored error, so the row would stay
 * rejected for ever without anybody asking it again.**
 *
 * @returns how many rows were un-stuck.
 */
export async function clearGiveUpMarks(): Promise<number> {
  const rows = await readOutbox();
  let cleared = 0;

  const next = rows.map((row) => {
    if (row.permanent !== true && row.attempts < 1) return row;

    cleared += 1;

    const { permanent: _permanent, lastError: _lastError, ...rest } = row;

    return { ...rest, attempts: 0 };
  });

  if (cleared === 0) return 0;

  await writeOutbox(next);

  return cleared;
}

/** Remove a row that reached the server. */
export async function resolveChange(id: string): Promise<void> {
  const rows = await readOutbox();

  await writeOutbox(rows.filter((row) => row.id !== id));
}

/** Record a failure without losing the change. */
export async function recordFailure(
  id: string,
  error: string,
  options: { readonly permanent?: boolean; readonly conflictVersion?: number } = {},
): Promise<void> {
  const rows = await readOutbox();

  await writeOutbox(
    rows.map((row) =>
      row.id === id
        ? {
            ...row,
            attempts: row.attempts + 1,
            lastError: error,
            ...(options.permanent === true ? { permanent: true } : {}),
            ...(options.conflictVersion === undefined ? {} : { conflictVersion: options.conflictVersion }),
          }
        : row,
    ),
  );
}

/** Forget everything. Called on sign-out — see the note in `clearOutbox`. */
export async function clearOutbox(): Promise<void> {
  await removeValue(OUTBOX_KEY);
}

/**
 * Write the queue.
 *
 * ⚠️ **Through `writeValue`, which serialises writes per key.** Two changes queued in the same tick —
 * which is exactly what a batch edit does — would otherwise interleave their read-modify-write and one
 * would be lost. **This file has been bitten by that pattern once already**, in the cache layer.
 */
async function writeOutbox(rows: readonly OutboxRow[]): Promise<void> {
  await writeValue(OUTBOX_KEY, rows);
}
