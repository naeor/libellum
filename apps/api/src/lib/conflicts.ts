import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

/**
 * Deciding whether a device's change belongs to a conflict, and remembering what happened.
 *
 * ⚠️ **The rule, in the owner's words, and it is the only rule in this file**:
 *
 * > **"只有在服务器的数值是 C，而某台设备上传的请求是把数字从 A 改成 B 时才会触发冲突机制——换句话说，
 * > 某台设备上记录的原数值以及修改后数值跟服务器当前记录的数值不同时才有必要触发冲突."**
 *
 * So the question is never "do the two values differ" — **it is "is the value this device started from still
 * what the server holds".** A device whose base matches the server is simply editing; a device whose base does
 * not match was working from a view that no longer exists, **and only then do two people's decisions need
 * reconciling**.
 *
 * ⚠️ **And his corollary is what keeps this from becoming noise**:
 *
 * > **"如果这个金额正好是服务器历史记录中的金额…那不用提醒用户，直接把本地的金额从 A 变成 B."**
 *
 * A value the server has held before means the device merely fell behind — **not that it disagreed.**
 * Covering those automatically is what keeps the yellow mark meaning "somebody has to decide" instead of
 * "something is out of date", which would be every offline edit ever made.
 */

/** How many past values are kept per entry. */
export const HISTORY_LIMIT = 20;

/**
 * The fields a conflict can be about.
 *
 * ⚠️ **Exactly the editable ones, and no others.** `version` is the mechanism, `categoryName` follows
 * `categoryId`, and the timestamps are the server's — **comparing any of them would raise a conflict about
 * something the user never chose.**
 */
export const CONFLICT_FIELDS = [
  "kind",
  "amountCents",
  "currency",
  "categoryId",
  "paymentMethodId",
  "occurredAt",
  "note",
  "tagIds",
] as const;

export type ConflictField = (typeof CONFLICT_FIELDS)[number];

/** One value an entry has held, and who put it there. */
interface HistoryEntry {
  readonly version: number;
  /** Only the fields that changed, so the history stays small. */
  readonly values: Record<string, unknown>;
  /** The device that sent it, when the client said so. */
  readonly deviceId?: string;
  readonly at: string;
}

/** What one device tried to send. */
export interface ConflictClaim {
  readonly deviceId: string;
  /** The chain the device reported: first value is its base, last is what it wants. */
  readonly chain: readonly unknown[];
  readonly at: string;
}

/** Read a JSON column that is expected to be an array. */
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Every value this field has ever held, reconstructed from the row's history.
 *
 * ⚠️ **Reconstructed rather than stored per field.** The history records *what changed each time*, so a value a
 * field had at version 4 is found by walking the snapshots forward — **and that is exactly what "has the server
 * ever held this value" needs.** Storing a list per field as well would be a second copy of the same facts.
 */
export function valuesSeen(
  history: readonly unknown[],
  field: ConflictField,
  current: unknown,
): readonly unknown[] {
  const seen: unknown[] = [];

  for (const raw of history) {
    const entry = raw as HistoryEntry | null;
    const values = entry?.values;

    if (values !== undefined && field in values) seen.push(values[field]);
  }

  seen.push(current);

  return seen;
}

