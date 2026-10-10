import {
  CURRENCIES,
  EXPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  UNCATEGORISED_NAME,
  decimalsFor,
  importReportSchema,
  importRequestSchema,
  newImportRef,
  parseCsv,
  unescapeFormula,
  type ImportRowError,
} from "@libellum/shared";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { PrismaClient } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { currentBookId } from "../ledger/access.js";

/**
 * Import a CSV of entries.
 *
 * The owner's requirements, and what each one costs to honour:
 *
 * **Row-by-row validation, and nothing written unless every row passes.** A
 * half-imported file is worse than a rejected one: the user cannot tell what got
 * in, and re-running the import would duplicate it. So this reads and checks the
 * whole file first, reports every problem with its line number, and only then
 * writes — inside one transaction.
 *
 * **De-duplication is scoped to the book, not to the identifier.** The same file
 * imported twice into one ledger changes nothing; the same file imported into a
 * second ledger works normally. A global rule on the identifier alone would
 * refuse that second import, which is a legitimate thing to want.
 *
 * **The file never chooses our primary keys.** `fileId` from an exported file is
 * used as the `source_ref` — a reference — and a fresh id is minted for the row.
 * A foreign file's identifiers are not ours to trust.
 *
 * **Everything is recorded.** A file with no traceability columns at all is
 * still accepted, but its rows get no `source_ref`, so they cannot be recognised
 * on a second import. That is stated rather than hidden.
 */

interface ImportRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
}

/**
 * The column key a heading refers to, for headings we recognise.
 *
 * A plain `Map<string, ExportColumnKey>` rather than one keyed by the literal
 * heading strings: the heading comes out of a user's file, so it is a `string`,
 * and a map keyed by the literals would only accept its own exact members.
 */
const COLUMN_BY_HEADER: ReadonlyMap<string, string> = new Map(
  EXPORT_COLUMNS.map((column) => [column.header, column.key]),
);

interface ParsedRow {
  /** 1-based line in the file, so the user can open it and look. */
  readonly line: number;
  readonly values: Map<string, string>;
}

/**
 * One entry validated and ready to be written.
 *
 * Typed explicitly rather than inferred: the array is built in one loop and
 * consumed in another, so an inferred `any[]` would quietly let a typo through
 * both. TypeScript caught exactly that when this was left implicit.
 *
 * `id` and `idempotencyKey` are **ours**: generated here, never taken from the
 * file.
 */
