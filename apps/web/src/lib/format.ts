import { decimalsFor, formatMinor, parseAmountToMinor } from "@libellum/shared";

/**
 * Display and input helpers for money.
 *
 * Amounts stay integers all the way through; this file is one of only two
 * places that turns them into something a person reads (the other is the
 * amount field on the entry screen). Both consult `decimalsFor`, because the
 * yen has no decimal places and a yen amount shown as `¥1000.00` would be
 * both wrong and confusing.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
  JPY: "JP¥",
  HKD: "HK$",
  GBP: "£",
};

const CURRENCY_NAMES: Record<string, string> = {
  CNY: "人民币",
  USD: "美元",
  EUR: "欧元",
  JPY: "日元",
  HKD: "港币",
  GBP: "英镑",
};

export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? "";
}

export function currencyName(currency: string): string {
  return CURRENCY_NAMES[currency] ?? currency;
}

function groupThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * `1234` + `CNY` becomes `¥12.34`; `1000` + `JPY` becomes `JP¥1,000`.
 *
 * `withCode` appends the ISO code, which is what makes a screen showing two
 * currencies unambiguous — ¥ alone could be yuan or yen.
 */
export function formatMoney(
  minor: number,
  currency: string,
  options: { withCode?: boolean } = {},
): string {
  const plain = formatMinor(minor, decimalsFor(currency));
  const negative = plain.startsWith("-");
  const [whole = "0", fraction] = (negative ? plain.slice(1) : plain).split(".");

  const body =
    fraction === undefined
      ? `${currencySymbol(currency)}${groupThousands(whole)}`
      : `${currencySymbol(currency)}${groupThousands(whole)}.${fraction}`;

  return `${negative ? "-" : ""}${body}${options.withCode === true ? ` ${currency}` : ""}`;
}

/** `1234` becomes `12.34`, and `1000` JPY becomes `1000` — for an input field. */
export function minorToInput(minor: number, currency: string): string {
  return minor === 0 ? "" : formatMinor(minor, decimalsFor(currency));
}

/** The placeholder an empty amount field shows, matching the currency. */
export function amountPlaceholder(currency: string): string {
  return decimalsFor(currency) === 0 ? "0" : "0.00";
}

/** Parse what the user typed, honouring the currency's precision. */
export function parseAmountInput(input: string, currency: string): number {
  return parseAmountToMinor(input, decimalsFor(currency));
}
