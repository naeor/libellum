/**
 * Reading an amount out of Chinese numerals.
 *
 * The owner's observation: **"我刚刚观察到他似乎对汉字大写的数字不太敏感"** — and he
 * is right, because the first version only understood digits. Whisper writes
 * `38` for a clear "三十八", but for an unclear one it writes `三十八`, and for
 * money it sometimes produces the formal characters people use on cheques
 * (`叁佰捌拾`). All three mean the same thing to the person who said it.
 *
 * ⚠️ **The conversion is done in two halves — integer part and fraction — and
 * assembled as a string, never as a `number`.**
 *
 * That is not fussiness. `300` and `3` differ by a factor of a hundred, and a
 * Chinese numeral carries that factor in its *unit characters*: 三百 is three
 * hundreds, 三十 is three tens. Converting to a `number` and back through
 * division would reintroduce exactly the floating-point error the rest of this
 * project keeps out of money. The integer half is computed in whole units and
 * printed with `String()`, and the fraction half is one digit per character, so
 * `叁佰捌拾` → `"380"` and `三点五` → `"3.5"` are exact by construction.
 */

/** 0–9, in both the everyday and the formal cheque-writing forms. */
const DIGITS: Readonly<Record<string, number>> = {
  // Everyday.
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  贰: 2,
  貳: 2,
  两: 2,
  兩: 2,
  三: 3,
  叁: 3,
  參: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  陸: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
};

/** Small units, multiplied by the digit before them. */
const SMALL_UNITS: Readonly<Record<string, number>> = {
  十: 10,
  拾: 10,
  百: 100,
  佰: 100,
  千: 1000,
  仟: 1000,
};

/**
 * Big units, which multiply everything accumulated so far.
 *
 * 亿 is here even though a single purchase will never cost one: whisper may
 * mishear a large salary as 万 or 亿, and handling it costs one line where
 * mishandling it would produce a wrong amount — the one field a person trusts at
 * a glance.
 */
const BIG_UNITS: Readonly<Record<string, number>> = {
  万: 10_000,
  萬: 10_000,
  亿: 100_000_000,
  億: 100_000_000,
};

/** Every character this module understands. */
const NUMERAL_CHARS = new Set([
  ...Object.keys(DIGITS),
  ...Object.keys(SMALL_UNITS),
  ...Object.keys(BIG_UNITS),
]);

/** The characters that mean "this is an amount", rather than just a number. */
const CURRENCY_SUFFIX = /[元块圆角毛分钱]/;

/**
 * Convert one run of Chinese numeral characters to digits.
 *
 * Returns `null` when the run is not a numeral this understands, which keeps the
 * caller from silently turning a stray 十 into an amount.
 */
export function chineseNumeralToDigits(run: string): string | null {
  if (run === "") return null;

  /**
   * The fraction, if one was said.
   *
   * 「点」 is the spoken decimal point, and everything after it is one digit per
   * character: 三点五 is 3.5, 三点一四 is 3.14. Only the first two digits are kept,
   * because money has at most two decimal places and a third would be rounding
   * something the speaker did not intend.
   */
  const pointIndex = Math.max(run.indexOf("点"), run.indexOf("點"));

  const integerPart = pointIndex === -1 ? run : run.slice(0, pointIndex);
  const fractionPart = pointIndex === -1 ? "" : run.slice(pointIndex + 1);

  const integer = parseIntegerPart(integerPart);
  if (integer === null) return null;

  if (fractionPart === "") return String(integer);

  let fraction = "";

  for (const character of fractionPart) {
    const digit = DIGITS[character];
    if (digit === undefined) break;
    fraction += String(digit);
    if (fraction.length === 2) break;
  }

  // 「三点零」 is a way of saying "three point zero" — the trailing zero is part of
  // the number being spoken, but writing "3.0" is not how an amount is typed.
  const trimmed = fraction.replace(/0+$/, "");

  return trimmed === "" ? String(integer) : `${String(integer)}.${trimmed}`;
}

/**
 * Parse the whole-number half.
 *
 * The rule is the one every Chinese speaker applies without thinking: a digit
 * followed by a unit multiplies, and a digit on its own is added. `十五` is fifteen
 * because a leading 十 means one ten, which is why the section accumulator is
 * seeded rather than left empty.
 */
function parseIntegerPart(text: string): number | null {
  if (text === "") return 0;

  let total = 0;
  /** The digits accumulated since the last big unit. */
  let section = 0;
  /** The digit waiting for a unit, or `null` when none is pending. */
  let pending: number | null = null;

  for (const character of text) {
    const digit = DIGITS[character];

    if (digit !== undefined) {
      pending = digit;
      continue;
    }

    const small = SMALL_UNITS[character];

    if (small !== undefined) {
      // 「十五」 — a unit with nothing before it means one of that unit.
      section += (pending ?? 1) * small;
      pending = null;
      continue;
    }

    const big = BIG_UNITS[character];

    if (big !== undefined) {
      section += pending ?? 0;
      // A bare 万 with nothing before it is not an amount anybody says.
      if (section === 0) return null;

      total += section * big;
      section = 0;
      pending = null;
      continue;
    }

    // A character this module does not know: refuse the whole run rather than
    // returning a number built from part of it.
    return null;
  }

  return total + section + (pending ?? 0);
}

/**
 * How long the longest numeral run can be.
 *
 * A cap rather than a scan to the end of the string: without one, a sentence
 * containing no numerals at all still copies itself per starting position, which
 * is the kind of accidental quadratic that only shows up on a long recording.
 */
const MAX_RUN = 24;

/**
 * Find the amount in a sentence written with Chinese numerals, or `null`.
 *
 * **Runs are scored, not taken in order**, because a sentence can contain more
 * than one number and only one of them is the price: "三个人吃饭三百块" has a 三 and
 * a 三百. A run followed by 元 / 块 / 钱 is what somebody means as the amount, so
 * those win; among equals the longest run wins, because a longer run carries more
 * unit characters and is therefore the more specific reading.
 */
export function findChineseAmount(text: string, from = 0): { readonly value: string; readonly index: number; readonly length: number } | null {
  let best: { readonly value: string; readonly index: number; readonly length: number; readonly scored: number } | null = null;

  let index = from;

  while (index < text.length) {
    if (!NUMERAL_CHARS.has(text[index] ?? "")) {
      index += 1;
      continue;
    }

    // A run may include 点 and the characters after it.
    let end = index;
    let sawPoint = false;

    while (end < text.length && end - index < MAX_RUN) {
      const character = text[end] ?? "";

      if (NUMERAL_CHARS.has(character)) {
        end += 1;
        continue;
      }

      if ((character === "点" || character === "點") && !sawPoint) {
        sawPoint = true;
        end += 1;
        continue;
      }

      break;
    }

    const run = text.slice(index, end);
    const value = chineseNumeralToDigits(run);

    if (value !== null) {
      const followedByCurrency = CURRENCY_SUFFIX.test(text.slice(end, end + 3));
      const scored = (followedByCurrency ? 1_000 : 0) + run.length;

      if (best === null || scored > best.scored) {
        best = { value, index, length: run.length, scored };
      }
    }

    // Skip the whole run: starting inside it would re-read the same characters as
    // a different number.
    index = end === index ? index + 1 : end;
  }

  if (best === null) return null;

  return { value: best.value, index: best.index, length: best.length };
}

/** Whether a character is part of a Chinese numeral run. */
export function isNumeralChar(character: string): boolean {
  return NUMERAL_CHARS.has(character) || character === "点" || character === "點";
}
