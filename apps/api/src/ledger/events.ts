import type { Prisma } from "../generated/prisma/client.js";

/**
 * Recording the ledger's history: **who changed what, and when**.
 *
 * ⚠️ **The owner's framing is the design**: *"编辑历史的主要目的**不是复杂的版本管理**，而是让用户
 * 能够明确知道：谁在什么时候，对哪一笔账目做了什么修改."* So this writes **sentences a person
 * reads**, not a version store to roll back to.
 *
 * ⚠️ **Written by the server, on the server's clock.** Offline edits produce their event at **sync
 * time**, not when the person tapped save — the same placement as the entry number
 * (`allocateTransactionSeq`), and for the same reason: **the server is where an offline change first
 * becomes a fact the ledger knows about.**
 *
 * ⚠️ **Every call takes the transaction client.** An event written outside the transaction that
 * caused it can survive a rollback — **"somebody edited this" with no edit behind it** — or be lost
 * when the edit succeeded. Both are worse than not recording it.
 */

type Tx = Prisma.TransactionClient;

export type EventKind =
  | "created"
  | "updated"
  | "deleted"
  | "restored"
  | "member_changed"
  /**
   * ⚠️ **About the ledger itself rather than about one entry** (added 1.10.08, for renaming).
   *
   * ⚠️ **The counterpart of `member_changed`, and for the same reason**: `transactionId` and
   * `transactionSeq` are both null, because there is no entry behind it. The owner's framing for the
   * history is *"谁在什么时候，对哪一笔账目做了什么修改"* — and his own extension of it —
   * *"也可以适当展示成员加入、退出……等重要协作事件."* **A ledger's name changing is one of those.**
   */
  | "book_changed";

/** One field's before and after, as the history screen renders it. */
export interface FieldChange {
  readonly from: unknown;
  readonly to: unknown;
}

export interface RecordEventInput {
  readonly bookId: string;
  /** Null for a `member_changed` event — those are about the ledger, not about one entry. */
  readonly transactionId?: string | null;
  /**
   * ⚠️ **The entry's number at the time of the event.** Stored because after a delete the entry
   * cannot be asked for its number any more, and **a history line that cannot name the entry is
   * useless** — one of the owner's three examples is *"删除了 #000103"*.
   */
  readonly transactionSeq?: number | null;
  readonly actorId: string | null;
  /** ⚠️ A snapshot, so a closed account's actions still read as a person's. */
  readonly actorName: string | null;
  readonly kind: EventKind;
  /** Which fields changed, and what they were. Omitted for created/deleted/restored. */
  readonly changes?: Record<string, FieldChange> | null;
  readonly at?: Date;
}

/**
 * Append one event.
 *
 * ⚠️ **`actorName` is stored rather than joined.** A join would show the name the account has
 * *now* — so renaming yourself would silently rewrite history, and closing the account would blank
 * it. **The history says who did it at the time**, which is the only answer that stays true.
 */
export async function recordEvent(tx: Tx, input: RecordEventInput): Promise<void> {
  await tx.transactionEvent.create({
    data: {
      bookId: input.bookId,
      transactionId: input.transactionId ?? null,
      transactionSeq: input.transactionSeq ?? null,
      actorId: input.actorId,
      actorName: input.actorName,
      kind: input.kind,
      /**
       * ⚠️ **Spread, not a nullable field.** `exactOptionalPropertyTypes` is on, and Prisma's
       * `Json` input does not accept an explicit `undefined` — passing one is a compile error, and
       * the compiler is right to insist: **"no changes recorded" and "changes recorded as null" are
       * different**, and only the first is what a `created` event means.
       */
      ...(input.changes === undefined || input.changes === null
        ? {}
        : { changes: input.changes as unknown as Prisma.InputJsonValue }),
      occurredAt: input.at ?? new Date(),
    },
    select: { id: true },
  });
}

/** The fields the history tracks, and how each is named on screen. */
const TRACKED_FIELDS: readonly { readonly key: string; readonly label: string }[] = [
  { key: "amountCents", label: "金额" },
  { key: "kind", label: "类型" },
  { key: "currency", label: "币种" },
  { key: "categoryId", label: "分类" },
  { key: "paymentMethodId", label: "支付方式" },
  { key: "occurredAt", label: "时间" },
  { key: "occurredTz", label: "时区" },
  { key: "note", label: "备注" },
  /**
   * ⚠️ **A ledger's name is not an entry field, and it is in this table anyway** (1.10.08).
   *
   * The table is not really "the entry's tracked fields" — it is **"every key that can appear in an
   * event's `changes`, and what to call it on screen."** `history.ts` renders `label` by looking the
   * key up here and **falls back to the raw column name**, so a `book_changed` event whose key was
   * missing would print *"name：（空）→ 共享账本"* — a field name in English, in a Chinese sentence.
   *
   * ⚠️ **Adding it to `diffEntry`'s loop is harmless**: that loop skips any key not present in
   * `after`, and a transaction has no `name` field, so no entry edit can ever produce it.
   */
  { key: "name", label: "名称" },
];

export function trackedFieldLabel(key: string): string | null {
  return TRACKED_FIELDS.find((field) => field.key === key)?.label ?? null;
}

/**
 * Work out what changed between two versions of an entry.
 *
 * ⚠️ **Only the tracked fields, and only the ones that actually differ.** Writing every field on
 * every save would turn one edit into eight lines of "no change", and **a history where most lines
 * say nothing is a history nobody reads.**
 *
 * ⚠️ **Comparison is by value, not by reference** — `Date` and `BigInt` need normalising first, or
 * every edit would report the timestamp as changed. The same lesson as the conflict work: *"判据应该
 * 是值"*.
 */
export function diffEntry(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};

  for (const { key } of TRACKED_FIELDS) {
    if (!(key in after)) continue;

    const from = normalise(before[key]);
    const to = normalise(after[key]);
    if (from === to) continue;

    changes[key] = { from: storable(before[key] ?? null), to: storable(after[key] ?? null) };
  }

  return changes;
}

/**
 * A value that survives the trip into JSONB **and still reads like the number it is**.
 *
 * ⚠️ **`BigInt` cannot be stored as JSON, and the obvious workaround is wrong.** `JSON.stringify`
 * refuses it, so the first version of this left the value to `normalise` — and an amount of 3500
 * came back from the database as the **string** `"3500"`. The history screen would then have to
 * decide, per field, whether a string is a number, and **so would every future reader of this
 * table.**
 *
 * ⚠️ **`Number` is safe here and the reason is stated in the schema**: `amountCents` is bounded by
 * `amountCentsSchema`, which keeps every value inside the safe-integer range. **Converting a
 * bigint that could exceed it would be a different decision** — this one is safe precisely because
 * of a limit enforced elsewhere.
 */
function storable(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * A comparable form, so "did this change" is answered by value.
 *
 * ⚠️ **`Date` → its instant, `BigInt` → its string, `undefined` → `null`.** Without this,
 * `new Date(x)` and `new Date(x)` are different objects, **every save would report the time as
 * changed**, and the history would be full of edits that never happened.
 */
function normalise(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}
