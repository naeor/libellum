import { describe, expect, it } from "vitest";

import { formatCents, parseAmountToCents, sumCents } from "./money.js";

describe("parseAmountToCents", () => {
  it("parses whole amounts", () => {
    expect(parseAmountToCents("12")).toBe(1200);
  });

  it("parses a single decimal place", () => {
    expect(parseAmountToCents("12.3")).toBe(1230);
  });

  it("parses two decimal places", () => {
    expect(parseAmountToCents("12.34")).toBe(1234);
  });

  it("parses amounts below one", () => {
    expect(parseAmountToCents("0.05")).toBe(5);
  });

  it("tolerates thousands separators and surrounding whitespace", () => {
    expect(parseAmountToCents(" 1,234.56 ")).toBe(123_456);
  });

  it.each(["", "-1", "12.345", "abc", "1.2.3", "1e3", ".5", "1."])(
    "rejects %j",
    (input) => {
      expect(() => parseAmountToCents(input)).toThrow(RangeError);
    },
  );
});

describe("formatCents", () => {
  it("formats with exactly two decimals", () => {
    expect(formatCents(1234)).toBe("12.34");
  });

  it("pads a single-digit cents value", () => {
    expect(formatCents(1205)).toBe("12.05");
  });

  it("formats zero", () => {
    expect(formatCents(0)).toBe("0.00");
  });

  it("formats negative amounts", () => {
    expect(formatCents(-5)).toBe("-0.05");
  });

  it("rejects non-integer input", () => {
    expect(() => formatCents(1.5)).toThrow(RangeError);
  });
});

describe("money arithmetic stays exact", () => {
  it("computes 0.1 + 0.2 as 0.3, which floats cannot", () => {
    const total = sumCents([parseAmountToCents("0.1"), parseAmountToCents("0.2")]);

    expect(total).toBe(parseAmountToCents("0.3"));
    expect(0.1 + 0.2).not.toBe(0.3); // the reason this whole module exists
  });

  it("survives a thousand additions of one cent", () => {
    const oneCent = parseAmountToCents("0.01");
    const amounts = Array.from({ length: 1000 }, () => oneCent);

    expect(formatCents(sumCents(amounts))).toBe("10.00");
  });

  it("round-trips every representative value", () => {
    for (const value of ["0.00", "0.01", "9.99", "1000.00", "12345.67"]) {
      expect(formatCents(parseAmountToCents(value))).toBe(value);
    }
  });
});
