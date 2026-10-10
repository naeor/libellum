import {
  EXPORT_COLUMNS,
  MAX_EXPORT_ROWS,
  TEMPLATE_COLUMN_KEYS,
  csvRow,
  csvRowEscaped,
  exportQuerySchema,
  newExportRef,
} from "@libellum/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { PrismaClient } from "../db.js";
import { buildXlsx } from "../export/xlsx.js";
import { badRequest } from "../lib/errors.js";
import { currentBookId } from "../ledger/access.js";
import {
  countExportRows,
  iterateExportRows,
  type ExportFilters,
  type ExportRow,
} from "../ledger/export-query.js";

/**
 * Export the ledger as a file.
 *
 * Six decisions are load-bearing here, and each cost something to work out:
 *
 * **UTF-8 BOM on CSV.** Without it Excel reads the file as the system code page
 * and every Chinese heading arrives as mojibake.
 *
 * **Formula characters are escaped in text columns only** — see
 * `@libellum/shared/spreadsheet`. A note beginning `=` is a note until a
 * spreadsheet decides it is a formula.
 *
 * **Amounts are numbers, and expenses are negative.** Numbers, because a column
 * of text cannot be summed; signed, because a ledger whose income and expenses
 * are both positive needs a formula to mean anything.
 *
 * **Over the limit is an error, never a shorter file.** The owner put it plainly:
 * a file that looks complete and is not is worse than an error message.
 *
 * **The `Out-…` reference goes in the response headers, not just the file.** The
 * browser needs it to name the file and to tell the user something quotable;
 * `export_logs` keeps it so a later question ("that file I exported") can be
 * matched to this run.
 *
 * **Nothing about the contents is stored.** The audit row records who, when, what
 * range, how many and which format — never the rows, never the file.
 */

interface ExportRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
  /** How long the browser may cache the query token before re-fetching. */
  readonly fileBaseUrl?: string;
}

