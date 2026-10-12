import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * Reading the ledger history back.
 *
 * ⚠️ **This file exists because the endpoint shipped without it.** 1.09.27 added
 * `GET /api/v1/ledger/history` and recorded, in its own version entry, that **nothing tested it** —
 * including the permission check. The hard rule for this stage is that **permissions are never
 * skipped**, so the refusal cases below are the point of this file, not an extra.
 */
describe("ledger history endpoint", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function account(username: string) {
    const cookie = await signUp(app, username);
    const user = await prisma.user.findUniqueOrThrow({
      where: { username },
      select: { id: true, displayName: true },
    });
    const membership = await prisma.bookMember.findFirstOrThrow({
      where: { userId: user.id },
      select: { bookId: true },
    });
    return { cookie, userId: user.id, bookId: membership.bookId, name: user.displayName };
  }

  async function addEntry(
    owner: Awaited<ReturnType<typeof account>>,
    note: string,
    index: number,
    amountCents = 3500,
  ): Promise<{ id: string; seq: number }> {
    const category = await prisma.category.findFirstOrThrow({
      where: { bookId: owner.bookId, isSystem: true },
      select: { id: true },
    });

    const id = `01930000-0000-7000-8000-${String(index).padStart(12, "0")}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
      payload: {
        id,
        idempotencyKey: id,
        kind: "expense",
        amountCents,
        currency: "CNY",
        categoryId: category.id,
        paymentMethodId: null,
        occurredAt: new Date().toISOString(),
        occurredLocalDate: "2026-10-12",
        occurredTz: "Asia/Shanghai",
        note,
        tagIds: [],
      },
    });

    expect(response.statusCode).toBe(201);
    return { id, seq: (response.json() as { seq: number }).seq };
  }

  function history(cookie: string, bookId: string, query = "") {
    return app.inject({
      method: "GET",
      url: `/api/v1/ledger/history${query}`,
      headers: { cookie, "x-libellum-book": bookId },
    });
  }

  interface Entry {
    readonly kind: string;
    readonly summary: string;
    readonly transactionSeq: number | null;
    readonly actorName: string | null;
    readonly transactionId: string | null;
    readonly changes: readonly { label: string; from: string; to: string }[];
  }

  it("refuses a ledger the caller is not a member of", async () => {
    const alice = await account("histapi_alice");
    const bob = await account("histapi_bob");
    await addEntry(alice, "午餐", 1);

    /**
     * ⚠️ **The refusal this endpoint shipped without.** The history names entries, who changed them
     * and what they were before — **it is a more revealing read than the entries themselves**, so a
     * missing check here would leak more than a missing check anywhere else.
     */
    const refused = await history(bob.cookie, alice.bookId);
    expect(refused.statusCode).toBe(403);
  });

  it("lets a viewer read the history but not write it", async () => {
    const owner = await account("histapi_owner");
    const viewer = await account("histapi_viewer");
    await addEntry(owner, "午餐", 1);

    await prisma.bookMember.create({
      data: { bookId: owner.bookId, userId: viewer.userId, role: "viewer" },
    });

    /**
     * ⚠️ **A viewer needs this as much as an editor does.** The owner's rule is that a viewer sees
     * everything except the ability to edit, and *"这笔是谁改的"* is part of seeing it. A route that
     * quietly required write access would pass every other test here and **half-break the viewer
     * experience.**
     */
    const allowed = await history(viewer.cookie, owner.bookId);
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json() as { entries: Entry[] }).entries.length).toBeGreaterThan(0);

    // And the write is still refused — the read permission did not widen anything.
    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: { cookie: viewer.cookie, "x-libellum-book": owner.bookId },
      payload: {
        id: "01930000-0000-7000-8000-0000000000ee",
        idempotencyKey: "01930000-0000-7000-8000-0000000000ee",
        kind: "expense",
        amountCents: 100,
        currency: "CNY",
        categoryId: (await prisma.category.findFirstOrThrow({
          where: { bookId: owner.bookId, isSystem: true },
          select: { id: true },
        })).id,
        paymentMethodId: null,
        occurredAt: new Date().toISOString(),
        occurredLocalDate: "2026-10-12",
        occurredTz: "Asia/Shanghai",
        note: null,
        tagIds: [],
      },
    });
    expect(refused.statusCode).toBe(403);
  });

  it("returns a sentence a person can read, with the entry's number", async () => {
    const owner = await account("histapi_owner");
    const entry = await addEntry(owner, "午餐", 1);

    const response = await history(owner.cookie, owner.bookId);
    expect(response.statusCode).toBe(200);

    const body = response.json() as { entries: Entry[]; total: number };
    const created = body.entries.find((item) => item.kind === "created");

    /**
     * ⚠️ **The owner's third example line, in the shape the API returns it**:
     * *"naeor 添加了 #000129 超市购物记录."* The assertions check the three things that make a line
     * usable — **who**, **which entry**, **what happened** — because a history missing any one of
     * them cannot answer the question it exists for.
     */
    expect(created).toBeDefined();
    expect(created?.actorName).toBe(owner.name);
    expect(created?.transactionSeq).toBe(entry.seq);
    expect(created?.summary).toContain(owner.name);
    expect(created?.summary).toContain(`#${String(entry.seq).padStart(6, "0")}`);
    expect(created?.summary).toContain("添加了");
  });

  it("describes an edit field by field, in Chinese", async () => {
    const owner = await account("histapi_owner");
    const entry = await addEntry(owner, "午餐", 1, 3500);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/transactions/${entry.id}`,
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
      payload: {
        version: 2,
        amountCents: 3800,
        changes: [{ field: "amountCents", base: 3500, wanted: 3800, chain: [3500, 3800] }],
      },
    });

    const response = await history(owner.cookie, owner.bookId);
    const edit = (response.json() as { entries: Entry[] }).entries.find((item) => item.kind === "updated");

    /**
     * ⚠️ **`更新` must read as "金额", not "amountCents".** The label comes from `trackedFieldLabel`,
     * the same table the diff uses — so **a field that is tracked but unnamed cannot reach the screen
     * wearing its column name** (`教训.md` §8.12: one rule, one place).
     */
    expect(edit?.changes).toEqual([{ label: "金额", from: "3500", to: "3800" }]);
    expect(edit?.summary).toContain("修改了");
  });

  it("caps how much one request can read", async () => {
    const owner = await account("histapi_owner");
    for (let i = 1; i <= 5; i += 1) {
      await addEntry(owner, `第 ${String(i)} 笔`, i);
    }

    /**
     * ⚠️ **An uncapped `limit` from a client is a request that reads the whole ledger** — the same
     * rule the export pagination exists for: *"never read the whole ledger into memory for a single
     * click."* So the cap is checked rather than trusted.
     */
    const huge = await history(owner.cookie, owner.bookId, "?limit=100000");
    expect(huge.statusCode).toBe(400);

    const small = await history(owner.cookie, owner.bookId, "?limit=2");
    expect(small.statusCode).toBe(200);

    const body = small.json() as { entries: Entry[]; total: number };

    /** ⚠️ The page is short but `total` is not — "最近几条" still says how much there is. */
    expect(body.entries).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  it("keeps the number readable after the entry is deleted", async () => {
    const owner = await account("histapi_owner");
    const entry = await addEntry(owner, "出租车", 1);

    await app.inject({
      method: "DELETE",
      url: `/api/v1/transactions/${entry.id}`,
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
    });

    const response = await history(owner.cookie, owner.bookId);
    const deletion = (response.json() as { entries: Entry[] }).entries.find(
      (item) => item.kind === "deleted",
    );

    /**
     * ⚠️ **The owner's second example depends on this**: *"naeor 删除了 #000103 出租车记录."* The entry
     * is gone from the ledger, so the note and category cannot be joined — **the sentence has to fall
     * back to the number, and the number has to be there.**
     */
    expect(deletion).toBeDefined();
    expect(deletion?.transactionSeq).toBe(entry.seq);
    expect(deletion?.summary).toContain(`#${String(entry.seq).padStart(6, "0")}`);
    expect(deletion?.summary).toContain("删除了");
  });
});
