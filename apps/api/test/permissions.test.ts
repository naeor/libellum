import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * ⚠️ **The permission tests, and they exist because the owner asked for them by name.**
 *
 * > *"不要为赶进度省略权限测试。"*
 *
 * The reason they matter more than most: **until they existed, no test had ever exercised the
 * refusal side of `book_members`.** Every account in the suite is an `editor` of exactly one
 * ledger, so every request succeeded and the column could have been ignored entirely without a
 * single test turning red. A passing suite was not evidence that permissions worked — it was
 * evidence that nothing had tried to break them.
 *
 * The rule being tested is one sentence, and it is the same rule the API has always claimed:
 * **permission comes from `book_members` and from nothing else.** The request header names a
 * ledger; it never grants anything.
 *
 * These run against a real database through the real app, so the guard itself is exercised
 * rather than a stub of it.
 */
describe("book permissions", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Register an account and return its cookie plus the ledger it was given. */
  async function account(username: string) {
    const cookie = await signUp(app, username);

    const user = await prisma.user.findUniqueOrThrow({
      where: { username },
      select: { id: true, bookMemberships: { select: { bookId: true, role: true } } },
    });

    const membership = user.bookMemberships[0];
    if (!membership) throw new Error(`${username} was given no ledger`);

    return { cookie, userId: user.id, bookId: membership.bookId, role: membership.role };
  }

  /** The category an entry should be filed under — the book's hidden fallback. */
  async function uncategorised(bookId: string): Promise<string> {
    const category = await prisma.category.findFirst({
      where: { bookId, isSystem: true },
      select: { id: true },
    });

    if (!category) throw new Error("the book has no system category");
    return category.id;
  }

  it("creates the member who registers as an editor, explicitly", async () => {
    /**
     * ⚠️ The owner's instruction was narrower than "change the default": **the creator must be
     * granted `editor` on purpose.** A ledger whose only member is a viewer cannot be written in
     * and cannot be handed back, so this is the one grant that must never come from a default.
     */
    const owner = await account("perm_owner");

    expect(owner.role).toBe("editor");
    expect(owner.bookId).toBeTruthy();
  });

  it("refuses a viewer's write, and says which rule stopped it", async () => {
    const owner = await account("perm_owner");
    const viewer = await account("perm_viewer");

    // The viewer joins the owner's ledger, read-only.
    await prisma.bookMember.upsert({
      where: { bookId_userId: { bookId: owner.bookId, userId: viewer.userId } },
      create: { bookId: owner.bookId, userId: viewer.userId, role: "viewer" },
      update: { role: "viewer", leftAt: null },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: { cookie: viewer.cookie, "x-libellum-book": owner.bookId },
      payload: {
        id: "01930000-0000-7000-8000-000000000001",
        idempotencyKey: "01930000-0000-7000-8000-000000000001",
        kind: "expense",
        amountCents: 100,
        currency: "CNY",
        categoryId: await uncategorised(owner.bookId),
        paymentMethodId: null,
        occurredAt: new Date().toISOString(),
        occurredLocalDate: "2026-10-12",
        occurredTz: "Asia/Shanghai",
        note: null,
        tagIds: [],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("book_read_only");

    // ⚠️ And nothing was written. The refusal has to be about the data, not only the response.
    expect(await prisma.transaction.count({ where: { bookId: owner.bookId } })).toBe(0);
  });

  it("lets a viewer read the ledger they belong to", async () => {
    /**
     * ⚠️ **This is the other half of the rule, and it is the half that is easy to break by being
     * too strict.** Per the owner: a viewer *"看到的和 editor 完全一样（账目、统计、明细），唯一
     * 的区别是不能编辑"*. A guard that refused everything except writes would pass the test
     * above and quietly ruin the feature.
     */
    const owner = await account("perm_owner");
    const viewer = await account("perm_viewer");

    await prisma.bookMember.upsert({
      where: { bookId_userId: { bookId: owner.bookId, userId: viewer.userId } },
      create: { bookId: owner.bookId, userId: viewer.userId, role: "viewer" },
      update: { role: "viewer", leftAt: null },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/stats?from=2026-10-01&to=2026-10-31&currency=CNY",
      headers: { cookie: viewer.cookie, "x-libellum-book": owner.bookId },
    });

    expect(response.statusCode).toBe(200);
  });

  it("refuses a ledger the caller is not a member of", async () => {
    const alice = await account("perm_alice");
    const bob = await account("perm_bob");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/stats?from=2026-10-01&to=2026-10-31&currency=CNY",
      headers: { cookie: bob.cookie, "x-libellum-book": alice.bookId },
    });

    /**
     * 403 rather than 404, and the old guard already gave the reason: the caller is
     * authenticated and simply has no business here, whereas a 404 would confirm which ledger
     * ids exist.
     */
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("book_forbidden");
  });

  it("refuses a ledger the caller has left", async () => {
    /**
     * ⚠️ **The membership row survives leaving**, because that is how leaving is recorded — so
     * "a membership exists" is not the same as "a membership is current". Without the
     * `leftAt: null` filter in the guard, **somebody who left a ledger could keep writing in
     * it**, and the row would be there to say they were allowed.
     */
    const owner = await account("perm_owner");
    const leaver = await account("perm_leaver");

    await prisma.bookMember.upsert({
      where: { bookId_userId: { bookId: owner.bookId, userId: leaver.userId } },
      create: { bookId: owner.bookId, userId: leaver.userId, role: "editor", leftAt: new Date() },
      update: { role: "editor", leftAt: new Date() },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/stats?from=2026-10-01&to=2026-10-31&currency=CNY",
      headers: { cookie: leaver.cookie, "x-libellum-book": owner.bookId },
    });

    expect(response.statusCode).toBe(403);
  });

  it("falls back to the oldest membership when the request names no ledger", async () => {
    /**
     * ⚠️ **A compatibility path, and this test is what keeps it honest.**
     *
     * No header means an out-of-date client (or a test). The answer is deliberately the one the
     * code gave before multiple ledgers existed — the oldest membership — so that **nothing
     * changes for the accounts that exist today**. The value of the test is not that the
     * fallback exists but that **it is exercised**: when the ledger list ships and this path is
     * removed, this test is the thing that will fail and point at it.
     */
    const owner = await account("perm_owner");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/stats?from=2026-10-01&to=2026-10-31&currency=CNY",
      headers: { cookie: owner.cookie },
    });

    expect(response.statusCode).toBe(200);
  });
});