/** `2026-10` boundaries, expanded to date literals. */
function monthBounds(month: string): { start: string; end: string } {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();

  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, "0")}` };
}

function combineBounds(query: ReturnType<typeof exportQuerySchema.parse>): ExportFilters {
  let from = query.from;
  let to = query.to;

  if (query.monthFrom !== undefined) {
    const bounds = monthBounds(query.monthFrom);
    from = from === undefined || bounds.start > from ? bounds.start : from;
  }
  if (query.monthTo !== undefined) {
    const bounds = monthBounds(query.monthTo);
    to = to === undefined || bounds.end < to ? bounds.end : to;
  }

  return {
    from,
    to,
    kind: query.kind,
    categoryId: query.categoryId,
    paymentMethodId: query.paymentMethodId,
    tagId: query.tagId,
    currency: query.currency,
  };
}

/**
 * Columns whose values come from the user and are therefore escaped.
 *
 * Everything except 金额, which is written as a bare number: escaping a number
 * turns it into text and breaks the one thing a spreadsheet export is for. Note
 * that 时间, 日期, 币种 and the reference columns are ours, not the user's — they
 * cannot begin with a formula character — but listing them is harmless and means
 * the rule is "these are text" rather than "these are suspect".
 */
const TEXT_COLUMNS: readonly number[] = EXPORT_COLUMNS.map((column, index) => ({ column, index }))
  .filter(({ column }) => column.key !== "amount")
  .map(({ index }) => index);

/** A filename that survives both old and new browsers. */
function contentDisposition(fileName: string): string {
  // RFC 5987: `filename*` carries the real name in UTF-8; plain `filename` is an
  // ASCII fallback for anything that does not understand it.
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * The cell values for one row, in column order.
 *
 * `exportRef` is passed in rather than read per row because it is identical for
 * every row of one export — that is what makes "this file came from that run"
 * answerable by looking at a single cell.
 */
function rowValues(row: ExportRow, exportRef: string): (string | number)[] {
  return EXPORT_COLUMNS.map((column) => {
    switch (column.key) {
      case "occurredLocalDate":
        return row.occurredLocalDate;
      case "occurredTime":
        return row.occurredTime;
      case "occurredTz":
        return row.occurredTz;
      case "kind":
        return row.kind === "expense" ? "支出" : "收入";
      case "amount":
        // Expenses are negative so a spreadsheet's own SUM is meaningful.
        return row.kind === "expense" ? -row.amount : row.amount;
      case "currency":
        return row.currency;
      case "category":
        return row.categoryName;
      case "paymentMethod":
        return row.paymentMethodName ?? "";
      case "note":
        return row.note ?? "";
      case "tags":
        return row.tagNames.join(" ");
      case "createdAt":
        return row.createdAt;
      case "fileId":
        return row.id;
      case "sourceRef":
        return row.sourceRef ?? "";
      case "exportRef":
        return exportRef;
    }
  });
}

/** Only used to type `rowValues`; the real work is in the query module. */
export function registerExportRoutes(app: FastifyInstance, options: ExportRouteOptions): void {
  const { prisma, requireAuth } = options;

  // -------------------------------------------------------------------------
  // GET /api/v1/export
  // -------------------------------------------------------------------------
  app.get("/api/v1/export", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);

    const query = exportQuerySchema.parse(request.query ?? {});
    const exportRef = newExportRef();

    // The template: the same headings, no rows and no traceability columns,
    // because a file from somewhere else has none of those values to offer.
    if (query.template) {
      const headers = EXPORT_COLUMNS.filter((column) =>
        TEMPLATE_COLUMN_KEYS.includes(column.key),
      ).map((column) => column.header);

      const body = `\uFEFF${csvRow(headers)}\r\n`;
      reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", contentDisposition("记账导入模板.csv"))
        .header("x-libellum-row-count", "0");

      return reply.send(body);
    }

    const filters = combineBounds(query);

    const total = await countExportRows(prisma, bookId, filters);
    if (total > MAX_EXPORT_ROWS) {
      throw badRequest(
        "export_too_large",
        `本次筛选有 ${String(total)} 条记录，超过一次导出的上限 ${String(MAX_EXPORT_ROWS)} 条。` +
          "请按月份或分类分批导出——不会只导出其中一部分。",
      );
    }

    const headers = EXPORT_COLUMNS.map((column) => column.header);
    const rows: (string | number)[][] = [];

    let rowCount = 0;
    for await (const row of iterateExportRows(prisma, bookId, filters)) {
      rows.push(rowValues(row, exportRef));
      rowCount += 1;
    }

    // The audit row. Written only when a file is actually produced — a dry run
    // that never generated anything should not appear in a log whose whole
    // purpose is to say what left this book.
    await prisma.exportLog.create({
      data: {
        id: crypto.randomUUID(),
        bookId,
        userId,
        format: query.format,
        monthFrom: query.monthFrom ?? null,
        monthTo: query.monthTo ?? null,
        kind: query.kind ?? null,
        categoryId: query.categoryId ?? null,
        currency: query.currency ?? null,
        rowCount,
        fileRef: exportRef,
      },
    });

    const stamp = exportRef.slice(4, 19).replace(/-/g, "").slice(0, 8);

    reply
      .header("x-libellum-file-ref", exportRef)
      .header("x-libellum-row-count", String(rowCount))
      /**
       * The browser reads these two to name the file and to tell the user
       * something they can quote back later.
       *
       * Exposed explicitly because a cross-origin `fetch` can only read a
       * response header that the server has named here — and the Vite proxy
       * makes even a same-machine request cross-origin from the browser's point
       * of view. Without this line the export works and the reference is
       * invisible, which is the worst of both.
       */
      .header("access-control-expose-headers", "x-libellum-file-ref, x-libellum-row-count");

    if (query.format === "xlsx") {
      const body = buildXlsx([headers, ...rows], {
        sheetName: "账目",
        // Column 4 (E) is 金额. Decimal-formatted so 38.5 reads as 38.50.
        numericColumns: [4],
        decimalColumns: [4],
        columnWidths: { 0: 12, 1: 8, 2: 16, 3: 6, 4: 12, 5: 8, 6: 12, 7: 12, 8: 28, 9: 16, 10: 20, 11: 38, 12: 38, 13: 26 },
      });

      reply
        .header(
          "content-type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header("content-disposition", contentDisposition(`账目-${stamp}.xlsx`))
        .header("content-length", String(body.length));

      return reply.send(body);
    }

    const csv = `\uFEFF${[
      csvRow(headers),
      ...rows.map((row) => csvRowEscaped(row, TEXT_COLUMNS)),
    ].join("\r\n")}\r\n`;

    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", contentDisposition(`账目-${stamp}.csv`));

    return reply.send(csv);
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/export — the same, for a client that prefers a body
  // -------------------------------------------------------------------------
  /**
   * Why both: a download is naturally a GET, and an `<a download>` or
   * `window.location` cannot carry a body. POST exists because the filter set is
   * a structured object and a query string is a poor place to keep it — and
   * because a future version may want to export a selection the URL cannot
   * express.
   */
  app.post("/api/v1/export", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);

    const query = exportQuerySchema.parse({
      ...(request.query as Record<string, unknown>),
      ...((request.body ?? {}) as Record<string, unknown>),
    });

    const total = await countExportRows(prisma, bookId, combineBounds(query));
    if (total > MAX_EXPORT_ROWS) {
      throw badRequest(
        "export_too_large",
        `本次筛选有 ${String(total)} 条记录，超过一次导出的上限 ${String(MAX_EXPORT_ROWS)} 条。请分批导出。`,
      );
    }

    // The body form answers with JSON: a caller using POST is usually fetching
    // data rather than starting a download, and the file comes from the GET.
    const exportRef = newExportRef();
    return reply.send({ fileRef: exportRef, format: query.format, rowCount: total });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/export-log
  // -------------------------------------------------------------------------
  /**
   * What has left this book.
   *
   * Metadata only, by the owner's instruction: who, when, which range, how many,
   * which format, and the reference. Never the rows and never the file. The
   * point is that money leaving the application should be accountable.
   */
  app.get("/api/v1/export-log", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);

    const rows = await prisma.exportLog.findMany({
      where: { bookId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        fileRef: true,
        format: true,
        rowCount: true,
        monthFrom: true,
        monthTo: true,
        kind: true,
        currency: true,
        createdAt: true,
        user: { select: { displayName: true, username: true } },
      },
    });

    return {
      entries: rows.map((row) => ({
        fileRef: row.fileRef,
        format: row.format,
        rowCount: row.rowCount,
        monthFrom: row.monthFrom,
        monthTo: row.monthTo,
        kind: row.kind,
        currency: row.currency,
        createdAt: row.createdAt.toISOString(),
        by: row.user.displayName,
        byUsername: row.user.username,
      })),
    };
  });
}
