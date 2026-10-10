import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createPrismaClient } from "../src/db.js";
import { resetDatabase as resetAllTables } from "./support.js";

const prisma = createPrismaClient(process.env["DATABASE_URL"] ?? "");

function makeApp(): FastifyInstance {
  return buildApp({
    version: "0.1.0-test",
    checkDatabase: async () => true,
    prisma,
    webOrigin: "http://localhost:5173",
    cookieSecure: false,
    loginThrottleOptions: { maxFailures: 50, lockoutMs: 1_000, windowMs: 60_000 },
  });
}

function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") throw new Error("response did not set a cookie");
  return value.split(";")[0] ?? "";
}

/**
 * Delegates to the shared reset so a new table can never be forgotten in one
 * suite but not another.
 */
async function resetDatabase(): Promise<void> {
  await resetAllTables();
}

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = makeApp();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Register a fresh account and return its session cookie. */
async function signUp(username: string): Promise<string> {
  // Registration upper-cases the code before looking it up, so store it that way.
  const code = `INVITE-${username}`.toUpperCase();
  await prisma.registrationInvite.create({ data: { code } });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      inviteCode: code,
      username,
      displayName: username,
      password: "correct-horse-battery",
    },
  });

  expect(response.statusCode).toBe(201);
  return cookieFrom(response.headers);
}

interface EntryOverrides {
  readonly kind?: "income" | "expense" | undefined;
  readonly amountCents?: number | undefined;
  readonly currency?: string | undefined;
  readonly categoryId?: string | null | undefined;
  readonly occurredLocalDate?: string | undefined;
  /** The clock the entry was recorded on; the duplicate check reads it. */
  readonly occurredTz?: string | undefined;
  readonly note?: string | undefined;
  readonly tagIds?: string[] | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly id?: string | undefined;
}

function entryPayload(overrides: EntryOverrides = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? randomUUID(),
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    kind: overrides.kind ?? "expense",
    amountCents: overrides.amountCents ?? 1_250,
    currency: overrides.currency ?? "CNY",
    categoryId: overrides.categoryId ?? null,
    paymentMethodId: null,
    occurredAt: "2026-10-09T13:45:30.000+08:00",
    occurredLocalDate: overrides.occurredLocalDate ?? "2026-10-09",
    occurredTz: overrides.occurredTz ?? "Asia/Shanghai",
    note: overrides.note ?? null,
    tagIds: overrides.tagIds ?? [],
  };
}

async function record(cookie: string, overrides: EntryOverrides = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/transactions",
    headers: { cookie },
    payload: entryPayload(overrides),
  });
}

async function ledgerOf(cookie: string) {
  const response = await app.inject({ method: "GET", url: "/api/v1/ledger", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    book: { id: string; name: string };
    categories: { id: string; name: string; kind: string; isSystem: boolean }[];
    paymentMethods: { id: string; name: string }[];
    tags: { id: string; name: string; color: string }[];
  };
}

describe("ledger numbers", () => {
  /** The number of an account's own ledger. */
  async function bookNumberOf(cookie: string): Promise<string | null> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ledger",
      headers: { cookie },
    });
    return (response.json() as { book: { bookNumber: string | null } }).book.bookNumber;
  }

  it("are allocated from the ledger block, in sequence", async () => {
    const first = await signUp("mama");
    const second = await signUp("baba");

    const a = Number(await bookNumberOf(first));
    const b = Number(await bookNumberOf(second));

    expect(a).toBe(40_000_000);
    expect(b).toBe(a + 1);
  });

  it("never collide with account numbers", async () => {
    // The owner chose the ledger block so the two kinds of number are not
    // mistaken for one another. This is the assertion behind that choice.
    const cookie = await signUp("mama");

    const ledger = await app.inject({
      method: "GET",
      url: "/api/v1/ledger",
      headers: { cookie },
    });
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });

    const book = (ledger.json() as { book: { bookNumber: string } }).book.bookNumber;
    const account = (me.json() as { user: { accountNumber: string } }).user.accountNumber;

    expect(book.slice(0, 2)).toBe("40");
    expect(account.slice(0, 2)).toBe("10");
    expect(book).not.toBe(account);
  });

  it("gives two accounts their own ledger, each numbered", async () => {
    const mama = await signUp("mama");
    const baba = await signUp("baba");

    expect(await bookNumberOf(mama)).not.toBe(await bookNumberOf(baba));
  });

  it("refuses a number that is not eight digits", async () => {
    const cookie = await signUp("mama");
    const ledger = await app.inject({
      method: "GET",
      url: "/api/v1/ledger",
      headers: { cookie },
    });
    const bookId = (ledger.json() as { book: { id: string } }).book.id;

    // The CHECK constraint, not application code: a short number would break the
    // "read it out loud" promise the whole scheme rests on.
    await expect(
      prisma.book.update({ where: { id: bookId }, data: { bookNumber: "1234" } }),
    ).rejects.toThrow();
  });

  it("refuses to give two ledgers the same number", async () => {
    const mama = await signUp("mama");
    const baba = await signUp("baba");

    const mamaLedger = await app.inject({
      method: "GET",
      url: "/api/v1/ledger",
      headers: { cookie: mama },
    });
    const babaLedger = await app.inject({
      method: "GET",
      url: "/api/v1/ledger",
      headers: { cookie: baba },
    });

    const taken = (mamaLedger.json() as { book: { bookNumber: string } }).book.bookNumber;
    const other = (babaLedger.json() as { book: { id: string } }).book.id;

    await expect(
      prisma.book.update({ where: { id: other }, data: { bookNumber: taken } }),
    ).rejects.toThrow();
  });
});

