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
  /** ⚠️ **The device is editing from the value the server holds** — an ordinary online edit, and it is written. */
  | { readonly kind: "accept" }
  /** ⚠️ The server's value stands and nothing is asked. **This is the owner's "以服务器为准".** */
  | { readonly kind: "server-wins" }
  /** ⚠️ Two decisions from one starting point. **This is the only case the user is asked about.** */
  | { readonly kind: "conflict"; readonly serverValue: unknown };

/**
 * Decide what to do about one field a device is changing.
 *
 * ⚠️ **There is no version number in here, and that is deliberate.** An earlier version opened with
 * `baseVersion >= serverVersion → accept`, and the owner had already rejected version numbers as the basis for this
 * decision — **the idea survived inside the code and quietly disabled the whole feature**, because a device's
 * version is its own entry's, incremented locally, and it frequently lands on the same number as the server's.
 *
 * **The judgement is about values, so this function is about values.** Four rules, in order:
 *
 * | Rule | Meaning | Outcome |
 * |---|---|---|
 * | **`base == 服务器当前值`** | the device is editing what it just read | ✅ **accept — write it** |
 * | **`wanted == 服务器当前值`** | both sides want the same thing | ✅ server-wins |
 * | **`wanted` 在历史里** | the device is heading for a place the server already passed through | ✅ server-wins |
 * | anything else | the device wants somewhere the server has never been | ⚠️ **conflict** |
 *
 * ⚠️ **The first rule is the ordinary online edit, and it is what makes an online device unable to conflict**: the
 * owner's rule is triggered by `服务器 == C` while the device goes `A → B`, and **here the server *is* A.**
 *
 * ⚠️ **The second rule is his own example**, and the reason it is checked before anything else:
 *
 * > **"假如服务器上记录的数据是从 40 改到 60，而设备上记录的数据是从 30 改到 60，那么他们的目的一样，当然不能算
 * > ——我想没有哪个程序会弹出一个弹窗让人选择数字是 60 还是 60."**
 *
 * ⚠️ **The third rule is his answer for a device that is behind**, and his words name the test exactly:
 *
 * > **"如果服务器里记录的是从 30 变成 50 再变成 70，那么 30 和 50 就是历史值——如果本地的数据恰好是 30 或者 50，
 * > 那么在同步时不用判断冲突，直接改为 70."**
 *
 * ⚠️ **And his reason for putting the destination in the history rather than the starting value** — asked directly,
 * about a device sitting at 30 that wants 65 while the server is at 70:
 *
 * > **"判冲突，因为设备是想把 30 改成 65，而不是把 30 改成 70；同时 65（最终值）并不在 30，50 这些服务器历史值里，
 * > 所以不能说设备改的 65 是已有的路径（也就是只改了一半）."**
 *
 * **A device heading for a value the server has already held is finishing a journey that was already under way.**
 * A device heading anywhere else is making a new decision — **and two decisions from one starting point is the only
 * thing the user is ever asked about.**
 */
export function judge(
  field: ConflictField,
  /** The device's starting value — the owner calls it a 历史值. */
  base: unknown,
  /** What the device wants the field to become. */
  wanted: unknown,
  /** What the server holds right now. */
  serverValue: unknown,
  /**
   * Every value the server has held, **including the one it holds now** (`valuesSeen` appends it).
   */
  history: readonly unknown[] = [],
): Verdict {
  /**
   * ⚠️ **Rule 1 — the device is editing the value it just read, so this is an ordinary edit.** This is what the
   * owner's rule leaves untouched: it fires when the server holds something *other* than what the device read.
   */
  if (same(field, base, serverValue)) return { kind: "accept" };

  /**
   * ⚠️ **Rule 2 — both sides want the same thing, so there is nothing to ask.** **"我想没有哪个程序会弹出一个弹窗让
   * 人选择数字是 60 还是 60."**
   */
  if (same(field, wanted, serverValue)) return { kind: "server-wins" };

  /**
   * ⚠️ **Rule 3 — the device is heading for a value the server has already held, so it is behind, not opposing it.**
   * Nothing is asked and nothing is overwritten in the other direction: **"直接改为 70."**
   */
  if (history.some((value) => same(field, value, wanted))) return { kind: "server-wins" };

  /**
   * ⚠️ **Rule 4 — the device wants somewhere the server has never been.** Both sides moved from one starting point
   * toward different places, **and only the user can say which was meant.**
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
