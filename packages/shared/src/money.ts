/**
 * Money helpers.
 *
 * Rule for the whole project: money is ALWAYS stored and computed as an integer
 * number of cents. Floating point cannot represent 0.1 exactly, so `0.1 + 0.2`
 * is not `0.3`; for a ledger that is a fatal bug. These helpers are the only
 * place where a human-readable amount is converted to cents and back.
 */

/** Number of cents in one unit of currency (CNY, USD, EUR, ...). */
export const CENTS_PER_UNIT = 100;

/** Matches an unsigned decimal amount with at most two decimal places. */
const AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parse a user-entered amount such as `"12.34"` into integer cents.
 *
 * Accepts thousands separators and surrounding whitespace. Rejects signs,
 * more than two decimals, and anything else non-numeric.
 *
 * @throws {RangeError} when the input is not a valid, representable amount.
 */
export function parseAmountToCents(input: string): number {
  const normalized = input.trim().replace(/,/g, '');
  const match = AMOUNT_PATTERN.exec(normalized);

  if (!match) {
    throw new RangeError(`Not a valid amount: ${JSON.stringify(input)}`);
  }

  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = Number(whole) * CENTS_PER_UNIT + Number(fraction);

  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`Amount is too large: ${JSON.stringify(input)}`);
  }

  return cents;
}

/**
 * Format integer cents as a plain decimal string, e.g. `1234` -> `"12.34"`.
 *
 * @throws {RangeError} when `cents` is not a safe integer.
 */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`cents must be a safe integer, received: ${cents}`);
  }

  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / CENTS_PER_UNIT);
  const fraction = String(absolute % CENTS_PER_UNIT).padStart(2, '0');

  return `${sign}${whole}.${fraction}`;
}

/** Sum a list of cent amounts without ever leaving the integer domain. */
export function sumCents(amounts: readonly number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}
