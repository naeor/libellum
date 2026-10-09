import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createPrismaClient } from "../src/db.js";

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
 * Order matters: `transactions.category_id` is ON DELETE RESTRICT, so entries
 * must go before the categories they point at.
 */
async function resetDatabase(): Promise<void> {
  await prisma.transactionTag.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.category.deleteMany();
  await prisma.paymentMethod.deleteMany();
  await prisma.bookMember.deleteMany();
  await prisma.book.deleteMany();
  await prisma.session.deleteMany();
  await prisma.registrationInvite.deleteMany();
  await prisma.user.deleteMany();
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
    occurredTz: "Asia/Shanghai",
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

describe("ledger bootstrap", () => {
  it("gives a new account a book, the preset categories and payment methods", async () => {
    const cookie = await signUp("mama");
    const ledger = await ledgerOf(cookie);

    expect(ledger.book.name).toBe("我的账本");
    expect(ledger.paymentMethods.map((method) => method.name)).toEqual([
      "微信",
      "支付宝",
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

  it("refuses a category that belongs to another kind", async () => {
    const cookie = await signUp("mama");
    const ledger = await ledgerOf(cookie);
    const salary = ledger.categories.find((category) => category.name === "工资");

    // 工资 is an income category; filing an expense under it must not work.
    const response = await record(cookie, { kind: "expense", categoryId: salary?.id });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "category_invalid" });
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
