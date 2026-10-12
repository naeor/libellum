import type { PrismaClient } from "../db.js";
import { trackedFieldLabel } from "./events.js";

/**
 * Reading the ledger's history back, in words a person reads.
 *
 * ⚠️ **The sentence is built here, not on the client.** The owner's example lines are the spec —
 * *"今天 14:32，naeor 将 #000128 午餐的金额从 ¥35 修改为 ¥38."* — and putting that wording in the
 * browser would mean **a second place that decides what a change is called.** The API already knows
 * which fields were tracked (`TRACKED_FIELDS`); the screen should not have to learn it too
 * (`教训.md` §8.12).
 *
 * ⚠️ **No relative time ("今天") is produced here.** "Today" depends on the reader's clock and
 * changes while the page is open — the API returns the instant and the screen decides how to say
 * it. **A server that computes "今天" is a server that is wrong for somebody in another zone**, and
 * this ledger already has an explicit `occurredTz` for exactly this reason.
 */

export interface HistoryEntry {
  readonly id: string;
  readonly kind: "created" | "updated" | "deleted" | "restored" | "member_changed";
  readonly occurredAt: string;
  readonly actorName: string | null;
  readonly transactionId: string | null;
  readonly transactionSeq: number | null;
  /** ⚠️ Already formatted, so every reader of this API shows the same thing. */
  readonly summary: string;
  /** One line per changed field, ready to render. Empty for anything but an edit. */
  readonly changes: readonly { readonly label: string; readonly from: string; readonly to: string }[];
}

const KIND_VERB: Record<HistoryEntry["kind"], string> = {
  created: "添加了",
  updated: "修改了",
  deleted: "删除了",
  restored: "恢复了",
  member_changed: "变更了成员",
};

export async function readHistory(
  prisma: PrismaClient,
  bookId: string,
  limit: number,
): Promise<HistoryEntry[]> {
  const rows = await prisma.transactionEvent.findMany({
    where: { bookId },
    orderBy: { occurredAt: "desc" },
    take: limit,
    select: {
      id: true,
      kind: true,
      occurredAt: true,
      actorName: true,
      transactionId: true,
      transactionSeq: true,
      changes: true,
      transaction: { select: { note: true, category: { select: { name: true } } } },
    },
  });

  return rows.map((row) => {
    const kind = row.kind as HistoryEntry["kind"];
    const who = row.actorName ?? "某人";
    const number = row.transactionSeq === null ? null : `#${String(row.transactionSeq).padStart(6, "0")}`;

    /**
     * ⚠️ **When the entry is gone, the event still names it.** A deleted entry cannot be asked for
     * its note or category, so the sentence falls back to the number alone — **which is precisely
     * why the number is stored on the event** (`教训.md` §8.11 is about the version of this where
     * the join quietly returns nothing).
     */
    const label = row.transaction?.note ?? row.transaction?.category.name ?? null;
    const subject = number === null ? "一笔账目" : label === null ? `记录 ${number}` : `${number} ${label}`;

    const changes = (row.changes ?? {}) as Record<string, { from?: unknown; to?: unknown }>;

    return {
      id: row.id,
      kind,
      occurredAt: row.occurredAt.toISOString(),
      actorName: row.actorName,
      transactionId: row.transactionId,
      transactionSeq: row.transactionSeq,
      summary: `${who} ${KIND_VERB[kind]} ${subject}`,
      /**
       * ⚠️ **Rendered with the field's Chinese name**, because "amountCents 3500 → 3800" is a
       * developer's sentence. `trackedFieldLabel` is the same table the diff used, so a field that
       * is tracked but unnamed cannot appear here at all — **it would show its column name.**
       */
      changes: Object.entries(changes).map(([key, value]) => ({
        label: trackedFieldLabel(key) ?? key,
        from: renderValue(value?.from),
        to: renderValue(value?.to),
      })),
    };
  });
}

/**
 * A changed value as a person reads it.
 *
 * ⚠️ **Money is not converted here, deliberately.** `amountCents` is stored in minor units and the
 * currency's precision lives in `shared`; formatting it in this module would be a second
 * implementation of the money rule — **and the one place people check by hand is the one that must
 * not be wrong.** The client already has `formatMoney`; it renders the number it is given.
 *
 * ⚠️ So this returns the raw minor-unit number **as a string**, and the screen decides. A value that
 * is already a string (a note, a currency code) is passed through unchanged.
 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "（空）";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "（无法显示）";
}
