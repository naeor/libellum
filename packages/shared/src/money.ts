/**
 * Money helpers.
 *
 * The rule for the whole project: money is ALWAYS stored and computed as an
 * integer — the number of **minor units** of its own currency.
 *
 * For the yuan, dollar, euro and pound a minor unit is a cent. **The yen has
 * no minor unit at all**, so ¥1000 is stored as `1000`, not `100000`. Getting
 * that wrong is not a rounding detail, it is a factor of a hundred — and once
 * wrong numbers are in the database there is nothing in them that says which
 * convention they followed.
 *
 * Floating point cannot represent 0.1 exactly, so `0.1 + 0.2` is not `0.3`;
 * for a ledger that is a fatal bug. These helpers are the only place where a
 * human-readable amount is converted to minor units and back.
 */

/**
 * How many decimal places each supported currency uses.
 *
 * A currency missing from this table falls back to two, which is right for the
 * large majority of the world's currencies.
 */
const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
  CNY: 2,
  USD: 2,
  EUR: 2,
  /** The yen has no subunit in circulation. */
  JPY: 0,
  HKD: 2,
  GBP: 2,
};

export const DEFAULT_DECIMALS = 2;

export function decimalsFor(currency: string): number {
  return CURRENCY_DECIMALS[currency.toUpperCase()] ?? DEFAULT_DECIMALS;
}

function unitsPerWhole(decimals: number): number {
  return 10 ** decimals;
}

/**
 * Parse a user-entered amount such as `"12.34"` into integer minor units.
 *
 * Accepts thousands separators and surrounding whitespace. Rejects signs, more
 * decimals than the currency has, and anything else non-numeric — a yen amount
 * with a decimal point is a mistake worth surfacing, not something to round
 * away silently.
 *
 * @throws {RangeError} when the input is not a valid, representable amount.
 */
export function parseAmountToMinor(input: string, decimals: number): number {
  const normalized = input.trim().replace(/,/g, "");
  const pattern = decimals === 0 ? /^(\d+)$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${String(decimals)}}))?$`);
  const match = pattern.exec(normalized);

  if (!match) {
    throw new RangeError(`Not a valid amount: ${JSON.stringify(input)}`);
  }

  const whole = match[1] ?? "0";
  const fraction = decimals === 0 ? 0 : Number((match[2] ?? "").padEnd(decimals, "0"));
  const minor = Number(whole) * unitsPerWhole(decimals) + fraction;

  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`Amount is too large: ${JSON.stringify(input)}`);
  }

  return minor;
}

/**
 * Format integer minor units as a plain decimal string.
 *
 * `formatMinor(1234, 2)` is `"12.34"`; `formatMinor(1000, 0)` is `"1000"`.
 *
 * @throws {RangeError} when `minor` is not a safe integer.
 */
export function formatMinor(minor: number, decimals: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`minor units must be a safe integer, received: ${minor}`);
  }

  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);

  if (decimals === 0) return `${sign}${String(absolute)}`;

  const scale = unitsPerWhole(decimals);
  const whole = Math.floor(absolute / scale);
  const fraction = String(absolute % scale).padStart(decimals, "0");

  return `${sign}${whole}.${fraction}`;
}

/**
 * Sum minor units without ever leaving the integer domain.
 *
 * Only ever sum amounts that share a currency: adding yen to dollars is
 * meaningless, which is why totals are reported per currency.
 */
export function sumMinor(amounts: readonly number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}
