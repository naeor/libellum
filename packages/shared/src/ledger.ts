import { z } from "zod";

/**
 * Ledger types shared by the API and the browser.
 *
 * Money is always an integer number of cents — see `money.ts`. Amounts arrive
 * from the client already converted, so the server never parses "12.34".
 */

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------

/**
 * The currencies a book can use. Deliberately a closed list, so the picker, the
 * validation and the formatting all work from one set of names.
 *
 * Precision is **per currency**, and lives in `money.ts` with the rest of the
 * money rules: the yen is recorded without decimals (¥1000 is `1000` minor
 * units, not `100000`) while the others use two.
 */
export const CURRENCIES = ["CNY", "USD", "EUR", "JPY", "HKD", "GBP"] as const;

export const currencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof currencySchema>;

export const TRANSACTION_KINDS = ["expense", "income"] as const;
export const transactionKindSchema = z.enum(TRANSACTION_KINDS);
export type TransactionKind = z.infer<typeof transactionKindSchema>;

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Ceiling for a single entry: 10 billion units, i.e. 1e12 cents.
 *
 * Two reasons it exists. It keeps every amount inside JavaScript's safe
 * integer range, so cents can travel as numbers without precision loss; and it
 * rejects the typo that would otherwise poison every total.
 */
export const MAX_AMOUNT_CENTS = 1_000_000_000_000;

export const amountCentsSchema = z
  .number()
  .int("金额必须是整数（分）")
  .min(0, "金额不能为负数")
  .max(MAX_AMOUNT_CENTS, "金额超出可记录的上限");

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Written as a regex rather than a helper so the rule is visible and stable
 * across zod versions. Entry ids are UUID v7 produced by the browser — see the
 * offline design in PLAN 3.3.
 */
export const uuidSchema = z.string().regex(UUID_PATTERN, "标识格式不正确");

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Name of the system category that collects entries saved without one. */
export const UNCATEGORISED_NAME = "暂无分类";

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: transactionKindSchema,
  /**
   * Plain-language explanation, shown behind the ⓘ next to a preset. Null for
   * categories the user made or renamed — they do not need to be told what
   * their own category means.
   */
  description: z.string().nullable(),
  /** System categories are server-managed and hidden from the picker. */
  isSystem: z.boolean(),
  isArchived: z.boolean(),
  sortOrder: z.number(),
});
export type Category = z.infer<typeof categorySchema>;

export const paymentMethodSchema = z.object({
  id: z.string(),
  name: z.string(),
  isArchived: z.boolean(),
  sortOrder: z.number(),
});
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});
export type Tag = z.infer<typeof tagSchema>;

export const ledgerMetaResponseSchema = z.object({
  book: z.object({
    id: z.string(),
    name: z.string(),
    /**
     * The ledger's public eight-digit number.
     *
     * Nullable only for the sake of rows written before the migration that
     * introduced it; every ledger created since has one. The client shows it so
     * two people can confirm out loud that they are looking at the same ledger.
     */
    bookNumber: z.string().nullable(),
  }),
  categories: z.array(categorySchema),
  paymentMethods: z.array(paymentMethodSchema),
  tags: z.array(tagSchema),
});
export type LedgerMetaResponse = z.infer<typeof ledgerMetaResponseSchema>;

// ---------------------------------------------------------------------------
// Managing categories, payment methods and tags
// ---------------------------------------------------------------------------

const sortOrderSchema = z.number().int().min(0).max(9_999);

export const categoryNameSchema = z
  .string()
  .trim()
  .min(1, "请填写分类名称")
  .max(20, "分类名称最多 20 个字符");

