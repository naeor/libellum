import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";

import { buildXlsx } from "../src/export/xlsx.js";
import { buildZip, crc32 } from "../src/export/zip.js";

/**
 * Unzip without a library.
 *
 * The point of these tests is that a hand-written archive is opened by
 * something other than the code that wrote it. Walking the central directory
 * here does that: if the offsets, sizes or CRCs disagree with the local headers,
 * the bytes come back wrong or not at all.
 */
function unzip(archive: Buffer): Map<string, string> {
  const entries = new Map<string, string>();

  // Find the end-of-central-directory record by scanning backwards.
  let eocd = -1;
  for (let index = archive.length - 22; index >= 0; index -= 1) {
    if (archive.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");

  const count = archive.readUInt16LE(eocd + 10);
  let pointer = archive.readUInt32LE(eocd + 16);

  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(pointer) !== 0x02014b50) throw new Error("bad central header");

    const method = archive.readUInt16LE(pointer + 10);
    const expectedCrc = archive.readUInt32LE(pointer + 16);
    const compressedSize = archive.readUInt32LE(pointer + 20);
    const nameLength = archive.readUInt16LE(pointer + 28);
    const extraLength = archive.readUInt16LE(pointer + 30);
    const commentLength = archive.readUInt16LE(pointer + 32);
    const localOffset = archive.readUInt32LE(pointer + 42);

    const name = archive.toString("utf8", pointer + 46, pointer + 46 + nameLength);

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("bad local header");

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    const body = archive.subarray(dataStart, dataStart + compressedSize);
    const raw = method === 0 ? body : inflateRawSync(body);

    // The CRC is the check a real reader performs; doing it here means a broken
    // archive fails in this test rather than in somebody's spreadsheet.
    if (crc32(raw) !== expectedCrc) throw new Error(`CRC mismatch for ${name}`);

    entries.set(name, raw.toString("utf8"));
    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

describe("buildZip", () => {
  it("round-trips a text entry", () => {
    const archive = buildZip([{ name: "hello.txt", data: "你好, world" }]);
    expect(unzip(archive).get("hello.txt")).toBe("你好, world");
  });

  it("round-trips several entries", () => {
    const archive = buildZip([
      { name: "a.txt", data: "first" },
      { name: "b.txt", data: "second" },
      { name: "c.txt", data: "third" },
    ]);
    const entries = unzip(archive);

    expect(entries.size).toBe(3);
    expect(entries.get("b.txt")).toBe("second");
  });

  it("handles a long entry that has to be deflated", () => {
    const long = "账单".repeat(5000);
    const archive = buildZip([{ name: "big.txt", data: long }]);

    expect(unzip(archive).get("big.txt")).toBe(long);
    // Deflating repetitive text should shrink it substantially; if it did not,
    // the compression method is being reported wrongly.
    expect(archive.length).toBeLessThan(long.length);
  });

  it("handles an empty entry", () => {
    expect(unzip(buildZip([{ name: "empty.txt", data: "" }])).get("empty.txt")).toBe("");
  });

  it("is byte-for-byte deterministic", () => {
    const first = buildZip([{ name: "x.txt", data: "same" }]);
    const second = buildZip([{ name: "x.txt", data: "same" }]);
    expect(first.equals(second)).toBe(true);
  });
});

describe("buildXlsx", () => {
  const ROWS = [
    ["日期", "金额", "备注"],
    ["2026-10-10", 38.5, "午饭, 和同事"],
    ["2026-10-11", 12000, '=HYPERLINK("http://x/","点我")'],
  ];

  const build = () =>
    buildXlsx(ROWS, { sheetName: "账目", numericColumns: [1], decimalColumns: [1] });

  it("contains every part a reader needs", () => {
    const parts = unzip(build());

    for (const name of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]) {
      expect(parts.has(name), `missing ${name}`).toBe(true);
    }
  });

  it("writes amounts as numbers, not text", () => {
    const sheet = unzip(build()).get("xl/worksheets/sheet1.xml") ?? "";

    // B2 holds 38.5. A number cell has <v> and no t="inlineStr".
    expect(sheet).toContain("<c r=\"B2\" s=\"2\"><v>38.5</v></c>");
    expect(sheet).not.toContain('t="inlineStr"><is><t xml:space="preserve">38.5');
  });

  it("applies the two-decimal format to the amount column", () => {
    const styles = unzip(build()).get("xl/styles.xml") ?? "";
    expect(styles).toContain('numFmtId="2"');
  });

  it("writes text as inline strings", () => {
    const sheet = unzip(build()).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain("午饭, 和同事");
  });

  it("escapes XML in the cell text rather than breaking the file", () => {
    const sheet = unzip(build()).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain("&quot;点我&quot;");
    expect(sheet).not.toContain('="http://x/"');
  });

  it("names the sheet", () => {
    expect(unzip(build()).get("xl/workbook.xml")).toContain('name="账目"');
  });

  it("declares the used range", () => {
    const sheet = unzip(build()).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('<dimension ref="A1:C3"/>');
  });

  it("survives a row with a null cell", () => {
    const archive = buildXlsx([["a", null, "c"]], { numericColumns: [] });
    const sheet = unzip(archive).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('<c r="B1"/>');
  });

  it("is a real ZIP: the first bytes are the local header signature", () => {
    const archive = build();
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
  });
});
