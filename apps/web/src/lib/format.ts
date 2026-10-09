import { formatCents } from "@libellum/shared";

/**
 * Display helpers for money.
 *
 * Amounts stay integers all the way through; this file is one of only two
 * places that ever turns them into something a person reads (the other is the
 * amount input).
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
 * `1234` + `CNY` becomes `¥12.34`.
 *
 * `withCode` appends the ISO code, which is what makes a screen showing two
 * currencies unambiguous — ¥ alone could be yuan or yen.
 */
export function formatMoney(
  cents: number,
  currency: string,
  options: { withCode?: boolean } = {},
): string {
  const plain = formatCents(cents);
  const negative = plain.startsWith("-");
  const [whole = "0", fraction = "00"] = (negative ? plain.slice(1) : plain).split(".");

  const body = `${currencySymbol(currency)}${groupThousands(whole)}.${fraction}`;

  return `${negative ? "-" : ""}${body}${options.withCode === true ? ` ${currency}` : ""}`;
}

/** `1234` becomes `12.34` — for an input field, where symbols do not belong. */
export function centsToInput(cents: number): string {
  return cents === 0 ? "" : formatCents(cents);
}
