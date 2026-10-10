import { decimalsFor } from "@libellum/shared";

import type { PrismaClient } from "../db.js";

/**
 * Read the rows an export needs, a batch at a time.
 *
 * The owner's requirement was explicit and is the reason this is a generator
 * rather than one `findMany`: **never read the whole ledger into memory for a
 * single click**, and **never silently truncate**. So the caller sets a limit,
 * each batch is bounded, and going over the limit is an error the user is told
 * about rather than a shorter file they are not.
 *
 * The pagination key is the same three columns the list screen already pages by
 * — `(occurred_local_date, created_at, id)` descending — which the existing
 * index covers, so a large export walks an index instead of sorting a table.
 */

export interface ExportFilters {
  /** Inclusive `YYYY-MM-DD` bounds on the entry's own local date. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly kind?: "income" | "expense" | undefined;
  readonly categoryId?: string | undefined;
  readonly paymentMethodId?: string | undefined;
  readonly tagId?: string | undefined;
  readonly currency?: string | undefined;
}

export interface ExportRow {
  readonly id: string;
  /** `YYYY-MM-DD`, the phone's own calendar date. */
  readonly occurredLocalDate: string;
  /** `HH:mm`, in the zone the entry was recorded in. */
  readonly occurredTime: string;
  readonly occurredTz: string;
  readonly kind: "income" | "expense";
  /** A number, because a spreadsheet must be able to sum it. */
  readonly amount: number;
  readonly currency: string;
  readonly categoryName: string;
  readonly paymentMethodName: string | null;
  readonly note: string | null;
  readonly tagNames: readonly string[];
  /** `YYYY-MM-DD HH:mm:ss` on the server's clock — when the row was created. */
  readonly createdAt: string;
  readonly sourceRef: string | null;
}

const BATCH_SIZE = 500;

function toDateOnly(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

/** `HH:mm` in the zone the entry was recorded in, falling back to the stored instant. */
function timeInZone(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(instant);
  } catch {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }).format(instant);
  }
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Count how many entries match, without reading them.
 *
 * A separate `count` rather than "read until the counter trips": the count that
 * decides whether the export is allowed to run must be exact, and finding out
 * "there are more than the limit" is not the same as knowing how many.
 */
export async function countExportRows(
  prisma: PrismaClient,
  bookId: string,
  filters: ExportFilters,
): Promise<number> {
  return prisma.transaction.count({ where: buildWhere(bookId, filters) });
}

function buildWhere(bookId: string, filters: ExportFilters): Record<string, unknown> {
  const where: Record<string, unknown> = { bookId, deletedAt: null };

  if (filters.from !== undefined || filters.to !== undefined) {
    where["occurredLocalDate"] = {
      ...(filters.from === undefined ? {} : { gte: new Date(`${filters.from}T00:00:00Z`) }),
      ...(filters.to === undefined ? {} : { lte: new Date(`${filters.to}T00:00:00Z`) }),
    };
  }

  if (filters.kind !== undefined) where["kind"] = filters.kind;
  if (filters.categoryId !== undefined) where["categoryId"] = filters.categoryId;
  if (filters.paymentMethodId !== undefined) where["paymentMethodId"] = filters.paymentMethodId;
  if (filters.currency !== undefined) where["currency"] = filters.currency;
  if (filters.tagId !== undefined) where["tags"] = { some: { tagId: filters.tagId } };

  return where;
}

/** The fields the file needs, and nothing else. */
const SELECT = {
  id: true,
  occurredAt: true,
  occurredLocalDate: true,
  occurredTz: true,
  kind: true,
  amountCents: true,
  currency: true,
  note: true,
  createdAt: true,
  sourceRef: true,
  category: { select: { name: true } },
  paymentMethod: { select: { name: true } },
  tags: { select: { tag: { select: { name: true } } } },
} as const;

/**
 * Yield export rows in batches, newest first.
 *
 * A generator, so the route can stream into a buffer or a writer without ever
 * holding the whole result set. `BATCH_SIZE` keeps each query's memory bounded;
 * the caller's limit keeps the number of batches bounded.
 */
export async function* iterateExportRows(
  prisma: PrismaClient,
  bookId: string,
  filters: ExportFilters,
): AsyncGenerator<ExportRow> {
  let cursor: { occurredLocalDate: Date; createdAt: Date; id: string } | null = null;

  for (;;) {
    const where: Record<string, unknown> = buildWhere(bookId, filters);

    if (cursor !== null) {
      where["OR"] = [
        { occurredLocalDate: { lt: cursor.occurredLocalDate } },
        { occurredLocalDate: cursor.occurredLocalDate, createdAt: { lt: cursor.createdAt } },
        {
          occurredLocalDate: cursor.occurredLocalDate,
          createdAt: cursor.createdAt,
          id: { lt: cursor.id },
        },
      ];
    }

    const rows = await prisma.transaction.findMany({
      where,
      select: SELECT,
      orderBy: [{ occurredLocalDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: BATCH_SIZE,
    });

    if (rows.length === 0) return;

    for (const row of rows) {
      yield {
        id: row.id,
        occurredLocalDate: toDateOnly(row.occurredLocalDate).toISOString().slice(0, 10),
        occurredTime: timeInZone(row.occurredAt, row.occurredTz),
        occurredTz: row.occurredTz,
        kind: row.kind,
        // Minor units to whole units **using the currency's own precision**.
        // `money.ts` states the rule at the top of the file: ¥1000 is stored as
        // `1000`, not `100000`. Dividing by a fixed hundred turned a ¥800 entry
        // into 8 — an error of two orders of magnitude, in the one place a user
        // checks the numbers by hand.
        amount: Number(row.amountCents) / 10 ** decimalsFor(row.currency),
        currency: row.currency,
        categoryName: row.category.name,
        paymentMethodName: row.paymentMethod?.name ?? null,
        note: row.note,
        tagNames: row.tags.map((link) => link.tag.name),
        createdAt: `${row.createdAt.toISOString().slice(0, 10)} ${twoDigits(row.createdAt.getUTCHours())}:${twoDigits(row.createdAt.getUTCMinutes())}:${twoDigits(row.createdAt.getUTCSeconds())}`,
        sourceRef: row.sourceRef,
      };
    }

    const last = rows.at(-1);
    if (last === undefined) return;

    cursor = {
      occurredLocalDate: toDateOnly(last.occurredLocalDate),
      createdAt: last.createdAt,
      id: last.id,
    };
  }
}