export const createCategorySchema = z.object({
  name: categoryNameSchema,
  kind: transactionKindSchema,
  sortOrder: sortOrderSchema.optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: categoryNameSchema.optional(),
  sortOrder: sortOrderSchema.optional(),
  /** Archiving hides it from the picker; restoring brings it back. */
  isArchived: z.boolean().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const paymentMethodNameSchema = z
  .string()
  .trim()
  .min(1, "请填写支付方式名称")
  .max(20, "支付方式名称最多 20 个字符");

export const createPaymentMethodSchema = z.object({
  name: paymentMethodNameSchema,
  sortOrder: sortOrderSchema.optional(),
});
export type CreatePaymentMethodInput = z.infer<typeof createPaymentMethodSchema>;

export const updatePaymentMethodSchema = z.object({
  name: paymentMethodNameSchema.optional(),
  sortOrder: sortOrderSchema.optional(),
  isArchived: z.boolean().optional(),
});
export type UpdatePaymentMethodInput = z.infer<typeof updatePaymentMethodSchema>;

export const tagNameSchema = z
  .string()
  .trim()
  .min(1, "请填写标签名称")
  .max(12, "标签名称最多 12 个字符");

/** `#RRGGBB` only: a fixed shape keeps the list readable and the input simple. */
export const tagColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "颜色格式应为 #RRGGBB");

export const createTagSchema = z.object({
  name: tagNameSchema,
  color: tagColorSchema,
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = z.object({
  name: tagNameSchema.optional(),
  color: tagColorSchema.optional(),
});
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** A tag may only be attached so many times to one entry. */
export const MAX_TAGS_PER_TRANSACTION = 10;

/**
 * How many tags a list row would show before collapsing the rest — **a rule
 * that is not implemented yet.**
 *
 * Nothing reads this today: the entry list shows no tags at all, and the detail
 * screen shows every tag on the entry. It is kept rather than deleted because
 * the decision it records — five in the list, all of them in the detail — is
 * still the intended design, and this is the only place that number is written
 * down. It should be wired into the row at the point the row starts showing
 * tags.
 */
export const TAGS_SHOWN_IN_LIST = 5;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A category chosen by the client, where an empty value means "none chosen".
 *
 * The empty string is folded into `null` on purpose, and `null` is kept as
 * `null` rather than normalised to `undefined`: a `<select>` with an empty
 * option hands back `""`, and every caller in the app already speaks in
 * `string | null`. Folding to `undefined` here would have forced four call sites
 * to change shape for no gain.
 *
 * What this replaces: passing `""` straight through used to fail validation with
 * "标识格式不正确" — a complaint about a malformed UUID, for the most ordinary
 * thing a person can do, which is not to pick a category.
 */
const optionalCategoryId = z
  .union([uuidSchema, z.literal(""), z.null()])
  .optional()
  .transform((value) => (value === "" || value === undefined ? null : value));

/** The same, for the payment method. */
const optionalPaymentMethodId = z
  .union([uuidSchema, z.literal(""), z.null()])
  .optional()
  .transform((value) => (value === "" || value === undefined ? null : value));

export const createTransactionSchema = z.object({
  /** Generated by the client so the entry keeps one identity from the start. */
  id: uuidSchema,
  /** Retrying an upload with the same key must not create a second row. */
  idempotencyKey: uuidSchema,

  kind: transactionKindSchema,
  amountCents: amountCentsSchema,
  currency: currencySchema,

  /** Omitted, null or empty files the entry under 暂无分类. */
  categoryId: optionalCategoryId,
  paymentMethodId: optionalPaymentMethodId,

  /** Full instant, ISO 8601 with an offset. */
  occurredAt: z.string().min(20).max(40),
  /** The phone's calendar date — what every group and month query uses. */
  occurredLocalDate: z.string().regex(LOCAL_DATE_PATTERN, "日期格式应为 YYYY-MM-DD"),
  /** IANA zone the entry was recorded in. */
  occurredTz: z.string().min(1).max(64),

  note: z.string().trim().max(200, "备注最多 200 个字符").nullish(),
  tagIds: z.array(uuidSchema).max(MAX_TAGS_PER_TRANSACTION, "一笔账最多 10 个标签").default([]),
});
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

export const updateTransactionSchema = z.object({
  kind: transactionKindSchema.optional(),
  amountCents: amountCentsSchema.optional(),
  currency: currencySchema.optional(),
  categoryId: optionalCategoryId,
  paymentMethodId: optionalPaymentMethodId,
  occurredAt: z.string().min(20).max(40).optional(),
  occurredLocalDate: z.string().regex(LOCAL_DATE_PATTERN).optional(),
  occurredTz: z.string().min(1).max(64).optional(),
  note: z.string().trim().max(200).nullish(),
  tagIds: z.array(uuidSchema).max(MAX_TAGS_PER_TRANSACTION).optional(),
  /** Optimistic lock: the version the client last saw. */
  version: z.number().int().positive(),
});
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;

export const transactionSchema = z.object({
  id: z.string(),
  kind: transactionKindSchema,
  amountCents: z.number(),
  /** Always one of the supported currencies — entries are validated on write. */
  currency: currencySchema,
  categoryId: z.string(),
  categoryName: z.string(),
  categoryIsSystem: z.boolean(),
  paymentMethodId: z.string().nullable(),
  paymentMethodName: z.string().nullable(),
  occurredAt: z.string(),
  occurredLocalDate: z.string(),
  occurredTz: z.string(),
  note: z.string().nullable(),
  tags: z.array(tagSchema),
  version: z.number(),
});
export type Transaction = z.infer<typeof transactionSchema>;

export const transactionListResponseSchema = z.object({
  items: z.array(transactionSchema),
  /** Pass back as `cursor` to fetch the next page; null means the end. */
  nextCursor: z.string().nullable(),
});
export type TransactionListResponse = z.infer<typeof transactionListResponseSchema>;

// ---------------------------------------------------------------------------
// Monthly summary
// ---------------------------------------------------------------------------

/**
 * One line per currency. v1 never converts between currencies, so totals are
 * reported separately — adding ¥ and $ together would be meaningless.
 */
export const currencySummarySchema = z.object({
  currency: z.string(),
  expenseCents: z.number(),
  incomeCents: z.number(),
  balanceCents: z.number(),
  expenseCount: z.number(),
  incomeCount: z.number(),
  /** `|expense| + |income|`, used to rank which currencies are shown first. */
  volumeCents: z.number(),
});
export type CurrencySummary = z.infer<typeof currencySummarySchema>;

export const summaryResponseSchema = z.object({
  month: z.string(),
  currencies: z.array(currencySummarySchema),
});
export type SummaryResponse = z.infer<typeof summaryResponseSchema>;
