import {
  createTransactionSchema,
  duplicateCheckResponseSchema,
  duplicateCheckSchema,
  summaryResponseSchema,
  transactionListResponseSchema,
  updateTransactionSchema,
  type Transaction as TransactionDto,
  type Currency,
  type TransactionKind,
} from "@libellum/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { PrismaClient } from "../db.js";
import {
  currentBookId,
  resolveCategoryId,
  resolvePaymentMethodId,
  resolveTagIds,
} from "../ledger/access.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface TransactionRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
}

/** Everything the list and detail views render, in one shape. */
const TRANSACTION_INCLUDE = {
  category: { select: { id: true, name: true, isSystem: true } },
  paymentMethod: { select: { id: true, name: true } },
  tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
} as const;

interface TransactionRow {
  id: string;
  kind: TransactionKind;
  amountCents: bigint;
  currency: string;
  categoryId: string;
  occurredAt: Date;
  occurredLocalDate: Date;
  occurredTz: string;
  note: string | null;
  version: number;
  category: { id: string; name: string; isSystem: boolean };
  paymentMethod: { id: string; name: string } | null;
  tags: { tag: { id: string; name: string; color: string } }[];
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * `@db.Date` columns come back as a Date at UTC midnight. Both directions are
 * explicit so a date can never drift by a day through an implicit time-zone
 * conversion — the whole point of storing the phone's local date.
 */
function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function fromDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function monthRange(month: string): { start: Date; end: Date } {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;

  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * Keyset pagination over `(occurredLocalDate, createdAt, id)`.
 *
 * Offset pagination would drift: inserting an entry while somebody is paging
 * shifts every later page and makes rows appear twice or not at all. A keyset
 * cursor points at one record, so pages stay stable.
 */
function encodeCursor(row: { occurredLocalDate: Date; createdAt: Date; id: string }): string {
  const payload = JSON.stringify({
    d: fromDateOnly(row.occurredLocalDate),
    c: row.createdAt.toISOString(),
    i: row.id,
  });

  return Buffer.from(payload, "utf8").toString("base64url");
}

function decodeCursor(raw: string): { d: string; c: string; i: string } {
  const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { d?: unknown }).d !== "string" ||
    typeof (parsed as { c?: unknown }).c !== "string" ||
    typeof (parsed as { i?: unknown }).i !== "string"
  ) {
    throw badRequest("cursor_invalid", "分页参数无效，请重新加载。");
  }

  const cursor = parsed as { d: string; c: string; i: string };
  return cursor;
}

function toDto(row: TransactionRow): TransactionDto {
  return {
    id: row.id,
    kind: row.kind,
    // Stored as bigint, handed out as a number: the amount ceiling in the
    // shared schema keeps every value inside the safe integer range.
    amountCents: Number(row.amountCents),
    // Every row is written through `createTransactionSchema`, which only accepts
    // the supported currencies, so the column cannot hold anything else.
    currency: row.currency as Currency,
    categoryId: row.categoryId,
    categoryName: row.category.name,
    categoryIsSystem: row.category.isSystem,
    paymentMethodId: row.paymentMethod?.id ?? null,
    paymentMethodName: row.paymentMethod?.name ?? null,
    occurredAt: row.occurredAt.toISOString(),
    occurredLocalDate: fromDateOnly(row.occurredLocalDate),
    occurredTz: row.occurredTz,
    note: row.note,
    tags: row.tags.map((link) => link.tag),
    version: row.version,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The wall-clock reading of an instant, on a named clock, as `HH:mm`.
 *
 * The stored pair for an entry is an absolute instant plus the time zone it was
 * recorded in, and "was this at 18:03?" is a question about the second one. The
 * answer is computed here rather than in SQL because `Intl` already knows every
 * zone rule, including daylight saving, and reimplementing that in a query is
 * how a duplicate check starts disagreeing with the form by an hour twice a year.
 *
 * Returns `""` when the instant is not a valid date, which can only happen if
 * something wrote a bad row directly — and "no time" is the honest reading of a
 * timestamp nobody can interpret.
 */
function wallClockIn(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) return "";

  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(instant);
  } catch {
    // An unknown zone name. UTC is not the user's clock, but a comparison that
    // throws would turn a warning into a failed save.
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(instant);
  }
}

