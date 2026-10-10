/**
 * Turning a spoken sentence into the fields of an entry.
 *
 * ⚠️ **Deliberately a separate module from recognition.** The owner asked for the
 * split, and his reasoning is the right one: what is hard is the *recognition*,
 * and what is easy to get subtly wrong is this — turning "嗯，午饭 38 块" into an
 * amount, a kind and a note. Keeping them apart means the engine behind the first
 * can be swapped (whisper.cpp, the browser's own speech engine, a hosted API)
 * without touching the second, and this half can be tested with typed text.
 *
 * Two rules shape everything here:
 *
 *  * **Nothing is invented.** If the sentence has no amount, this reports no
 *    amount. A guess that fills a field the user did not say is worse than an
 *    empty field, because an empty field gets filled and a wrong one gets saved.
 *  * **The note is what was said**, minus the noise words — not a summary. The
 *    user can read it back and see whether they were heard correctly.
 */
import { z } from "zod";

/**
 * A spoken amount: digits, a decimal part, and an optional yuan/kuai marker.
 *
 * Chinese numerals (三十八) are **not** handled, deliberately. Whisper writes
 * numbers as digits for amounts in practice, and a numeral parser that gets
 * 三十八 right but 一百零八 wrong would be worse than not having one: it would
 * fill the field just often enough to be trusted.
 */
const AMOUNT_PATTERN = /(\d+(?:\.\d{1,2})?)\s*(?:元|块|块钱|圆)?/;

/** Words that mean income rather than spending. */
const INCOME_WORDS = [
  "收到",
  "收入",
  "入账",
  "到账",
  "工资",
  "发工资",
  "报销",
  "退款",
  "退了",
  "退款到账",
  "分红",
  "利息",
  "红包",
  "转给我",
  "给我转",
];

/** Words that mean spending. */
const EXPENSE_WORDS = ["花了", "花掉", "支出", "付了", "付款", "买了", "买", "消费", "交了", "充值"];

/**
 * Noise at the edges of a spoken sentence.
 *
 * The owner asked for these specifically — "备注里可以去掉一些语气词，比如'嗯'、'啊'
 * 在句首或句尾" — and the placement matters as much as the list: a 啊 in the
 * middle of a sentence is part of what somebody said, while the same character at
 * the front is the sound of somebody starting to talk.
 */
const FILLERS = [
  "嗯",
  "啊",
  "呃",
  "唉",
  "诶",
  "哎",
  "哦",
  "噢",
  "那个",
  "就是",
  "然后",
  "这个",
  "我说",
  "帮我",
  "给我",
  "记一笔",
  "记账",
  "记一下",
];

/** Budget words that describe the amount rather than the purchase. */
const AMOUNT_WORDS = ["元", "块", "块钱", "圆", "钱", "人民币", "美元", "美金", "港币", "日元", "欧元"];

export interface SpokenEntry {
  /** Digits as spoken, e.g. `"38"` or `"38.5"`. Null when no amount was heard. */
  readonly amount: string | null;
  readonly kind: "expense" | "income";
  /** What was said, with the noise removed. */
  readonly note: string;
}

/**
 * Read a spoken sentence.
 *
 * Returns what it found and nothing more. The caller puts `amount` in the amount
 * field, `note` in the note field, and leaves the rest to the user — which is the
 * point of returning a plain object rather than a form.
 */
export function parseSpokenEntry(spoken: string): SpokenEntry {
  const original = spoken.trim();

  const kind: "expense" | "income" = INCOME_WORDS.some((word) => original.includes(word))
    ? "income"
    : EXPENSE_WORDS.some((word) => original.includes(word))
      ? "expense"
      : "expense"; // Spending is the common case; the kind control is one tap away.

  /**
   * The amount, and then the same text with it taken out.
   *
   * Taken out because the amount is a *field*, not part of the description: a
   * note reading "午饭 38 块" next to an amount of 38 says the number twice, and
   * the second copy is the one that goes stale when the amount is corrected.
   */
  const match = AMOUNT_PATTERN.exec(original);
  const amount = match?.[1] ?? null;
  const withoutAmount = match === null ? original : original.replace(match[0], " ");

  return { amount, kind, note: cleanNote(withoutAmount) };
}

