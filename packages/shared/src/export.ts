import { z } from "zod";

import { transactionKindSchema, uuidSchema } from "./ledger.js";
import { fileRefSchema } from "./refs.js";

/**
 * The export and import contract.
 *
 * One definition of the file lives here, in the shared package, because both
 * sides depend on it: the API writes it and reads it back, and the browser has
 * to show the same column names in the template it offers for download. A second
 * copy would drift, and the drift would show up as an import that silently
 * ignores a column.
 */

/**
 * Column order, and the Chinese headings the file carries.
 *
 * The order is fixed rather than discovered: an exported file and a template
 * have to be the same shape, and a human comparing two files should not have to
 * work out which is which.
 *
 * The last three are the traceability columns. `fileId` is the entry's own
 * identity, so a file that comes home can be recognised row by row; `来源编号`
 * is whatever unique value the file carried when we first received it; and
 * `导出编号` is the same `Out-…` on every row, which is how an import can say
 * "this is the file you exported on such a day" instead of guessing.
 */
export const EXPORT_COLUMNS = [
  { key: "occurredLocalDate", header: "日期" },
  { key: "occurredTime", header: "时间" },
  { key: "occurredTz", header: "时区" },
  { key: "kind", header: "类型" },
  { key: "amount", header: "金额" },
  { key: "currency", header: "币种" },
  { key: "category", header: "分类" },
  { key: "paymentMethod", header: "支付方式" },
  { key: "note", header: "备注" },
  { key: "tags", header: "标签" },
  { key: "createdAt", header: "录入时间" },
  { key: "fileId", header: "流水编号" },
  { key: "sourceRef", header: "来源编号" },
  { key: "exportRef", header: "导出编号" },
] as const;

export type ExportColumnKey = (typeof EXPORT_COLUMNS)[number]["key"];

/** The template offers the same shape minus the traceability columns. */
export const TEMPLATE_COLUMN_KEYS: readonly ExportColumnKey[] = [
  "occurredLocalDate",
  "occurredTime",
  "occurredTz",
  "kind",
  "amount",
  "currency",
  "category",
  "paymentMethod",
  "note",
  "tags",
];

export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
export const exportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

/**
 * How many entries one export may contain.
 *
 * Not a limit on what a ledger can hold — a limit on what one request will read.
 * The owner's requirement was explicit: when the range is too big, say so and
 * suggest narrowing it, never quietly return part of it. A file that looks
 * complete and is not is worse than an error.
 */
export const MAX_EXPORT_ROWS = 20_000;

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD");

/** `YYYY-MM`, inclusive, as the detail screen already filters by month. */
const month = z.string().regex(/^\d{4}-\d{2}$/, "月份格式应为 YYYY-MM");

export const exportQuerySchema = z
  .object({
    format: exportFormatSchema.default("csv"),
    /** Inclusive month range. Either end may be omitted. */
    monthFrom: month.optional(),
    monthTo: month.optional(),
    from: localDate.optional(),
    to: localDate.optional(),
    kind: transactionKindSchema.optional(),
    categoryId: uuidSchema.optional(),
    paymentMethodId: uuidSchema.optional(),
    tagId: uuidSchema.optional(),
    currency: z.string().length(3).optional(),
    /** The template: headings only, no rows, no traceability columns. */
    template: z.coerce.boolean().default(false),
  })
  .refine(
    (value) => value.monthFrom === undefined || value.monthTo === undefined || value.monthFrom <= value.monthTo,
    { message: "起始月份不能晚于结束月份", path: ["monthFrom"] },
  )
  .refine(
    (value) => value.from === undefined || value.to === undefined || value.from <= value.to,
    { message: "起始日期不能晚于结束日期", path: ["from"] },
  );

export type ExportQuery = z.infer<typeof exportQuerySchema>;

/** What the browser needs to know after asking for an export. */
export const exportReceiptSchema = z.object({
  /** `Out-…`, also written into the file and into `export_logs`. */
  fileRef: fileRefSchema,
  format: exportFormatSchema,
  rowCount: z.number().int().nonnegative(),
});
export type ExportReceipt = z.infer<typeof exportReceiptSchema>;

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const MAX_IMPORT_ROWS = 20_000;

/**
 * A row is rejected with a reason, not silently skipped.
 *
 * The numbers are the file's own line numbers so a person can open the file and
 * go straight to the problem.
 */
export const importRowErrorSchema = z.object({
  line: z.number().int().positive(),
  column: z.string().nullable(),
  message: z.string(),
});
export type ImportRowError = z.infer<typeof importRowErrorSchema>;

export const importReportSchema = z.object({
  ok: z.boolean(),
  /** `In-…` — only present when the import actually ran. */
  fileRef: fileRefSchema.optional(),
  /** The `Out-…` this file appears to be, when it is one of ours. */
  exportedFileRef: fileRefSchema.nullable().optional(),
  rowCount: z.number().int().nonnegative(),
  importedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  /** Duplicate rows that were recognised as already present, by line. */
  skippedLines: z.array(z.number().int().positive()).default([]),
  errors: z.array(importRowErrorSchema).default([]),
});
export type ImportReport = z.infer<typeof importReportSchema>;

/**
 * The client's half of idempotency for import.
 *
 * `fileId` is generated per row by the browser, exactly as it is for a hand-typed
 * entry, so a retried upload cannot produce a second copy of the same row.
 */
export const importRequestSchema = z.object({
  fileId: uuidSchema,
});
export type ImportRequest = z.infer<typeof importRequestSchema>;