export function registerTransactionRoutes(
  app: FastifyInstance,
  options: TransactionRouteOptions,
): void {
  const { prisma, requireAuth } = options;

  // -------------------------------------------------------------------------
  // POST /api/v1/transactions
  // -------------------------------------------------------------------------
  app.post("/api/v1/transactions", { preHandler: requireAuth }, async (request, reply) => {
    const body = createTransactionSchema.parse(request.body);
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);

    // Idempotency, first pass: a retried upload finds the entry it already
    // created and gets it back instead of a duplicate.
    const alreadyStored = await prisma.transaction.findUnique({
      where: { idempotencyKey: body.idempotencyKey },
      include: TRANSACTION_INCLUDE,
    });

    if (alreadyStored) {
      if (alreadyStored.bookId !== bookId) {
        throw conflict("idempotency_conflict", "该请求标识已被占用。");
      }

      reply.status(200);
      return toDto(alreadyStored);
    }

    const categoryId = await resolveCategoryId(prisma, bookId, body.kind, body.categoryId);
    const paymentMethodId = await resolvePaymentMethodId(prisma, bookId, body.paymentMethodId);
    const tagIds = await resolveTagIds(prisma, bookId, body.tagIds);

    const data = {
      id: body.id,
      bookId,
      userId,
      categoryId,
      paymentMethodId,
      kind: body.kind,
      amountCents: BigInt(body.amountCents),
      currency: body.currency,
      occurredAt: new Date(body.occurredAt),
      occurredLocalDate: toDateOnly(body.occurredLocalDate),
      occurredTz: body.occurredTz,
      note: body.note ?? null,
      idempotencyKey: body.idempotencyKey,
    };

    try {
      const created = await prisma.transaction.create({
        data: { ...data, tags: { create: tagIds.map((tagId) => ({ tagId })) } },
        include: TRANSACTION_INCLUDE,
      });

      reply.status(201);
      return toDto(created);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Idempotency, second pass: two identical requests raced, one of them
      // lost on the unique index. That is not a failure — return the winner.
      const winner = await prisma.transaction.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
        include: TRANSACTION_INCLUDE,
      });

      if (winner) {
        reply.status(200);
        return toDto(winner);
      }

      throw conflict("transaction_conflict", "该记账标识已被使用。");
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/transactions/duplicates
  // -------------------------------------------------------------------------
  /**
   * Is there already an entry like this one?
   *
   * Asked *before* writing, so the user gets to decide rather than being told
   * afterwards that something was recorded twice. The owner's definition —
   * date, time, amount, currency and kind all identical — is in the shared
   * schema, with the note about why the note is not compared.
   *
   * A POST rather than a GET because it carries five fields including an amount,
   * which does not belong in a URL: it would land in browser history, in server
   * access logs, and in any proxy in between.
   *
   * It answers with the matching entries rather than a count, because the
   * interface has to *show* them: "要删掉旧的" is one of the choices, and nobody
   * can sensibly choose which of two entries to delete without seeing both.
   */
  app.post("/api/v1/transactions/duplicates", { preHandler: requireAuth }, async (request) => {
    const body = duplicateCheckSchema.parse(request.body);
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);

    /**
     * The day's candidates, then the time compared on the entry's own clock.
     *
     * Two steps because the interesting comparison is a wall-clock one and the
     * clock is per row: `occurredAt` is an absolute instant and `occurredTz`
     * says which clock to read it on, so "was this at 18:03?" needs both. The
     * day narrows it first — that column is indexed — and a day's entries are
     * few, which is what makes a filter here honest rather than a shortcut.
     */
    const sameDay = await prisma.transaction.findMany({
      where: {
        bookId,
        deletedAt: null,
        kind: body.kind,
        amountCents: BigInt(body.amountCents),
        currency: body.currency,
        occurredLocalDate: toDateOnly(body.occurredLocalDate),
      },
      include: TRANSACTION_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    /**
     * An empty time means "no time recorded" — what the form sends when the
     * field is left alone — so it matches other entries that also have none,
     * rather than matching everything or nothing.
     */
    const duplicates = sameDay.filter((row) => {
      const wallClock = wallClockIn(row.occurredAt, row.occurredTz);

      return body.occurredTime === "" ? wallClock === "" : wallClock === body.occurredTime;
    });

    return duplicateCheckResponseSchema.parse({
      duplicates: duplicates.slice(0, 5).map((row) => toDto(row)),
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/transactions
  // -------------------------------------------------------------------------
  app.get("/api/v1/transactions", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);

    const query = request.query as Record<string, unknown>;
    const limitRaw = Number(readString(query["limit"]) ?? DEFAULT_PAGE_SIZE);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

    const month = readString(query["month"]);
    if (month && !MONTH_PATTERN.test(month)) {
      throw badRequest("month_invalid", "月份格式应为 YYYY-MM。");
    }

    const kind = readString(query["kind"]);
    if (kind && kind !== "income" && kind !== "expense") {
      throw badRequest("kind_invalid", "收支类型不正确。");
    }

    const where: Record<string, unknown> = { bookId, deletedAt: null };

    if (month) {
      const { start, end } = monthRange(month);
      where["occurredLocalDate"] = { gte: start, lt: end };
    }
    if (kind) where["kind"] = kind;
    if (readString(query["categoryId"])) where["categoryId"] = query["categoryId"];
    if (readString(query["paymentMethodId"])) where["paymentMethodId"] = query["paymentMethodId"];
    if (readString(query["currency"])) where["currency"] = query["currency"];
    if (readString(query["tagId"])) where["tags"] = { some: { tagId: query["tagId"] } };

    const search = readString(query["q"]);
    if (search) where["note"] = { contains: search, mode: "insensitive" };

    const cursorRaw = readString(query["cursor"]);
    if (cursorRaw) {
      const cursor = decodeCursor(cursorRaw);
      const d = toDateOnly(cursor.d);
      const c = new Date(cursor.c);

      // Strictly "older than the cursor", compared on the same three keys the
      // index is sorted by.
      where["OR"] = [
        { occurredLocalDate: { lt: d } },
        { occurredLocalDate: d, createdAt: { lt: c } },
        { occurredLocalDate: d, createdAt: c, id: { lt: cursor.i } },
      ];
    }

    // One extra row tells us whether another page exists without a count query.
    const rows = await prisma.transaction.findMany({
      where,
      include: TRANSACTION_INCLUDE,
      orderBy: [{ occurredLocalDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return transactionListResponseSchema.parse({
      items: page.map(toDto),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/summary
  // -------------------------------------------------------------------------
  app.get("/api/v1/summary", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);

    const query = request.query as Record<string, unknown>;
    const month = readString(query["month"]) ?? currentMonth();
    if (!MONTH_PATTERN.test(month)) {
      throw badRequest("month_invalid", "月份格式应为 YYYY-MM。");
    }

    const { start, end } = monthRange(month);

    // Grouped in the database rather than summed in JavaScript: the rows never
    // travel, and the totals come from the same integer column they describe.
    const grouped = await prisma.transaction.groupBy({
      by: ["currency", "kind"],
      where: { bookId, deletedAt: null, occurredLocalDate: { gte: start, lt: end } },
      _sum: { amountCents: true },
      _count: { _all: true },
    });

    const byCurrency = new Map<
      string,
      { expenseCents: number; incomeCents: number; expenseCount: number; incomeCount: number }
    >();

    for (const row of grouped) {
      const entry = byCurrency.get(row.currency) ?? {
        expenseCents: 0,
        incomeCents: 0,
        expenseCount: 0,
        incomeCount: 0,
      };

      const sum = Number(row._sum.amountCents ?? 0n);

      if (row.kind === "expense") {
        entry.expenseCents += sum;
        entry.expenseCount += row._count._all;
      } else {
        entry.incomeCents += sum;
        entry.incomeCount += row._count._all;
      }

      byCurrency.set(row.currency, entry);
    }

    const currencies = [...byCurrency.entries()]
      .map(([currency, entry]) => ({
        currency,
        ...entry,
        balanceCents: entry.incomeCents - entry.expenseCents,
        // Ranked by how much money moved through this currency, ignoring the
        // direction: 1000 spent and 500 earned is 1500 of activity.
        volumeCents: entry.expenseCents + entry.incomeCents,
      }))
      .sort((a, b) => b.volumeCents - a.volumeCents);

    return summaryResponseSchema.parse({ month, currencies });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/transactions/:id
  // -------------------------------------------------------------------------
  app.get("/api/v1/transactions/:id", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);
    const { id } = request.params as { id: string };

    const row = await prisma.transaction.findFirst({
      where: { id, bookId, deletedAt: null },
      include: TRANSACTION_INCLUDE,
    });

    if (!row) throw notFound("transaction_missing", "找不到这笔记账。");

    return toDto(row);
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/transactions/:id
  // -------------------------------------------------------------------------
  app.patch("/api/v1/transactions/:id", { preHandler: requireAuth }, async (request) => {
    const body = updateTransactionSchema.parse(request.body);
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);
    const { id } = request.params as { id: string };

    const existing = await prisma.transaction.findFirst({
      where: { id, bookId, deletedAt: null },
      select: { id: true, version: true, kind: true },
    });

    if (!existing) throw notFound("transaction_missing", "找不到这笔记账。");

    // Optimistic lock: if somebody else changed this entry since the client
    // loaded it, refuse rather than silently overwrite their edit.
    if (body.version !== existing.version) {
      throw conflict("version_conflict", "这笔记账已被修改，请刷新后重试。");
    }

    const kind = body.kind ?? existing.kind;

    const data: Record<string, unknown> = { version: existing.version + 1 };

    if (body.kind !== undefined) data["kind"] = body.kind;
    if (body.amountCents !== undefined) data["amountCents"] = BigInt(body.amountCents);
    if (body.currency !== undefined) data["currency"] = body.currency;
    if (body.occurredAt !== undefined) data["occurredAt"] = new Date(body.occurredAt);
    if (body.occurredLocalDate !== undefined) {
      data["occurredLocalDate"] = toDateOnly(body.occurredLocalDate);
    }
    if (body.occurredTz !== undefined) data["occurredTz"] = body.occurredTz;
    if (body.note !== undefined) data["note"] = body.note ?? null;

    // Changing the kind means the old category no longer belongs; re-resolve.
    if (body.categoryId !== undefined || body.kind !== undefined) {
      data["categoryId"] = await resolveCategoryId(prisma, bookId, kind, body.categoryId ?? null);
    }
    if (body.paymentMethodId !== undefined) {
      data["paymentMethodId"] = await resolvePaymentMethodId(prisma, bookId, body.paymentMethodId);
    }

    if (body.tagIds !== undefined) {
      const tagIds = await resolveTagIds(prisma, bookId, body.tagIds);
      data["tags"] = { deleteMany: {}, create: tagIds.map((tagId) => ({ tagId })) };
    }

    const updated = await prisma.transaction.update({
      where: { id },
      data,
      include: TRANSACTION_INCLUDE,
    });

    return toDto(updated);
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/transactions/:id
  // -------------------------------------------------------------------------
  app.delete("/api/v1/transactions/:id", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);
    const { id } = request.params as { id: string };

    const existing = await prisma.transaction.findFirst({
      where: { id, bookId, deletedAt: null },
      select: { version: true },
    });

    if (!existing) throw notFound("transaction_missing", "找不到这笔记账。");

    // A tombstone, never a real delete: an offline device that still holds this
    // entry must be able to learn that it is gone, instead of re-uploading it.
    await prisma.transaction.update({
      where: { id },
      data: { deletedAt: new Date(), version: existing.version + 1 },
    });

    reply.status(204);
    return null;
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/transactions/:id/restore
  // -------------------------------------------------------------------------
  /**
   * Un-delete.
   *
   * The other half of "delete with undo": because removal is a tombstone rather
   * than a real delete, undoing it restores the *same* row with the same id —
   * not a copy. Anything already synchronised stays consistent.
   */
  app.post("/api/v1/transactions/:id/restore", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);
    const { id } = request.params as { id: string };

    // Note: no `deletedAt: null` filter here — a deleted row is exactly what
    // this endpoint is looking for.
    const existing = await prisma.transaction.findFirst({
      where: { id, bookId },
      select: { id: true, version: true, deletedAt: true },
    });

    if (!existing) throw notFound("transaction_missing", "找不到这笔记账。");

    if (existing.deletedAt === null) {
      throw conflict("transaction_not_deleted", "这笔记账没有被删除。");
    }

    const restored = await prisma.transaction.update({
      where: { id },
      data: { deletedAt: null, version: existing.version + 1 },
      include: TRANSACTION_INCLUDE,
    });

    return toDto(restored);
  });
}
