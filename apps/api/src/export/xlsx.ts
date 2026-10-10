import { buildZip } from "./zip.js";

/**
 * Write a single-sheet XLSX.
 *
 * An XLSX is a ZIP of XML parts. The parts written here are the minimum Excel,
 * LibreOffice and WPS all accept: content types, package relationships, the
 * workbook, one worksheet, and a style sheet.
 *
 * Text is written **inline** (`t="inlineStr"`) rather than through a shared
 * string table. A shared table makes a file smaller when many cells repeat, and
 * for an export of a few hundred rows the saving is irrelevant next to the extra
 * indirection and the extra chance of writing an index that points at nothing.
 *
 * The one thing that genuinely matters: **numbers are written as numbers.** An
 * export whose amounts land in the spreadsheet as text cannot be summed, which
 * defeats the main reason somebody exports a ledger at all. `numericColumns`
 * exists so that rule is stated by the caller rather than guessed from the
 * string — `"12.34"` and `12.34` are the same characters and must not be.
 */

export interface XlsxOptions {
  /** Sheet name, as shown on the tab. Excel refuses more than 31 characters. */
  readonly sheetName?: string;
  /** Zero-based column indexes whose values must be written as numbers. */
  readonly numericColumns: readonly number[];
  /** Zero-based column indexes to render with two decimal places. */
  readonly decimalColumns?: readonly number[];
  /** Column widths in characters, by zero-based index. */
  readonly columnWidths?: Readonly<Record<number, number>>;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters are not legal in XML 1.0 and Excel refuses the file.
    // A note typed on a phone can contain them; the export should not break.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** `A`, `B`, … `Z`, `AA`, … */
function columnName(index: number): string {
  let name = "";
  let value = index;
  while (value >= 0) {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  }
  return name;
}

/**
 * One cell.
 *
 * The reference has to be the full `A1` form. An earlier version emitted
 * `r="A"` — the column without the row — which every reader rejects; a test
 * caught it, and it is the kind of mistake that would otherwise have surfaced as
 * "the exported file will not open".
 */
function cellXml(
  column: number,
  row: number,
  value: string | number | null,
  options: XlsxOptions,
): string {
  const ref = `${columnName(column)}${String(row)}`;

  if (value === null) return `<c r="${ref}"/>`;

  if (options.numericColumns.includes(column) && typeof value === "number") {
    const style = options.decimalColumns?.includes(column) === true ? 2 : undefined;
    const styleAttribute = style === undefined ? "" : ` s="${String(style)}"`;
    return `<c r="${ref}"${styleAttribute}><v>${String(value)}</v></c>`;
  }

  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

function rowsXml(rows: readonly (readonly (string | number | null)[])[], options: XlsxOptions): string {
  return rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, column) => cellXml(column, rowIndex + 1, value, options))
        .join("");
      return `<row r="${String(rowIndex + 1)}">${cells}</row>`;
    })
    .join("");
}

function columnsXml(options: XlsxOptions): string {
  const entries = Object.entries(options.columnWidths ?? {});
  if (entries.length === 0) return "";

  const columns = entries
    .map(([index, width]) => `<col min="${String(Number(index) + 1)}" max="${String(Number(index) + 1)}" width="${String(width)}" customWidth="1"/>`)
    .join("");

  return `<cols>${columns}</cols>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

function workbookXml(sheetName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

/**
 * Two cell formats: nothing, and two decimal places.
 *
 * `numFmtId="2"` is the built-in `0.00`, so no custom format has to be declared
 * — one less part that a reader could disagree about.
 */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

export function buildXlsx(
  rows: readonly (readonly (string | number | null)[])[],
  options: XlsxOptions,
): Buffer {
  const sheetName = (options.sheetName ?? "账目").slice(0, 31);

  const dimension =
    rows.length === 0
      ? "A1"
      : `A1:${columnName(Math.max(...rows.map((row) => row.length)) - 1)}${String(rows.length)}`;

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="${dimension}"/>
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${columnsXml(options)}
<sheetData>${rowsXml(rows, options)}</sheetData>
</worksheet>`;

  return buildZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "xl/workbook.xml", data: workbookXml(sheetName) },
    { name: "xl/_rels/workbook.xml.rels", data: WORKBOOK_RELS },
    { name: "xl/styles.xml", data: STYLES },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}
