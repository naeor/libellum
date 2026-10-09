import { describe, expect, it } from "vitest";

import { decimalsFor, formatMinor, parseAmountToMinor, sumMinor } from "./money.js";

/**
 * Money is the one thing in this project that must never drift, so these tests
 * read like a list of the ways it could: floating point, currency precision,
 * and the shapes of input people actually type.
 */
describe("decimalsFor", () => {
  it("knows the currencies that are not two decimal places", () => {
    expect(decimalsFor("JPY")).toBe(0);
    expect(decimalsFor("CNY")).toBe(2);
    expect(decimalsFor("USD")).toBe(2);
    expect(decimalsFor("EUR")).toBe(2);
    expect(decimalsFor("HKD")).toBe(2);
    expect(decimalsFor("GBP")).toBe(2);
  });

  it("falls back to two decimal places for anything unknown", () => {
    expect(decimalsFor("XYZ")).toBe(2);
  });

  it("ignores case", () => {
    expect(decimalsFor("jpy")).toBe(0);
  });
});

describe("parseAmountToMinor", () => {
  it("parses the amounts a person types", () => {
    expect(parseAmountToMinor("12", 2)).toBe(1200);
    expect(parseAmountToMinor("12.3", 2)).toBe(1230);
    expect(parseAmountToMinor("12.34", 2)).toBe(1234);
    expect(parseAmountToMinor("0.01", 2)).toBe(1);
    expect(parseAmountToMinor("  12.34  ", 2)).toBe(1234);
    expect(parseAmountToMinor("1,234.56", 2)).toBe(123456);
  });

  it("treats a currency without decimals as whole units", () => {
    // ¥1000 is 1000 minor units, not 100000 — the whole reason for the table.
    expect(parseAmountToMinor("1000", 0)).toBe(1000);
    expect(parseAmountToMinor("1", 0)).toBe(1);
  });

  it("refuses more precision than the currency has", () => {
    expect(() => parseAmountToMinor("12.345", 2)).toThrow(RangeError);
    // Half a yen is not a thing, and rounding it away silently would hide a
    // mistake the user can still correct.
    expect(() => parseAmountToMinor("1000.5", 0)).toThrow(RangeError);
  });

  it("refuses anything that is not an amount", () => {
    for (const input of ["", "abc", "-5", "1.2.3", ".5", "12,34x"]) {
      expect(() => parseAmountToMinor(input, 2)).toThrow(RangeError);
    }
  });

  it("refuses an amount too large to be exact", () => {
    expect(() => parseAmountToMinor("999999999999999999", 2)).toThrow(RangeError);
  });
});

describe("formatMinor", () => {
  it("formats a two-decimal currency", () => {
    expect(formatMinor(1234, 2)).toBe("12.34");
    expect(formatMinor(1, 2)).toBe("0.01");
    expect(formatMinor(0, 2)).toBe("0.00");
    expect(formatMinor(-1234, 2)).toBe("-12.34");
  });

  it("formats a currency with no decimals without any", () => {
    expect(formatMinor(1000, 0)).toBe("1000");
    expect(formatMinor(0, 0)).toBe("0");
    expect(formatMinor(-250, 0)).toBe("-250");
  });

  it("round-trips through parsing", () => {
    const cases: readonly (readonly [number, number])[] = [
      [1234, 2],
      [1, 2],
      [1000, 0],
      [999999, 2],
    ];

    for (const [minor, decimals] of cases) {
      expect(parseAmountToMinor(formatMinor(minor, decimals), decimals)).toBe(minor);
    }
  });

  it("refuses a value that is not a safe integer", () => {
    expect(() => formatMinor(1.5, 2)).toThrow(RangeError);
  });
});

describe("sumMinor", () => {
  it("adds without floating point drift", () => {
    // The reason this project stores integers at all: 0.1 + 0.2 !== 0.3.
    expect(sumMinor([10, 20])).toBe(30);
    expect(formatMinor(sumMinor([10, 20]), 2)).toBe("0.30");

    const tenCentsEach = Array.from({ length: 10 }, () => 10);
    expect(formatMinor(sumMinor(tenCentsEach), 2)).toBe("1.00");
  });

  it("returns zero for an empty list", () => {
    expect(sumMinor([])).toBe(0);
  });
});
