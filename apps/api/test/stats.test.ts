import { comparisonRangeFor } from "@libellum/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { cookieFrom, ledgerOf, makeApp, resetDatabase, signUp } from "./support.js";

/**
 * The statistics endpoint.
 *
 * These tests care about the arithmetic a chart will trust: that a day's
 * spending lands in the right day, that a month bucket is the sum of its days,
 * that shares are shares *of their own kind*, and that the comparison period
 * does not quietly compare a half-finished month with a finished one.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = makeApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase();
});

interface Recorded {
  readonly day: string;
  readonly kind: "expense" | "income";
  readonly minor: number;
  readonly category?: "餐饮" | "购物";
  readonly currency?: string;
}

async function record(cookie: string, entries: readonly Recorded[]): Promise<void> {
  const ledger = await ledgerOf(app, cookie);

  for (const [index, entry] of entries.entries()) {
    const category = ledger.categories.find(
      (item) => item.kind === entry.kind && (entry.category === undefined || item.name === entry.category),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: { cookie },
      payload: {
        id: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        kind: entry.kind,
        amountCents: entry.minor,
        currency: entry.currency ?? "CNY",
        categoryId: category?.id ?? null,
        paymentMethodId: null,
        occurredAt: `${entry.day}T12:00:00.000+08:00`,
        occurredLocalDate: entry.day,
        occurredTz: "Asia/Shanghai",
        note: `entry-${String(index)}`,
        tagIds: [],
      },
    });

    expect(response.statusCode).toBe(201);
  }
}

async function stats(
  cookie: string,
  query: Record<string, string>,
): Promise<Record<string, unknown>> {
  const search = new URLSearchParams(query).toString();
  const response = await app.inject({ method: "GET", url: `/api/v1/stats?${search}`, headers: { cookie } });

  expect(response.statusCode).toBe(200);

  return response.json() as Record<string, unknown>;
}

describe("GET /stats", () => {
  it("totals a period and splits it by day", async () => {
    const cookie = await signUp(app, "mama");
    await record(cookie, [
      { day: "2026-10-01", kind: "expense", minor: 1200, category: "餐饮" },
      { day: "2026-10-01", kind: "expense", minor: 800, category: "购物" },
      { day: "2026-10-03", kind: "income", minor: 5000 },
    ]);

    const body = await stats(cookie, { from: "2026-10-01", to: "2026-10-03", currency: "CNY" });

    expect(body["totals"]).toMatchObject({
      expenseMinor: 2000,
      incomeMinor: 5000,
      netMinor: 3000,
      count: 3,
      largestExpenseMinor: 1200,
    });
    expect(body["range"]).toMatchObject({ days: 3 });
  });

  it("gives every day a bucket, including the ones with nothing in them", async () => {
    const cookie = await signUp(app, "papa");
    await record(cookie, [{ day: "2026-10-02", kind: "expense", minor: 900 }]);

    const body = await stats(cookie, { from: "2026-10-01", to: "2026-10-04", currency: "CNY" });
    const series = body["series"] as { bucket: string; expenseMinor: number }[];

    // A gap on a chart must read as "nothing spent", not as missing data.
    expect(series.map((point) => point.bucket)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(series.map((point) => point.expenseMinor)).toEqual([0, 900, 0, 0]);
  });

  it("folds days into months when asked", async () => {
    const cookie = await signUp(app, "sister");
    await record(cookie, [
      { day: "2026-09-30", kind: "expense", minor: 100 },
      { day: "2026-10-01", kind: "expense", minor: 200 },
      { day: "2026-10-31", kind: "expense", minor: 300 },
    ]);

    const body = await stats(cookie, {
      from: "2026-09-01",
      to: "2026-10-31",
      bucket: "month",
      currency: "CNY",
    });
    const series = body["series"] as { bucket: string; expenseMinor: number }[];

    expect(series).toEqual([
      { bucket: "2026-09", expenseMinor: 100, incomeMinor: 0 },
      { bucket: "2026-10", expenseMinor: 500, incomeMinor: 0 },
    ]);
  });

  it("keeps currencies apart", async () => {
    const cookie = await signUp(app, "uncle");
    await record(cookie, [
      { day: "2026-10-01", kind: "expense", minor: 1000, currency: "CNY" },
      { day: "2026-10-01", kind: "expense", minor: 3000, currency: "JPY" },
    ]);

    const cny = await stats(cookie, { from: "2026-10-01", to: "2026-10-01", currency: "CNY" });
    const jpy = await stats(cookie, { from: "2026-10-01", to: "2026-10-01", currency: "JPY" });

    // ¥10 in yuan and ¥3000 in yen are not the same currency and must never be
    // added together, whatever the numbers look like.
    expect((cny["totals"] as { expenseMinor: number }).expenseMinor).toBe(1000);
    expect((jpy["totals"] as { expenseMinor: number }).expenseMinor).toBe(3000);
  });

  it("computes each category's share of its own kind", async () => {
    const cookie = await signUp(app, "aunt");
    await record(cookie, [
      { day: "2026-10-01", kind: "expense", minor: 750, category: "餐饮" },
      { day: "2026-10-01", kind: "expense", minor: 250, category: "购物" },
      { day: "2026-10-01", kind: "income", minor: 10_000 },
    ]);

    const body = await stats(cookie, { from: "2026-10-01", to: "2026-10-01", currency: "CNY" });
    const byCategory = body["byCategory"] as { name: string; kind: string; minor: number; share: number }[];

    const dining = byCategory.find((item) => item.name === "餐饮");
    const shopping = byCategory.find((item) => item.name === "购物");

    // Shares of *expense*: 10000 of income must not dilute them.
    expect(dining?.share).toBeCloseTo(0.75);
    expect(shopping?.share).toBeCloseTo(0.25);
  });

  it("returns an empty result rather than failing when there is nothing", async () => {
    const cookie = await signUp(app, "cousin");

    const body = await stats(cookie, { from: "2026-10-01", to: "2026-10-31", currency: "CNY" });

    expect(body["totals"]).toMatchObject({ expenseMinor: 0, incomeMinor: 0, count: 0 });
    expect(body["byCategory"]).toEqual([]);
    // Every day of the month is still present, all zero.
    expect(body["series"]).toHaveLength(31);
  });

  it("compares with the period it is given, and omits it when none is", async () => {
    const cookie = await signUp(app, "grandma");
    await record(cookie, [
      { day: "2026-09-05", kind: "expense", minor: 400 },
      { day: "2026-10-05", kind: "expense", minor: 600 },
    ]);

    const withoutComparison = await stats(cookie, {
      from: "2026-10-01",
      to: "2026-10-09",
      currency: "CNY",
    });
    expect(withoutComparison["comparison"]).toBeNull();

    const withComparison = await stats(cookie, {
      from: "2026-10-01",
      to: "2026-10-09",
      currency: "CNY",
      compareFrom: "2026-09-01",
      compareTo: "2026-09-09",
    });

    expect(withComparison["comparison"]).toMatchObject({
      range: { from: "2026-09-01", to: "2026-09-09" },
      totals: { expenseMinor: 400 },
    });
  });

  it("excludes deleted entries", async () => {
    const cookie = await signUp(app, "grandpa");
    await record(cookie, [{ day: "2026-10-01", kind: "expense", minor: 500 }]);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/transactions?from=2026-10-01&to=2026-10-31",
      headers: { cookie },
    });
    const entries = (list.json() as { items: { id: string }[] }).items;
    const first = entries[0];
    expect(first).toBeDefined();

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/transactions/${String(first?.id)}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(204);

    const body = await stats(cookie, { from: "2026-10-01", to: "2026-10-31", currency: "CNY" });
    expect((body["totals"] as { expenseMinor: number }).expenseMinor).toBe(0);
  });

  it("rejects a backwards range and a range longer than a year", async () => {
    const cookie = await signUp(app, "neighbour");

    const backwards = await app.inject({
      method: "GET",
      url: "/api/v1/stats?from=2026-10-09&to=2026-10-01&currency=CNY",
      headers: { cookie },
    });
    expect(backwards.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: "GET",
      url: "/api/v1/stats?from=2020-01-01&to=2026-10-09&currency=CNY",
      headers: { cookie },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("requires a session", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/stats?from=2026-10-01&to=2026-10-09&currency=CNY",
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("the comparison period a month-to-date view uses", () => {
  it("is the same stretch of the previous month, not the whole of it", () => {
    // The rule the endpoint is fed by. Checking it next to the endpoint keeps
    // the two from drifting apart.
    expect(comparisonRangeFor({ from: "2026-10-01", to: "2026-10-09" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-09",
    });
  });
});

/** Keeps the cookie helper imported for future cases in this file. */
void cookieFrom;
