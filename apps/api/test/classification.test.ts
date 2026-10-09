import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ledgerOf,
  makeApp,
  prisma,
  resetDatabase,
  signUp,
  type LedgerMeta,
} from "./support.js";

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

async function createCategory(cookie: string, name: string, kind: "expense" | "income") {
  return app.inject({
    method: "POST",
    url: "/api/v1/categories",
    headers: { cookie },
    payload: { name, kind },
  });
}

async function recordEntry(cookie: string, tagIds: string[]) {
  return app.inject({
    method: "POST",
    url: "/api/v1/transactions",
    headers: { cookie },
    payload: {
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: "expense",
      amountCents: 500,
      currency: "CNY",
      categoryId: null,
      paymentMethodId: null,
      occurredAt: "2026-10-09T12:00:00.000+08:00",
      occurredLocalDate: "2026-10-09",
      occurredTz: "Asia/Shanghai",
      note: null,
      tagIds,
    },
  });
}

function findCategory(ledger: LedgerMeta, name: string, kind: string) {
  return ledger.categories.find((category) => category.name === name && category.kind === kind);
}

describe("categories", () => {
  it("adds a custom category at the end of its own kind", async () => {
    const cookie = await signUp(app, "mama");
    const before = await ledgerOf(app, cookie);

    const response = await createCategory(cookie, "宠物", "expense");
    expect(response.statusCode).toBe(201);

    const after = await ledgerOf(app, cookie);
    const expense = after.categories.filter((category) => category.kind === "expense");
    const created = expense.at(-1);

    // 9 presets + 暂无分类 + the new one.
    expect(expense).toHaveLength(before.categories.filter((c) => c.kind === "expense").length + 1);
    expect(created?.name).toBe("宠物");
    expect(created?.isSystem).toBe(false);
  });

  it("refuses a duplicate within a kind but allows it across kinds", async () => {
    const cookie = await signUp(app, "mama");

    const first = await createCategory(cookie, "宠物", "expense");
    expect(first.statusCode).toBe(201);

    const duplicate = await createCategory(cookie, "宠物", "expense");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "category_exists" });

    // 转账 already exists as both an expense and an income preset; adding it
    // again as income must still be refused.
    const presetClash = await createCategory(cookie, "转账", "income");
    expect(presetClash.statusCode).toBe(409);

    // A different kind is a different list.
    const otherKind = await createCategory(cookie, "宠物", "income");
    expect(otherKind.statusCode).toBe(201);
  });

  it("renames and reorders a category", async () => {
    const cookie = await signUp(app, "mama");
    const created = await createCategory(cookie, "宠物", "expense");
    const id = (created.json() as { id: string }).id;

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${id}`,
      headers: { cookie },
      payload: { name: "宠物用品", sortOrder: 0 },
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "宠物用品", sortOrder: 0 });
  });

  it("archives a category and brings it back", async () => {
    const cookie = await signUp(app, "mama");
    const created = await createCategory(cookie, "宠物", "expense");
    const id = (created.json() as { id: string }).id;

    const archived = await app.inject({
      method: "DELETE",
      url: `/api/v1/categories/${id}`,
      headers: { cookie },
    });
    expect(archived.statusCode).toBe(204);

    // Still present — archived, not gone. Past entries must keep rendering it.
    const afterArchive = await ledgerOf(app, cookie);
    expect(findCategory(afterArchive, "宠物", "expense")?.isArchived).toBe(true);

    const restored = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${id}`,
      headers: { cookie },
      payload: { isArchived: false },
    });
    expect(restored.json()).toMatchObject({ isArchived: false });
  });

  it("refuses to rename or archive the system category", async () => {
    const cookie = await signUp(app, "mama");
    const ledger = await ledgerOf(app, cookie);
    const system = ledger.categories.find((category) => category.isSystem);

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${String(system?.id)}`,
      headers: { cookie },
      payload: { name: "其它" },
    });
    expect(rename.statusCode).toBe(403);
    expect(rename.json()).toMatchObject({ code: "category_system" });

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/categories/${String(system?.id)}`,
      headers: { cookie },
    });
    expect(remove.statusCode).toBe(403);
  });

  it("keeps one account's categories out of another's reach", async () => {
    const mama = await signUp(app, "mama");
    const baba = await signUp(app, "baba");

    const created = await createCategory(mama, "宠物", "expense");
    const id = (created.json() as { id: string }).id;

    const stolen = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${id}`,
      headers: { cookie: baba },
      payload: { name: "我的了" },
    });

    // 404, not 403: baba never learns that this id exists.
    expect(stolen.statusCode).toBe(404);
  });
});

describe("payment methods", () => {
  it("adds one at the end, refuses duplicates and archives", async () => {
    const cookie = await signUp(app, "mama");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/payment-methods",
      headers: { cookie },
      payload: { name: "信用卡" },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/payment-methods",
      headers: { cookie },
      payload: { name: "信用卡" },
    });
    expect(duplicate.statusCode).toBe(409);

    const archived = await app.inject({
      method: "DELETE",
      url: `/api/v1/payment-methods/${id}`,
      headers: { cookie },
    });
    expect(archived.statusCode).toBe(204);

    const ledger = await ledgerOf(app, cookie);
    expect(ledger.paymentMethods.find((method) => method.id === id)?.isArchived).toBe(true);
  });
});

describe("tags", () => {
  async function createTag(cookie: string, name: string, color = "#55997a") {
    return app.inject({
      method: "POST",
      url: "/api/v1/tags",
      headers: { cookie },
      payload: { name, color },
    });
  }

  it("creates a tag and refuses a duplicate name", async () => {
    const cookie = await signUp(app, "mama");

    expect((await createTag(cookie, "出差")).statusCode).toBe(201);

    const duplicate = await createTag(cookie, "出差", "#b8574f");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "tag_exists" });
  });

  it("refuses a colour that is not #RRGGBB", async () => {
    const cookie = await signUp(app, "mama");

    const response = await createTag(cookie, "出差", "green");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_failed" });
  });

  it("deleting a tag reports the entries it was on, and keeps those entries", async () => {
    const cookie = await signUp(app, "mama");
    const tag = await createTag(cookie, "可报销");
    const tagId = (tag.json() as { id: string }).id;

    const entry = await recordEntry(cookie, [tagId]);
    expect(entry.statusCode).toBe(201);
    const entryId = (entry.json() as { id: string }).id;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/tags/${tagId}`,
      headers: { cookie },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ affectedEntries: 1 });

    // The entry survives; only the label is gone.
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/transactions/${entryId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { tags: unknown[] }).tags).toHaveLength(0);
  });

  it("attaches tags to an entry and returns them", async () => {
    const cookie = await signUp(app, "mama");
    const first = await createTag(cookie, "出差");
    const second = await createTag(cookie, "可报销", "#b8574f");

    const response = await recordEntry(cookie, [
      (first.json() as { id: string }).id,
      (second.json() as { id: string }).id,
    ]);

    expect(response.statusCode).toBe(201);
    const tags = (response.json() as { tags: { name: string }[] }).tags;
    expect(tags.map((tag) => tag.name).sort()).toEqual(["出差", "可报销"]);
  });

  it("refuses more than ten tags on one entry", async () => {
    const cookie = await signUp(app, "mama");
    const ids: string[] = [];

    for (let index = 0; index < 11; index += 1) {
      const tag = await createTag(cookie, `标签${String(index)}`);
      ids.push((tag.json() as { id: string }).id);
    }

    const response = await recordEntry(cookie, ids);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_failed" });
  });
});