interface PendingEntry {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly sourceRef: string | null;
  readonly importRef: string;
  readonly kind: "income" | "expense";
  readonly amountCents: bigint;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly occurredLocalDate: Date;
  readonly occurredTz: string;
  readonly note: string | null;
  readonly categoryId: string;
  readonly paymentMethodId: string | null;
  readonly tagNames: string[];
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD` on the machine's calendar, which is the user's calendar. */
function todayLocal(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function registerImportRoutes(app: FastifyInstance, options: ImportRouteOptions): void {
  const { prisma, requireAuth } = options;

  app.post("/api/v1/import", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);

    if (!request.isMultipart()) {
      throw badRequest("expected_multipart", "请以文件上传的方式提交。");
    }

    let fileText: string | null = null;
    let fileId: string | null = null;

    for await (const part of request.parts()) {
      if (part.type === "field" && part.fieldname === "fileId") {
        fileId = String(part.value);
        continue;
      }

      if (part.type === "file") {
        // Read into memory: an import file is bounded by MAX_IMPORT_ROWS, and
        // there is no reason for it to exist on the server's disk. The declared
        // filename is deliberately ignored — nothing here opens a path.
        const buffer = await part.toBuffer();
        fileText = buffer.toString("utf8");
      }
    }

    if (fileText === null) {
      throw badRequest("no_file", "没有收到文件。");
    }

    // Validated even though the value is only used for idempotency bookkeeping:
    // an unvalidated client value reaching a write path is how surprises start.
    const { fileId: clientFileId } = importRequestSchema.parse({ fileId: fileId ?? randomUUID() });

    const fingerprint = createHash("sha256").update(fileText, "utf8").digest("hex");

    /**
     * Idempotency, keyed on the file's own bytes.
     *
     * A retried upload — a flaky connection, an impatient second click — must not
     * look like a fresh import. Recognising the fingerprint answers with what
     * happened the first time instead of reporting every row as a duplicate,
     * which would be true but useless.
     */
    const previous = await prisma.importLog.findFirst({
      where: { bookId, sourceFingerprint: fingerprint },
      orderBy: { createdAt: "desc" },
      select: { fileRef: true, exportedFileRef: true, rowCount: true, importedCount: true, skippedCount: true },
    });

    if (previous !== null) {
      return importReportSchema.parse({
        ok: true,
        fileRef: previous.fileRef,
        exportedFileRef: previous.exportedFileRef,
        rowCount: previous.rowCount,
        importedCount: previous.importedCount,
        skippedCount: previous.skippedCount,
        skippedLines: [],
      });
    }

    // The client's own id is validated and then deliberately not used as a key:
    // the file's fingerprint is the honest identity of an import, and a client
    // that retries with a fresh id should still be recognised.
    void clientFileId;

    // -----------------------------------------------------------------------
    // Read the file
    // -----------------------------------------------------------------------
    const table = parseCsv(fileText);
    if (table.length === 0) throw badRequest("empty_file", "文件是空的。");

    const headerRow = table[0] ?? [];
    const columnIndex = new Map<string, number>();
    const headerFor = new Map<string, string>();
    for (const [index, rawHeader] of headerRow.entries()) {
      const header = rawHeader.trim();
      const key = COLUMN_BY_HEADER.get(header);
      if (key !== undefined) {
        columnIndex.set(key, index);
        headerFor.set(key, header);
      }
    }

    // The two columns an entry cannot be created without.
    for (const required of ["occurredLocalDate", "amount"] as const) {
      if (!columnIndex.has(required)) {
        throw badRequest(
          "missing_column",
          `文件缺少必需的「${headerFor.get(required) ?? required}」列。请用导出的文件或模板。`,
        );
      }
    }

    const bodyRows = table.slice(1).filter((row) => row.some((cell) => cell.trim() !== ""));
    if (bodyRows.length > MAX_IMPORT_ROWS) {
      throw badRequest(
        "import_too_large",
        `文件有 ${String(bodyRows.length)} 行，超过一次导入的上限 ${String(MAX_IMPORT_ROWS)} 行。请分批导入。`,
      );
    }

    const rows: ParsedRow[] = bodyRows.map((cells, index) => {
      const values = new Map<string, string>();
      for (const [key, column] of columnIndex) {
        values.set(key, unescapeFormula((cells[column] ?? "").trim()));
      }
      return { line: index + 2, values }; // +2: one for the header, one for 1-based
    });

    if (rows.length === 0) {
      throw badRequest("no_rows", "文件里没有数据行。");
    }

    // -----------------------------------------------------------------------
    // Validate every row before writing anything
    // -----------------------------------------------------------------------
    const errors: ImportRowError[] = [];

    const categories = await prisma.category.findMany({
      where: { bookId },
      select: { id: true, name: true, kind: true, isArchived: true, isSystem: true },
    });
    const paymentMethods = await prisma.paymentMethod.findMany({
      where: { bookId },
      select: { id: true, name: true, isArchived: true },
    });
    const existingTags = await prisma.tag.findMany({
      where: { bookId },
      select: { id: true, name: true },
    });

    const tagIdByName = new Map(existingTags.map((tag) => [tag.name, tag.id]));

    for (const row of rows) {
      const date = row.values.get("occurredLocalDate") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        errors.push({ line: row.line, column: "日期", message: "日期格式应为 YYYY-MM-DD。" });
      } else {
        const parsed = new Date(`${date}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
          errors.push({ line: row.line, column: "日期", message: `「${date}」不是一个真实日期。` });
        }
      }

      const time = row.values.get("occurredTime") ?? "";
      if (time !== "" && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
        errors.push({ line: row.line, column: "时间", message: "时间格式应为 HH:mm。" });
      }

      const amountText = (row.values.get("amount") ?? "").replace(/,/g, "");
      const amount = Number(amountText);
      if (amountText === "" || !Number.isFinite(amount)) {
        errors.push({ line: row.line, column: "金额", message: `「${amountText}」不是有效金额。` });
      } else if (Math.abs(amount) > 1e10) {
        errors.push({ line: row.line, column: "金额", message: "金额超出可记录的上限。" });
      }

      const currency = (row.values.get("currency") ?? "CNY").toUpperCase();
      if (!(CURRENCIES as readonly string[]).includes(currency)) {
        errors.push({
          line: row.line,
          column: "币种",
          message: `不支持的币种「${currency}」，可用：${CURRENCIES.join(" / ")}。`,
        });
      }

      const kindText = row.values.get("kind") ?? "";
      if (kindText !== "" && !["支出", "收入", "expense", "income"].includes(kindText)) {
        errors.push({ line: row.line, column: "类型", message: `无法识别的类型「${kindText}」，应为「支出」或「收入」。` });
      }

      const categoryName = row.values.get("category") ?? "";
      if (categoryName !== "") {
        const exists = categories.some((category) => category.name === categoryName);
        if (!exists) {
          errors.push({
            line: row.line,
            column: "分类",
            message: `分类「${categoryName}」不存在。请先在应用里创建它，或把它改成一个已有分类。`,
          });
        }
      }

      const paymentName = row.values.get("paymentMethod") ?? "";
      if (paymentName !== "") {
        const exists = paymentMethods.some((method) => method.name === paymentName);
        if (!exists) {
          errors.push({
            line: row.line,
            column: "支付方式",
            message: `支付方式「${paymentName}」不存在。`,
          });
        }
      }
    }

    if (errors.length > 0) {
      // Nothing was written. The report is the whole answer.
      return reply.status(200).send(
        importReportSchema.parse({
          ok: false,
          rowCount: rows.length,
          importedCount: 0,
          skippedCount: 0,
          errors,
        }),
      );
    }

    // -----------------------------------------------------------------------
    // Work out what is already here, then write
    // -----------------------------------------------------------------------
    const incomingIds = rows
      .map((row) => row.values.get("fileId") ?? "")
      .filter((value) => value !== "");

    /**
     * The value each row would be recognised by on a second import.
     *
     * Our own exports leave 来源编号 empty and put the identity in 流水编号, so
     * the fallback has to happen **before** the lookup, not after it. Getting
     * this order wrong was a real bug: the gate asked the database for the
     * 来源编号 values (all empty, so nothing), found nothing, and then tried to
     * insert a row whose source_ref was already taken — a 500 on a legitimate
     * second import.
     */
    const effectiveRefFor = (row: ParsedRow): string => {
      const sourceRef = row.values.get("sourceRef") ?? "";
      if (sourceRef !== "") return sourceRef;
      return row.values.get("fileId") ?? "";
    };

    const incomingRefs = rows.map(effectiveRefFor).filter((value) => value !== "");

    // Our own exported `Out-…` reference, if the file carries one.
    const exportedFileRef =
      rows.map((row) => row.values.get("exportRef") ?? "").find((value) => value.startsWith("Out-")) ?? null;

    const existingById = new Set(
      (
        await prisma.transaction.findMany({
          where: { bookId, id: { in: incomingIds } },
          select: { id: true },
        })
      ).map((row) => row.id),
    );

    const existingByRef = new Set(
      (
        await prisma.transaction.findMany({
          where: { bookId, sourceRef: { in: incomingRefs } },
          select: { sourceRef: true },
        })
      ).map((row) => row.sourceRef ?? ""),
    );

    const importRef = newImportRef();

    const toInsert: PendingEntry[] = [];
    const skippedLines: number[] = [];
    /**
     * Identity already claimed **by this file**.
     *
     * The second half of the de-duplication rule, and the one that is easy to
     * forget: a file may repeat a row itself, and a row inserted earlier in the
     * same file is not in either set read above — those were read before any of
     * this was written. Without this, a file with a duplicated row would collide
     * with the unique index instead of being reported as a skip.
     */
    const seenRefs = new Set<string>();
    const seenIds = new Set<string>();

    for (const row of rows) {
      const effectiveRef = effectiveRefFor(row);
      const fileIdValue = row.values.get("fileId") ?? "";

      /**
       * Two independent reasons a row is already here, and **both are needed**.
       *
       * The id: this file came from us, and our own entry is still in the ledger.
       * The reference: the file names a source value this book has already seen.
       *
       * An earlier version checked only the reference, after having shifted the
       * fallback into it — which quietly stopped recognising our own exports,
       * because `source_ref` was null on the original entries. The bug was
       * invisible until a round trip was tested end to end.
       */
      const alreadyHere =
        (fileIdValue !== "" && (existingById.has(fileIdValue) || seenIds.has(fileIdValue))) ||
        (effectiveRef !== "" && (existingByRef.has(effectiveRef) || seenRefs.has(effectiveRef)));

      if (alreadyHere) {
        skippedLines.push(row.line);
        continue;
      }

      if (fileIdValue !== "") seenIds.add(fileIdValue);
      if (effectiveRef !== "") seenRefs.add(effectiveRef);

      const date = row.values.get("occurredLocalDate") ?? todayLocal();
      const time = row.values.get("occurredTime") ?? "";
      const [hours, minutes] = time === "" ? ["12", "00"] : time.split(":");
      const occurredAt = new Date(`${date}T${hours ?? "12"}:${minutes ?? "00"}:00`);

      const amount = Math.abs(Number((row.values.get("amount") ?? "0").replace(/,/g, "")));
      const currency = (row.values.get("currency") ?? "CNY").toUpperCase();
      const kindText = row.values.get("kind") ?? "";
      const explicitKind =
        kindText === "收入" || kindText === "income"
          ? "income"
          : kindText === "支出" || kindText === "expense"
            ? "expense"
            : null;
      // A signed amount is a fallback for files with no 类型 column at all.
      const signedAmount = Number((row.values.get("amount") ?? "0").replace(/,/g, ""));
      const kind = explicitKind ?? (signedAmount < 0 ? "expense" : "income");

      const categoryName = row.values.get("category") ?? "";
      const category =
        categoryName === ""
          ? categories.find((item) => item.kind === kind && item.name === UNCATEGORISED_NAME && item.isSystem)
          : categories.find((item) => item.kind === kind && item.name === categoryName);

      const paymentName = row.values.get("paymentMethod") ?? "";
      const paymentMethod = paymentName === "" ? null : paymentMethods.find((item) => item.name === paymentName) ?? null;

      // Decimals are currency-specific: 12.34 CNY is 1234 minor units, and 1234
      // JPY is 1234. Rounding to the currency's own precision is what stops a
      // round trip from drifting — and using 0 for the yen is the same rule
      // `money.ts` enforces everywhere else.
      const amountCents = Math.round(amount * 10 ** decimalsFor(currency));

      /**
       * Every entry lands on a real category row.
       *
       * Either the one the file named, or the book's hidden 暂无分类 for that
       * kind. Validation above already rejected a file naming a category that
       * does not exist, and every book is created with both system categories,
       * so this fallback is a guarantee rather than a branch anybody expects to
       * take — but `category_id` is mandatory in the database and an import
       * should never be where that is discovered.
       */
      const categoryId =
        category?.id ?? categories.find((item) => item.kind === kind && item.isSystem)?.id;

      if (categoryId === undefined) {
        throw badRequest("data_incomplete", "这个账本的分类数据不完整，缺少系统分类。");
      }

      toInsert.push({
        id: randomUUID(),
        categoryId,
        paymentMethodId: paymentMethod?.id ?? null,
        kind,
        amountCents: BigInt(amountCents),
        currency,
        occurredAt,
        occurredLocalDate: new Date(`${date}T00:00:00Z`),
        occurredTz: row.values.get("occurredTz") ?? "Asia/Shanghai",
        note: (row.values.get("note") ?? "") === "" ? null : (row.values.get("note") ?? ""),
        idempotencyKey: randomUUID(),
        /**
         * The traceability value this row carries from now on.
         *
         * If the file names an external source value, that is it. Otherwise the
         * file's own 流水编号 becomes the reference — it is the strongest unique
         * value the row has, and storing it is what makes re-importing the same
         * export a no-op.
         *
         * What this must NOT be is the primary key. An earlier version trusted
         * the file's id as the row's own `id`, which let a foreign file choose
         * our keys and left the row with no source reference at all, so nothing
         * recognised it the second time.
         */
        sourceRef: effectiveRef === "" ? null : effectiveRef,
        importRef,
        tagNames: (row.values.get("tags") ?? "").split(/\s+/).filter((name) => name !== ""),
      });
    }

    // Tags the file mentions that do not exist yet are created, because a tag
    // carries no amount: getting it wrong changes nothing about the money.
    for (const item of toInsert) {
      for (const name of item.tagNames) {
        if (tagIdByName.has(name)) continue;
        const created = await prisma.tag.create({
          data: { id: randomUUID(), bookId, name, color: "#55997a" },
        });
        tagIdByName.set(name, created.id);
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const item of toInsert) {
        await tx.transaction.create({
          data: {
            id: item.id,
            bookId,
            userId,
            categoryId: item.categoryId,
            paymentMethodId: item.paymentMethodId,
            kind: item.kind,
            amountCents: item.amountCents,
            currency: item.currency,
            occurredAt: item.occurredAt,
            occurredLocalDate: item.occurredLocalDate,
            occurredTz: item.occurredTz,
            note: item.note,
            idempotencyKey: item.idempotencyKey,
            sourceRef: item.sourceRef,
            importRef: item.importRef,
            tags: {
              create: item.tagNames
                .map((name) => tagIdByName.get(name))
                .filter((tagId): tagId is string => tagId !== undefined)
                .map((tagId) => ({ tagId })),
            },
          },
        });
      }

      await tx.importLog.create({
        data: {
          id: randomUUID(),
          bookId,
          userId,
          format: "csv",
          fileRef: importRef,
          exportedFileRef,
          sourceFingerprint: fingerprint,
          rowCount: rows.length,
          importedCount: toInsert.length,
          skippedCount: skippedLines.length,
        },
      });
    });

    return importReportSchema.parse({
      ok: true,
      fileRef: importRef,
      exportedFileRef,
      rowCount: rows.length,
      importedCount: toInsert.length,
      skippedCount: skippedLines.length,
      skippedLines,
    });
  });
}