/**
 * Strip the noise from around a spoken note.
 *
 * Edges only, and repeatedly: "嗯，那个，午饭" needs both pass to come off, and a
 * single pass would leave "那个，午饭". Commas left dangling by a removal are
 * dropped, because "，" on its own is what makes a cleaned-up note look broken.
 */
export function cleanNote(text: string): string {
  let note = text;

  for (let pass = 0; pass < 8; pass += 1) {
    const before = note;
    note = stripEdges(note);

    if (note === before) break;
  }

  return collapsePunctuation(note);
}

/** One pass of edge-stripping. */
function stripEdges(text: string): string {
  let note = text.trim();

  // Punctuation is trimmed first so a filler behind a comma is still at an edge:
  // "，嗯，午饭" has 嗯 at the front once the comma goes.
  note = note.replace(/^[\s,，。、；;:：!！?？~～]+/, "").replace(/[\s,，。、；;:：!！?？~～]+$/, "");

  for (const filler of FILLERS) {
    if (note.startsWith(filler)) {
      note = note.slice(filler.length);
    }
    if (note.endsWith(filler)) {
      note = note.slice(0, -filler.length);
    }
  }

  return note;
}

/**
 * Tidy the punctuation left behind.
 *
 * The owner's rule, in his words: "周围有很多逗号时可以去掉". Runs of separators
 * become one, and separators at the edges go — a note is a phrase, and it should
 * not begin or end with the pause that used to be around something removed.
 */
function collapsePunctuation(text: string): string {
  return text
    .replace(/[\s,，]+/g, "，")
    .replace(/，{2,}/g, "，")
    .replace(/^，|，$/g, "")
    .replace(/[。、；;:：!！?？]+$/g, "")
    .trim();
}

/**
 * How long one recording may be.
 *
 * The owner's figure: **thirty seconds per segment**. Long enough for a sentence
 * about a purchase with a note attached, short enough that the upload stays small
 * and the transcription stays quick — whisper's cost grows with the audio, and a
 * two-minute recording would make somebody wait for a result they could have said
 * in five seconds.
 *
 * Enforced in the interface (the recorder stops itself) *and* on the server,
 * because a limit that only exists in the browser is a limit somebody can skip.
 */
export const MAX_SPEECH_SECONDS = 30;

/** Roughly what thirty seconds of browser audio weighs, with room to spare. */
export const MAX_SPEECH_BYTES = 2 * 1024 * 1024;

/**
 * What one recording produces.
 *
 * The transcription **and** the fields read out of it. Both, rather than only the
 * fields, because the owner asked for the text to be visible and editable — that
 * is the whole trust mechanism here: somebody who can see "午饭 38" can tell
 * whether they were heard correctly, where somebody shown only a filled-in form
 * cannot tell whether the machine guessed.
 *
 * `amount`, `kind` and `note` are what `parseSpokenEntry` read: a starting point
 * for the review form, never a decision. Nothing is saved by this endpoint.
 */
export const transcribeResponseSchema = z.object({
  /** What was heard, verbatim. */
  text: z.string(),
  /** Digits as spoken, or null when no amount was said. */
  amount: z.string().nullable(),
  kind: z.enum(["expense", "income"]),
  /** The sentence with the noise removed — a starting note, not a summary. */
  note: z.string(),
  /** How long the audio was, and how long the transcription took. */
  audioSeconds: z.number(),
  seconds: z.number(),
});
export type TranscribeResponse = z.infer<typeof transcribeResponseSchema>;

/**
 * Whether the text is worth offering as an entry at all.
 *
 * A recording of silence produces an empty string, and whisper answers a
 * non-speech sound with a bracketed marker such as `[BLANK_AUDIO]` or `(字幕:…)`.
 * Offering to file one of those as a note would be offering to save nonsense, so
 * they are recognised and dropped rather than shown.
 */
export function isSpeechless(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return true;

  // Whisper's own annotations, in both bracket styles it uses.
  if (/^[[(【][^\])】]*[\])】]$/.test(trimmed)) return true;

  // Nothing but punctuation.
  return /^[\s,，。、；;:：!！?？~～\-—…]+$/.test(trimmed);
}
