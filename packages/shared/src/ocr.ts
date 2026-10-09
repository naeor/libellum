import { z } from "zod";

/**
 * Screenshot recognition.
 *
 * The shape of a **guess**, not of an entry. Every field can be null, and the
 * interface shows the guess next to the field it belongs to so the user can
 * correct it. Nothing here is ever written straight into the ledger.
 *
 * Two properties matter more than the rest:
 *
 *  * **A field that could not be read is null, never a default.** A wrong
 *    amount gets confirmed; a blank one gets filled in. Guessing 0, or today's
 *    date dressed up as a reading, would produce a plausible entry that is
 *    silently wrong.
 *  * **`warnings` travels with the result.** The interface has to be able to
 *    say *why* a field is empty, or the user is left wondering whether the
 *    screenshot was unreadable or the feature is broken.
 */

/** Which app the screenshot came from, when it can be told. */
export const OCR_CHANNELS = ["WECHAT", "ALIPAY", "BANK"] as const;
export const ocrChannelSchema = z.enum(OCR_CHANNELS);
export type OcrChannel = z.infer<typeof ocrChannelSchema>;

/** Chinese labels, so the interface never shows a raw enum. */
export const OCR_CHANNEL_LABELS: Readonly<Record<OcrChannel, string>> = {
  WECHAT: "微信",
  ALIPAY: "支付宝",
  BANK: "银行",
};

/**
 * The fields a screenshot can yield.
 *
 * `amount` is a **string** rather than a number: it is text the user is about
 * to confirm or edit, and the currency's precision (the yen has none) is not
 * known until the currency itself is decided.
 */
export interface OcrDraft {
  readonly amount: string | null;
  readonly currency: string;
  readonly occurredLocalDate: string | null;
  readonly occurredTime: string | null;
  readonly kind: "expense" | "income";
  readonly channel: OcrChannel | null;
  readonly counterparty: string | null;
  readonly note: string | null;
  /** Transaction number, used to notice the same screenshot uploaded twice. */
  readonly serial: string | null;
  /** A refund: money coming back, so the direction is income by definition. */
  readonly isRefund: boolean;
  readonly warnings: readonly string[];
}

export const ocrDraftSchema = z.object({
  amount: z.string().nullable(),
  currency: z.string(),
  occurredLocalDate: z.string().nullable(),
  occurredTime: z.string().nullable(),
  kind: z.enum(["expense", "income"]),
  channel: ocrChannelSchema.nullable(),
  counterparty: z.string().nullable(),
  note: z.string().nullable(),
  serial: z.string().nullable(),
  isRefund: z.boolean(),
  warnings: z.array(z.string()),
});

/** One screenshot's outcome. A batch can mix successes and failures. */
export interface OcrItemResult {
  /** Position in the upload, so a result can be matched to its thumbnail. */
  readonly index: number;
  readonly ok: boolean;
  readonly draft: OcrDraft | null;
  readonly error: string | null;
  readonly message: string | null;
  readonly lineCount: number;
  readonly averageConfidence: number;
  readonly seconds: number;
}

export const ocrItemResultSchema = z.object({
  index: z.number().int(),
  ok: z.boolean(),
  draft: ocrDraftSchema.nullable(),
  error: z.string().nullable(),
  message: z.string().nullable(),
  lineCount: z.number().int(),
  averageConfidence: z.number(),
  seconds: z.number(),
});

export const recognizeResponseSchema = z.object({
  items: z.array(ocrItemResultSchema),
  /** Total wall-clock seconds, so the interface can report an honest figure. */
  seconds: z.number(),
});

export type RecognizeResponse = z.infer<typeof recognizeResponseSchema>;

/** How many screenshots one request may carry. */
export const MAX_RECOGNIZE_IMAGES = 5;
/** Bytes per screenshot. */
export const MAX_RECOGNIZE_BYTES = 10 * 1024 * 1024;
/** Accepted image types. Verified by content, not by the declared type. */
export const RECOGNIZE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