describe("invite lifetimes", () => {
  /** Try to register with a code and report what the server said. */
  async function registerWith(code: string, username: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        inviteCode: code,
        username,
        displayName: "测试",
        password: "invite-test-password",
      },
    });
  }

  it("refuses a code that was revoked, and says so", async () => {
    // The owner asked for revocation on 2026-10-10. The message matters as much
    // as the refusal: "邀请码无效" would send somebody looking for a typo instead
    // of asking the person who sent it.
    await prisma.registrationInvite.create({
      data: { code: "REVOKED-1", revokedAt: new Date() },
    });

    const response = await registerWith("REVOKED-1", "revokedone");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invite_revoked" });
    expect((response.json() as { message: string }).message).toContain("撤销");
  });

  it("refuses a code whose seven days are up", async () => {
    await prisma.registrationInvite.create({
      data: { code: "EXPIRED-1", expiresAt: new Date(Date.now() - 1_000) },
    });

    const response = await registerWith("EXPIRED-1", "expiredone");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invite_expired" });
  });

  it("accepts an ordinary code inside its window", async () => {
    await prisma.registrationInvite.create({
      data: { code: "LIVE-1", expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1_000) },
    });

    const response = await registerWith("LIVE-1", "liveone");

    expect(response.statusCode, response.body).toBe(201);
  });

  it("still accepts a reserved code, which has no deadline", async () => {
    // The exception that makes the batch possible: a code written on a card and
    // handed over months later cannot have a seven-day life.
    await prisma.registrationInvite.create({
      data: { code: "RESERVED-NODATE", accountNumber: "10000080", expiresAt: null },
    });

    const response = await registerWith("RESERVED-NODATE", "reservednodate");

    expect(response.statusCode, response.body).toBe(201);
    expect((response.json() as { user: { accountNumber: string } }).user.accountNumber).toBe(
      "10000080",
    );
  });

  it("reports 'used' rather than 'expired' for a code that is both", async () => {
    // The order of the checks is decided once, in `shared`. A used code that has
    // since expired should not send its holder looking for a replacement.
    await prisma.registrationInvite.create({
      data: {
        code: "USED-AND-OLD",
        usedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const response = await registerWith("USED-AND-OLD", "usedandold");

    expect(response.json()).toMatchObject({ code: "invite_used" });
  });
});

describe("account numbers", () => {
  /** The number an account ended up with. */
  async function numberOf(cookie: string): Promise<string> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    return (response.json() as { user: { accountNumber: string } }).user.accountNumber;
  }

  it("are allocated in sequence, not at random", async () => {
    const first = await signUp("mama");
    const second = await signUp("baba");

    expect(Number(await numberOf(second))).toBe(Number(await numberOf(first)) + 1);
  });

  it("gives an invite's reserved number to the account it registers", async () => {
    // The owner's requirement in one test: a code is written down carrying the
    // number it will grant, so a batch can be handed out before anyone uses it.
    await prisma.registrationInvite.create({
      data: { code: "RESERVED-ONE", accountNumber: "10000042" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        inviteCode: "RESERVED-ONE",
        username: "reserved",
        displayName: "预留编号",
        password: "reserved-password-2026",
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect((response.json() as { user: { accountNumber: string } }).user.accountNumber).toBe(
      "10000042",
    );
  });

  it("does not let a reserved number disturb the ordinary sequence", async () => {
    /**
     * The flaw this guards was found while building it: one counter serving both
     * jobs means a batch of codes pushes it past the reserved block, and the
     * next account without a code is allocated *inside* the block the owner is
     * still handing out — two accounts, one number.
     */
    await prisma.registrationInvite.create({
      data: { code: "RESERVED-TWO", accountNumber: "10000050" },
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        inviteCode: "RESERVED-TWO",
        username: "reservedtwo",
        displayName: "预留",
        password: "reserved-password-2026",
      },
    });

    const direct = await signUp("mama");

    expect(await numberOf(direct)).toBe("10000101");
  });

  it("makes an administrator only when the code says so", async () => {
    await prisma.registrationInvite.create({
      data: { code: "RESERVED-ADMIN", accountNumber: "10000060", grantsAdmin: true },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        inviteCode: "RESERVED-ADMIN",
        username: "reservedadmin",
        displayName: "管理员",
        password: "reserved-password-2026",
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    const row = await prisma.user.findUniqueOrThrow({
      where: { username: "reservedadmin" },
      select: { isAdmin: true, accountNumber: true },
    });
    expect(row.accountNumber).toBe("10000060");
    expect(row.isAdmin).toBe(true);
  });

  it("does not make a reserved number an administrator by itself", async () => {
    /**
     * ⚠️ **The bug the owner caught.**
     *
     * Registration used to decide administration from `accountNumber !== null`,
     * so *any* code that reserved a number produced an administrator — including
     * `invite:create --reserved` and the whole batch generator, which are
     * ordinary commands somebody might run for a family member.
     *
     * Reserving a number and granting administration are now separate facts.
     * This test is the one that would have caught it: a code with a reserved
     * number and no flag must produce an ordinary account.
     */
    await prisma.registrationInvite.create({
      data: { code: "RESERVED-PLAIN", accountNumber: "10000061", grantsAdmin: false },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        inviteCode: "RESERVED-PLAIN",
        username: "reservedplain",
        displayName: "普通",
        password: "reserved-password-2026",
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    const row = await prisma.user.findUniqueOrThrow({
      where: { username: "reservedplain" },
      select: { isAdmin: true, accountNumber: true },
    });
    expect(row.accountNumber).toBe("10000061");
    expect(row.isAdmin).toBe(false);
  });

  it("leaves an ordinary signup out of the administrators", async () => {
    const cookie = await signUp("mama");

    const row = await prisma.user.findUniqueOrThrow({
      where: { accountNumber: await numberOf(cookie) },
      select: { isAdmin: true },
    });
    expect(row.isAdmin).toBe(false);
  });

  it("refuses to put the same reserved number on two invites", async () => {
    await prisma.registrationInvite.create({
      data: { code: "DUP-ONE", accountNumber: "10000070" },
    });

    // The unique index is the backstop for the whole scheme: if two codes could
    // reserve one number, two people would end up sharing it.
    await expect(
      prisma.registrationInvite.create({
        data: { code: "DUP-TWO", accountNumber: "10000070" },
      }),
    ).rejects.toThrow();
  });
});

describe("ledger bootstrap", () => {
  it("gives a new account a book, the preset categories and payment methods", async () => {
    const cookie = await signUp("mama");
    const ledger = await ledgerOf(cookie);

    expect(ledger.book.name).toBe("我的账本");
    expect(ledger.paymentMethods.map((method) => method.name)).toEqual([
      "微信",
      "支付宝",
      "银行卡",
      "现金",
      "其他",
    ]);

    const expense = ledger.categories.filter((category) => category.kind === "expense");
    const income = ledger.categories.filter((category) => category.kind === "income");

    // 9 expense + 1 system, 6 income + 1 system.
    expect(expense).toHaveLength(10);
    expect(income).toHaveLength(7);
    expect(expense.filter((category) => category.isSystem)).toHaveLength(1);
    expect(income.filter((category) => category.isSystem)).toHaveLength(1);
    expect(ledger.categories.find((category) => category.isSystem)?.name).toBe("暂无分类");
  });

  it("keeps every account's ledger to itself", async () => {
    const mama = await signUp("mama");
    const baba = await signUp("baba");

    const mamaLedger = await ledgerOf(mama);
    const babaLedger = await ledgerOf(baba);

    expect(mamaLedger.book.id).not.toBe(babaLedger.book.id);
    expect(mamaLedger.categories[0]?.id).not.toBe(babaLedger.categories[0]?.id);
  });
});

describe("POST /api/v1/transactions/duplicates", () => {
  /** Record an entry and answer with it. */
  async function record(cookie: string, overrides: EntryOverrides = {}) {
    return app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: { cookie },
      payload: entryPayload(overrides),
    });
  }

  /** Ask whether an entry like this one exists. */
  async function check(
    cookie: string,
    body: {
      kind?: string;
      amountCents?: number;
      currency?: string;
      occurredLocalDate?: string;
      occurredTime?: string;
    },
  ) {
    return app.inject({
      method: "POST",
      url: "/api/v1/transactions/duplicates",
      headers: { cookie },
      payload: {
        kind: "expense",
        amountCents: 1_250,
        currency: "CNY",
        occurredLocalDate: "2026-10-09",
        // `entryPayload` writes 13:45 +08:00 on 2026-10-09, which is 13:45 on
        // that clock — the wall-clock reading is what the check compares.
        occurredTime: "13:45",
        ...body,
      },
    });
  }

  it("finds an entry with the same five fields", async () => {
    const cookie = await signUp("mama");
    await record(cookie);

    const response = await check(cookie, {});

    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as { duplicates: unknown[] }).duplicates).toHaveLength(1);
  });

  it("finds nothing when the amount differs", async () => {
    const cookie = await signUp("mama");
    await record(cookie);

    const response = await check(cookie, { amountCents: 1_251 });

    expect((response.json() as { duplicates: unknown[] }).duplicates).toHaveLength(0);
  });

  it("finds nothing when the time differs", async () => {
    // The point of comparing the time: the same amount on the same day is
    // ordinary, and warning about it would train people to dismiss the warning.
    const cookie = await signUp("mama");
    await record(cookie);

    const response = await check(cookie, { occurredTime: "13:46" });

    expect((response.json() as { duplicates: unknown[] }).duplicates).toHaveLength(0);
  });

  it("reads the time on the entry's own clock, not the server's", async () => {
    // The stored pair is an absolute instant plus a zone. An entry recorded at
    // 13:45 in Shanghai is 05:45 UTC, and a check that compared UTC would miss
    // every duplicate made anywhere east of Greenwich.
    const cookie = await signUp("mama");
    await record(cookie, { occurredTz: "Asia/Shanghai" });

    expect((await check(cookie, { occurredTime: "13:45" })).json()).toMatchObject({
      duplicates: expect.any(Array),
    });
    expect((await check(cookie, {})).json()).toMatchObject({ duplicates: expect.any(Array) });

    const asUtc = await check(cookie, { occurredTime: "05:45" });
    expect((asUtc.json() as { duplicates: unknown[] }).duplicates).toHaveLength(0);
  });

  it("ignores an entry that was deleted", async () => {
    // A tombstone is not an entry the user can see, so warning about one would
    // point at something that is not on their screen.
    const cookie = await signUp("mama");
    const created = await record(cookie);
    const id = (created.json() as { id: string }).id;

    await app.inject({
      method: "DELETE",
      url: `/api/v1/transactions/${id}`,
      headers: { cookie },
      payload: { version: 1 },
    });

    const response = await check(cookie, {});

    expect((response.json() as { duplicates: unknown[] }).duplicates).toHaveLength(0);
  });

  it("does not see another account's entries", async () => {
    const mama = await signUp("mama");
    const baba = await signUp("baba");
    await record(mama);

    const response = await check(baba, {});

    expect((response.json() as { duplicates: unknown[] }).duplicates).toHaveLength(0);
  });

  it("refuses a malformed time rather than guessing", async () => {
    const cookie = await signUp("mama");

    const response = await check(cookie, { occurredTime: "25:99" });

    expect(response.statusCode).toBe(400);
  });

  it("treats an empty time as 'no time recorded'", async () => {
    // The form sends "" when the field is untouched, so it has to mean
    // "recorded without a time" — not "matches everything".
    const cookie = await signUp("mama");
    await record(cookie);

    const response = await check(cookie, { occurredTime: "" });

    expect((response.json() as { duplicates: unknown[] }).duplicates).toHaveLength(0);
  });
});

describe("POST /api/v1/transactions", () => {
  it("records an entry and returns it in full", async () => {
    const cookie = await signUp("mama");
    const response = await record(cookie, { amountCents: 1_250, note: "午饭" });

    expect(response.statusCode).toBe(201);

    const body = response.json() as Record<string, unknown>;
    expect(body["amountCents"]).toBe(1_250);
    expect(body["currency"]).toBe("CNY");
    expect(body["note"]).toBe("午饭");
    expect(body["occurredLocalDate"]).toBe("2026-10-09");
    expect(body["occurredTz"]).toBe("Asia/Shanghai");
    expect(body["version"]).toBe(1);
    // No category was chosen, so it lands in the hidden system category.
    expect(body["categoryName"]).toBe("暂无分类");
    expect(body["categoryIsSystem"]).toBe(true);
  });

  it("files an entry under the category that was chosen", async () => {
    const cookie = await signUp("mama");
    const ledger = await ledgerOf(cookie);
    const dining = ledger.categories.find((category) => category.name === "餐饮");

    const response = await record(cookie, { categoryId: dining?.id });

    expect(response.statusCode).toBe(201);
    expect((response.json() as { categoryName: string }).categoryName).toBe("餐饮");
  });

  it("refuses a category that belongs to another kind, and says which mismatch it is", async () => {
    const cookie = await signUp("mama");
    const ledger = await ledgerOf(cookie);
    const salary = ledger.categories.find((category) => category.name === "工资");

    // 工资 is an income category; filing an expense under it must not work.
    const response = await record(cookie, { kind: "expense", categoryId: salary?.id });

    expect(response.statusCode).toBe(403);
    // A code of its own, not the generic one. The old message — "分类不存在或不属于
    // 该账本" — was untrue here: the category exists and it does belong to this
    // book. A message that names the wrong fault sends the reader after a
    // permissions problem that is not there.
    expect(response.json()).toMatchObject({ code: "category_kind_mismatch" });
    expect((response.json() as { message: string }).message).toContain("工资");
  });

  it("files an entry under 暂无分类 when the other kind's 暂无分类 is sent", async () => {
    const cookie = await signUp("mama");
    const ledger = await ledgerOf(cookie);
    const incomeNone = ledger.categories.find(
      (category) => category.name === "暂无分类" && category.kind === "income",
    );

    // The owner's report, in one line: the screenshot-recognition screen offered
    // the previous entry's category, the new entry was an expense, and the id it
    // carried was the income side's "no category". Nobody chose anything, so
    // there is nothing to correct — the entry belongs in the ledger.
    const response = await record(cookie, { kind: "expense", categoryId: incomeNone?.id });

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as { categoryName: string; categoryIsSystem: boolean };
    expect(body.categoryName).toBe("暂无分类");
    expect(body.categoryIsSystem).toBe(true);
  });

  it("accepts an empty categoryId as 'nothing chosen'", async () => {
    const cookie = await signUp("mama");

    // A `<select>` with an empty option hands back `""`. Reading it as a
    // malformed UUID was a validation error for the most ordinary action there
    // is: not picking a category.
    const response = await record(cookie, { categoryId: "" });

    expect(response.statusCode, response.body).toBe(201);
    expect((response.json() as { categoryName: string }).categoryName).toBe("暂无分类");
  });

  it("refuses a category that belongs to another account", async () => {
    const mama = await signUp("mama");
    const baba = await signUp("baba");
    const babaLedger = await ledgerOf(baba);

    const response = await record(mama, { categoryId: babaLedger.categories[0]?.id });

    expect(response.statusCode).toBe(403);
  });

  it("is idempotent: the same key twice creates a single entry", async () => {
    const cookie = await signUp("mama");
    const idempotencyKey = randomUUID();

    const first = await record(cookie, { idempotencyKey, amountCents: 999 });
    const second = await record(cookie, { idempotencyKey, amountCents: 999, id: randomUUID() });

    expect(first.statusCode).toBe(201);
    // The retry is not an error: it returns the entry that already exists.
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
    expect(await prisma.transaction.count()).toBe(1);
  });

  it("rejects an amount that is not a whole number of cents", async () => {
    const cookie = await signUp("mama");
    const response = await record(cookie, { amountCents: 12.5 });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_failed" });
  });
});

describe("GET /api/v1/transactions", () => {
  it("returns entries newest first and pages with a stable cursor", async () => {
    const cookie = await signUp("mama");

    for (const day of ["2026-10-01", "2026-10-05", "2026-10-09"]) {
      await record(cookie, { occurredLocalDate: day, amountCents: 100 });
    }

    const firstPage = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?month=2026-10&limit=2",
      headers: { cookie },
    });

    const page = firstPage.json() as {
      items: { occurredLocalDate: string }[];
      nextCursor: string | null;
    };

    expect(page.items.map((item) => item.occurredLocalDate)).toEqual(["2026-10-09", "2026-10-05"]);
    expect(page.nextCursor).not.toBeNull();

    const secondPage = await app.inject({
      method: "GET",
      url: `/api/v1/transactions?month=2026-10&limit=2&cursor=${encodeURIComponent(page.nextCursor ?? "")}`,
      headers: { cookie },
    });

    const rest = secondPage.json() as {
      items: { occurredLocalDate: string }[];
      nextCursor: string | null;
    };

    expect(rest.items.map((item) => item.occurredLocalDate)).toEqual(["2026-10-01"]);
    expect(rest.nextCursor).toBeNull();
  });

  it("filters by month so other months never leak in", async () => {
    const cookie = await signUp("mama");
    await record(cookie, { occurredLocalDate: "2026-09-30" });
    await record(cookie, { occurredLocalDate: "2026-10-01" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?month=2026-10",
      headers: { cookie },
    });

    const body = response.json() as { items: { occurredLocalDate: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.occurredLocalDate).toBe("2026-10-01");
  });

  it("never returns another account's entries", async () => {
    const mama = await signUp("mama");
    const baba = await signUp("baba");

    const created = await record(mama, { note: "妈妈的账" });
    const id = (created.json() as { id: string }).id;

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/transactions",
      headers: { cookie: baba },
    });
    expect((list.json() as { items: unknown[] }).items).toHaveLength(0);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/transactions/${id}`,
      headers: { cookie: baba },
    });
    expect(detail.statusCode).toBe(404);
  });
});

describe("GET /api/v1/summary", () => {
  it("totals each currency separately and ranks them by volume", async () => {
    const cookie = await signUp("mama");

    await record(cookie, { kind: "expense", amountCents: 100_000, currency: "CNY" });
    await record(cookie, { kind: "income", amountCents: 50_000, currency: "CNY" });
    await record(cookie, { kind: "expense", amountCents: 900, currency: "USD" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/summary?month=2026-10",
      headers: { cookie },
    });

    const body = response.json() as {
      currencies: {
        currency: string;
        expenseCents: number;
        incomeCents: number;
        balanceCents: number;
        volumeCents: number;
      }[];
    };

    expect(body.currencies).toHaveLength(2);
    // ¥1500 of activity outranks $9, and the two are never added together.
    expect(body.currencies[0]).toMatchObject({
      currency: "CNY",
      expenseCents: 100_000,
      incomeCents: 50_000,
      balanceCents: -50_000,
      volumeCents: 150_000,
    });
    expect(body.currencies[1]).toMatchObject({ currency: "USD", expenseCents: 900 });
  });
});

describe("PATCH and DELETE /api/v1/transactions/:id", () => {
  it("refuses an update built on a stale version", async () => {
    const cookie = await signUp("mama");
    const created = await record(cookie, { amountCents: 100 });
    const id = (created.json() as { id: string }).id;

    await app.inject({
      method: "PATCH",
      url: `/api/v1/transactions/${id}`,
      headers: { cookie },
      payload: { amountCents: 200, version: 1 },
    });

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/transactions/${id}`,
      headers: { cookie },
      payload: { amountCents: 300, version: 1 },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "version_conflict" });
  });

  it("soft-deletes: gone from the list, still in the table", async () => {
    const cookie = await signUp("mama");
    const created = await record(cookie);
    const id = (created.json() as { id: string }).id;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/transactions/${id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/transactions",
      headers: { cookie },
    });
    expect((list.json() as { items: unknown[] }).items).toHaveLength(0);

    // The row survives as a tombstone so an offline device can learn it is gone.
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.version).toBe(2);
  });
});