/** Whether two values are the same, with tags compared as sets. */
function same(field: ConflictField, left: unknown, right: unknown): boolean {
  if (field !== "tagIds") return left === right;

  const a = Array.isArray(left) ? [...(left as string[])].sort() : [];
  const b = Array.isArray(right) ? [...(right as string[])].sort() : [];

  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** What should happen to one device's change. */
export type Verdict =
  | { readonly kind: "accept" }
  /** ⚠️ The device is behind, and the server's value is the answer. Nothing to ask. */
  | { readonly kind: "server-wins" }
  /** ⚠️ Two decisions from one starting point. **This is the only case the user is asked about.** */
  | { readonly kind: "conflict"; readonly serverValue: unknown };

/**
 * Decide what to do about one field a device is changing.
 *
 * ⚠️ **The question is not "has the server ever held this value" but "did the value this device read move".**
 *
 * The first version asked the former, and two tests caught what it gets wrong: when the phone changed the amount
 * to 60 while the tablet was offline at 30, **the tablet's base was 30, which the server *had* held** — so the
 * "it merely fell behind" rule fired and the tablet's edit was thrown away **without anybody being asked.**
 * That is the silent loss this whole feature exists to prevent.
 *
 * ⚠️ **A value being in the history says nothing on its own**, because *every* value a device could have read
 * was once the current one — the base is in the history by definition. **What matters is whether it is still the
 * last one**, and that is what the version says:
 *
 * | `baseVersion` | Meaning | Outcome |
 * |---|---|---|
 * | **equals the row's version** | **nothing has happened to this entry since** | the device is simply editing what it just saw → **accept** |
 * | **older** | the row moved on | **compare the values — see below** |
 *
 * ⚠️ **And when it moved on, the values decide**, which is the owner's own rule: the server's value wins *unless*
 * both sides ended up somewhere different, **in which case two decisions were made from one starting point and
 * only the user can say which was meant.**
 *
 * ⚠️ **The history is still worth keeping and still worth showing** — it is what the conflict screen puts in
 * front of the user — but it is not the judgement. **The judgement is "did the value you read change", and the
 * version answers that exactly.**
 */
export function judge(
  field: ConflictField,
  base: unknown,
  wanted: unknown,
  serverValue: unknown,
  baseVersion: number,
  serverVersion: number,
): Verdict {
  /**
   * ⚠️ **Nothing has happened to this entry since the device read it** — the ordinary case, and the reason an
   * online device can never conflict. **Accept, whatever it asks for.**
   */
  if (baseVersion >= serverVersion) return { kind: "accept" };

  /**
   * ⚠️ **The change to that field was already carried out, possibly by another device.** Nothing to change and
   * nothing to ask — this is the owner's "设备上传的请求是把数值 A 改成数值 C，那服务器不用改".
   */
  if (same(field, wanted, serverValue)) return { kind: "server-wins" };

  /**
   * ⚠️ **The server still holds the value the device was editing from**, even though the entry moved on —
   * another field changed, or a value changed and came back. **The device is behind, not in disagreement**, and
   * the owner's rule is explicit: **"一律用服务器数据覆盖本地数据."**
   */
  if (same(field, base, serverValue)) return { kind: "server-wins" };

  /**
   * ⚠️ **The value the device read is gone, and it wants something other than what is there now** — so two
   * decisions came out of one starting point. **This is the only case that reaches the user**, and the only one
   * where the program genuinely cannot know what was meant.
   */
  return { kind: "conflict", serverValue };
}

/** Record the values a change put into place, keeping the newest `HISTORY_LIMIT`. */
export function appendHistory(
  existing: readonly unknown[],
  version: number,
  values: Record<string, unknown>,
  deviceId: string | undefined,
): readonly HistoryEntry[] {
  const entry: HistoryEntry = {
    version,
    values,
    ...(deviceId === undefined ? {} : { deviceId }),
    at: new Date().toISOString(),
  };

  /** ⚠️ Oldest first, trimmed from the front — "最近 20 个"，所有者定的上限。 */
  return [...existing, entry].slice(-HISTORY_LIMIT) as readonly HistoryEntry[];
}

/** Every conflict waiting for an answer on one book. */
export async function openConflicts(prisma: PrismaClient, bookId: string) {
  return prisma.transactionConflict.findMany({
    where: { bookId, resolvedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Raise a conflict, or add this device's claim to one already raised.
 *
 * ⚠️ **Adding to the existing row rather than writing a second one** — that is what lets the audit record
 * answer "which two devices disagreed, and what did each of them send", **which the owner asked for by name**:
 * "最好还能记录冲突是哪两台设备传上来的，他们传出来的结果分别是什么."
 */
export async function raiseConflict(
  prisma: PrismaClient,
  args: {
    readonly transactionId: string;
    readonly bookId: string;
    readonly field: ConflictField;
    readonly serverValue: unknown;
    readonly claim: ConflictClaim;
    readonly history: readonly unknown[];
  },
): Promise<void> {
  const existing = await prisma.transactionConflict.findFirst({
    where: { transactionId: args.transactionId, field: args.field, resolvedAt: null },
  });

  if (existing === null) {
    await prisma.transactionConflict.create({
      data: {
        transactionId: args.transactionId,
        bookId: args.bookId,
        field: args.field,
        serverValue: args.serverValue as Prisma.InputJsonValue,
        claims: [args.claim] as unknown as Prisma.InputJsonValue,
        history: args.history as unknown as Prisma.InputJsonValue,
      },
    });

    return;
  }

  const claims = asArray(existing.claims) as readonly ConflictClaim[];
  /** ⚠️ One claim per device: a device that edits again replaces its own earlier attempt. */
  const merged = [...claims.filter((claim) => claim.deviceId !== args.claim.deviceId), args.claim];

  await prisma.transactionConflict.update({
    where: { id: existing.id },
    data: { claims: merged as unknown as Prisma.InputJsonValue },
  });
}

/**
 * Settle every open conflict on one transaction with the value the user chose.
 *
 * ⚠️ **This is the step that stops the other devices being asked the same question**:
 * "如果用户已经对这个冲突做了一次确认…此时没必要让用户在别的设备上再肯定一次."
 *
 * The permanent record is written before the open row is removed, so there is no instant where the decision
 * exists only in a row about to be deleted.
 */
export async function settleConflicts(
  prisma: PrismaClient,
  args: {
    readonly transactionId: string;
    readonly bookId: string;
    readonly deviceId: string;
    /** The value the user settled on, per field. */
    readonly settled: Record<string, unknown>;
  },
): Promise<void> {
  const open = await prisma.transactionConflict.findMany({
    where: { transactionId: args.transactionId, resolvedAt: null },
  });

  for (const conflict of open) {
    const field = conflict.field as ConflictField;
    const value = field in args.settled ? args.settled[field] : conflict.serverValue;

    await prisma.conflictResolution.create({
      data: {
        transactionId: args.transactionId,
        bookId: args.bookId,
        field: conflict.field,
        serverValue: conflict.serverValue as Prisma.InputJsonValue,
        claims: conflict.claims as Prisma.InputJsonValue,
        resolvedValue: value as Prisma.InputJsonValue,
        resolvedBy: args.deviceId,
        resolvedAt: new Date(),
        raisedAt: conflict.createdAt,
      },
    });

    await prisma.transactionConflict.delete({ where: { id: conflict.id } });
  }
}

/** Clear every open conflict for one transaction — used when the user resolves the whole entry at once. */
export async function clearConflicts(prisma: PrismaClient, transactionId: string): Promise<void> {
  await prisma.transactionConflict.deleteMany({ where: { transactionId } });
}
