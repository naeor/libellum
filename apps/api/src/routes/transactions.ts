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
import {
  appendHistory,
  asArray,
  CONFLICT_FIELDS,
  judge,
  openConflicts,
  raiseConflict,
  settleConflicts,
  valuesSeen,
  type ConflictField,
} from "../lib/conflicts.js";
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

/** Which device is speaking. */
function deviceIdFrom(request: FastifyRequest): string {
  const header = request.headers["x-libellum-device"];

  return typeof header === "string" && header.length > 0 ? header.slice(0, 64) : "unknown-device";
}

/**
 * One field's current value on a row, in the shape the conflict rules compare.
 *
 * ⚠️ **The row's own shape, not the DTO's.** `amountCents` is a bigint here and a number there, and comparing a
 * bigint against the number a device sent would call every amount a conflict — **a mistake that would make the
 * yellow mark appear on every single edit.**
 */
function currentFieldValue(row: TransactionRow, field: ConflictField): unknown {
  if (field === "amountCents") return Number(row.amountCents);
  if (field === "tagIds") return row.tags.map((link) => link.tag.id);

  return (row as unknown as Record<string, unknown>)[field];
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
      include: TRANSACTION_INCLUDE,
    });

    if (!existing) throw notFound("transaction_missing", "找不到这笔记账。");

    /**
     * ⚠️ **The conflict decision, and it replaces a bare version check.**
     *
     * The old rule refused whenever the versions differed — **which cannot tell "somebody else changed a
     * different field" from "somebody else changed this one"**, and could not apply the owner's rule that a
     * device which merely fell behind should be brought up to date silently:
     *
     * > **"只有在服务器的数值是 C，而某台设备上传的请求是把数字从 A 改成 B 时才会触发冲突机制."**
     *
     * ⚠️ **The device sends the *chain* of values it passed through while offline** — "设备本地在恢复网络上传
     * 时要把从断网开始的每一步改动都上传" — so `base` is the chain's first link and `wanted` is its last, **and
     * the ones in between go into the history**, which is what lets a later device recognise a value the server
     * has already held.
     *
     * ⚠️ **A field decides its own fate.** Two devices that changed different fields both keep their work, and
     * only the field they both changed becomes a question.
     */
    const changes = body.changes ?? [];

    /**
     * The fields the verdict says the server should move to the device's value.
     *
     * ⚠️ **Only a settled conflict puts anything in here.** There is no longer an "accept" verdict: **every non-conflict
     * outcome keeps the server's value and asks nothing** — "没有冲突是一律以服务器为准" — so **a plain edit writes
     * the field it names, and a field the verdict declined to move is not written at all.**
     */
    const settledFields: Record<string, unknown> = {};

    for (const change of changes) {
      const field = change.field as ConflictField;

      if (!CONFLICT_FIELDS.includes(field)) continue;

      const verdict = judge(
        field,
        change.base,
        change.wanted,
        currentFieldValue(existing, field),
        /**
         * ⚠️ **The history goes in, and without it the "it merely fell behind" rule can never fire** — a value the
         * server has held before means the device is catching up rather than disagreeing, **and settling those
         * automatically is what keeps the yellow mark meaning "somebody has to decide."**
         *
         * ⚠️ **No version number is passed, because the decision is not about versions.** The owner had already ruled
         * that out; an earlier version of this call passed them, **and the shortcut built on them disabled the whole
         * feature.**
         */
        valuesSeen(asArray(existing.valueHistory), field, currentFieldValue(existing, field)),
      );

      /**
       * ⚠️ **Rule 1 of the judgement: the device is editing the value it just read, so this is an ordinary edit and
       * the device's value is written.** There is nothing to ask about — **and nothing to compare, either.**
       */
      if (verdict.kind === "accept") {
        settledFields[field] = change.wanted;
        continue;
      }

      /**
       * ⚠️ **The server's value stands and nothing is written for this field** — the owner's rule, applied silently.
       * It is not sent as a change, so the next read of this entry hands the device the server's value.
       */
      if (verdict.kind === "server-wins") continue;

      await raiseConflict(prisma, {
        transactionId: id,
        bookId,
        field,
        serverValue: verdict.serverValue,
        claim: {
          deviceId: deviceIdFrom(request),
          chain: change.chain,
          at: new Date().toISOString(),
        },
        history: valuesSeen(asArray(existing.valueHistory), field, currentFieldValue(existing, field)),
      });
    }

    /**
     * ⚠️ **A conflict is reported with the server's copy and with the conflicts themselves**, so the client can
     * show the user which fields are in question **without a second request that would race** — the row can
     * change again between the refusal and a follow-up read.
     */
    const raised = await openConflicts(prisma, bookId).then((rows) =>
      rows.filter((row) => row.transactionId === id),
    );

    if (raised.length > 0) {
      throw conflict("version_conflict", "这笔记账在别处被改过。", {
        current: toDto(existing),
        conflicts: raised.map((row) => ({
          field: row.field,
          serverValue: row.serverValue,
          claims: row.claims,
          history: row.history,
        })),
      });
    }

    const kind = body.kind ?? existing.kind;

    const data: Record<string, unknown> = { version: existing.version + 1 };

    /**
     * ⚠️ **Only what the judgement said to write is written, and this is the half that used to be missing.**
     *
     * The body carries **what the device wanted** for every field it sent, and writing it unconditionally meant **a
     * verdict of "the server's value stands" was followed by the server storing the device's value anyway** — the
     * device's edit won while the judgement said it should not, **and the other device's work was lost with the
     * judgement appearing to have approved it.**
     *
     * ⚠️ **`settledFields` is exactly the fields the judgement accepted**, so it is the whole picture for the fields
     * the judgement decides. **A settled conflict is the same shape**: the user's choice is the value to write, and
     * it is the one thing in the request that is not in dispute.
     */
    const write: Record<string, unknown> = { ...settledFields };

    if (write["kind"] !== undefined) data["kind"] = write["kind"];
    if (write["amountCents"] !== undefined) data["amountCents"] = BigInt(Number(write["amountCents"]));
    if (write["currency"] !== undefined) data["currency"] = write["currency"];
    if (write["occurredAt"] !== undefined) data["occurredAt"] = new Date(String(write["occurredAt"]));
    if (write["note"] !== undefined) data["note"] = write["note"] ?? null;

    /**
     * ⚠️ **The local date and time zone travel with the instant**, and they are written whenever `occurredAt` is —
     * otherwise the row would carry a new instant next to the old date and zone, **and the ledger would file it
     * under the wrong day.**
     */
    if (write["occurredAt"] !== undefined) {
      if (body.occurredLocalDate !== undefined) data["occurredLocalDate"] = toDateOnly(body.occurredLocalDate);
      if (body.occurredTz !== undefined) data["occurredTz"] = body.occurredTz;
    }

    /**
     * ⚠️ **The kind decides whether the old category still belongs**, so it is re-resolved whenever the kind is
     * written for any reason — **including when a settled conflict changed it.**
     */
    if (data["kind"] !== undefined || write["categoryId"] !== undefined) {
      data["categoryId"] = await resolveCategoryId(prisma, bookId, kind, body.categoryId ?? null);
    }
    if (write["paymentMethodId"] !== undefined) {
      data["paymentMethodId"] = await resolvePaymentMethodId(prisma, bookId, body.paymentMethodId);
    }

    if (write["tagIds"] !== undefined) {
      const tagIds = await resolveTagIds(prisma, bookId, body.tagIds ?? []);
      data["tags"] = { deleteMany: {}, create: tagIds.map((tagId) => ({ tagId })) };
    }

    /**
     * ⚠️ **What this change actually altered, recorded so a later device can recognise it.** The chain's middle
     * links are included even though the final value is what gets stored — **they are states the entry really
     * passed through, and "the server has held this value" is the question a future conflict asks.**
     */
    /**
     * ⚠️ **The fields this write actually moved — and nothing else, because the history is what future judgements
     * read.**
     *
     * It used to include `change.wanted` for **every** field the device sent, **including fields the verdict declined
     * to move** — so a write that changed nothing still recorded the device's rejected value as something the server
     * had held, **and a later device comparing against it would be told it was a legitimate path.**
     */
    const movedFields = new Set(Object.keys(write));

    const touched: Record<string, unknown> = {};

    for (const change of changes) {
      if (movedFields.has(change.field)) touched[change.field] = write[change.field];
    }

    if (Object.keys(touched).length > 0) {
      data["valueHistory"] = appendHistory(
        asArray(existing.valueHistory),
        existing.version + 1,
        touched,
        deviceIdFrom(request),
      ) as unknown;
    }

    /**
     * ⚠️ **If the device settled a conflict with this change, every open question about this entry is closed** —
     * "如果用户已经对这个冲突做了一次确认…此时没必要让用户在别的设备上再肯定一次." The permanent record is
     * written first, so the decision never exists only in a row about to be deleted.
     */
    if (body.settlesConflict === true) {
      await settleConflicts(prisma, {
        transactionId: id,
        bookId,
        deviceId: deviceIdFrom(request),
        settled: settledFields,
      });
    }

    const updated = await prisma.transaction.update({
      where: { id },
      data,
      include: TRANSACTION_INCLUDE,
    });

    return toDto(updated);
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/conflicts/resolve-with-server
  // -------------------------------------------------------------------------
  /**
   * Settle every open conflict by taking the server's value.
   *
   * ⚠️ **This is what the owner decided "clear the marks" means**: "清空印记就意味着不选了使用服务器当前的值，
   * 在清空印记时给服务器留一条消息，联网时发出内容大概就是告诉服务器，这个冲突已经解决了，使用服务器当前的值."
   *
   * ⚠️ **It has to reach the server, and that is the whole point.** Clearing only the local marks left the raised
   * rows in place, **so the next pull handed the same questions back** — which is exactly what he hit: the row
   * stayed yellow however many times he cleared it.
   *
   * ⚠️ **The permanent record is written for every one of them**, so "why did this entry change by itself" has an
   * answer: **the user chose to defer to the server, and that is a decision, not an absence of one.**
   */
  app.post("/api/v1/conflicts/resolve-with-server", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);
    const device = deviceIdFrom(request);

    const open = await openConflicts(prisma, bookId);
    const byTransaction = new Map<string, typeof open>();

    for (const row of open) {
      byTransaction.set(row.transactionId, [...(byTransaction.get(row.transactionId) ?? []), row]);
    }

    for (const [transactionId, rows] of byTransaction) {
      /**
       * ⚠️ **The server's value for each field is what gets recorded as the resolution** — the rows carry it, and
       * it is what every device will already be showing after the next fetch. **Nothing is written to the entry
       * itself**, because the server's value is what it holds and the device is the one that has to catch up.
       */
      const settled: Record<string, unknown> = {};

      for (const row of rows) settled[row.field] = row.serverValue;

      await settleConflicts(prisma, { transactionId, bookId, deviceId: device, settled });
    }


    return { resolved: byTransaction.size };
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/conflicts
  // -------------------------------------------------------------------------
  /**
   * ⚠️ **Every device asks this whenever it acts**, and that is how a conflict raised on one device reaches the
   * others: "任何一台设备触发服务器同步——也就是登录；修改了某个账单；从离线恢复到在线；或者点击刷新时，服务器
   * 会立刻跟所有账号的本地记录来一次大核对."
   *
   * ⚠️ **There is no push channel, and the owner accepted that**: "假设有两台设备 A 跟 B；服务器对某个事件标黄时
   * B 设备选择把这个值改成 X，那在 A 触发服务器同步时直接把这个值也改成 X 就行."
   *
   * ⚠️ **Raised conflicts live on the server, so a device that was offline when the decision was made simply
   * finds nothing here** — "如果用户已经对这个冲突做了一次确认…此时没必要让用户在别的设备上再肯定一次."
   */
  app.get("/api/v1/conflicts", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);

    const rows = await openConflicts(prisma, bookId);
    const ids = [...new Set(rows.map((row) => row.transactionId))];

    const rowsById = new Map(rows.map((row) => [row.id, row]));

    /**
     * ⚠️ **The server's own copy goes out with the list, and without it the question has no sides.**
     *
     * The client was filling both "mine" and "theirs" with the entry it already held, so comparing them found
     * nothing to disagree about — **and the owner reached a yellow row whose screen offered no fields at all**:
     * "他居然显示没有需要自动合并的字段，同时需要我选的地方是 0 处；我只能选择用这个结果保存."
     */
    const entries = await prisma.transaction.findMany({
      where: { id: { in: ids }, bookId },
      include: TRANSACTION_INCLUDE,
    });

    const entryById = new Map(entries.map((entry) => [entry.id, entry]));

    return {
      conflicts: ids.map((transactionId) => ({
        transactionId,
        /** ⚠️ What the server holds **now** — the side the user is choosing against. */
        current: entryById.has(transactionId) ? toDto(entryById.get(transactionId)!) : null,
        fields: rows
          .filter((row) => row.transactionId === transactionId)
          .map((row) => ({
            field: row.field,
            serverValue: row.serverValue,
            claims: row.claims,
            history: row.history,
            raisedAt: rowsById.get(row.id)?.createdAt.toISOString() ?? null,
          })),
      })),
    };
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
