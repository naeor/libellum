import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * **The ledger's history: who changed what, and when.**
 *
 * ⚠️ **The three example lines the owner wrote are the acceptance criteria here**, and they are
 * quoted at the assertions:
 *
 * > 「今天 14:32，naeor 将 **#000128** 午餐的金额从 ¥35 修改为 ¥38。」
 * > 「昨天 19:18，naeor **删除**了 **#000103** 出租车记录。」
 * > 「10 月 9 日 11:04，naeor **添加**了 **#000129** 超市购物记录。」
 *
 * ⚠️ **The one that matters most is the delete.** A history table joined to entries with `CASCADE`
 * would look perfect in every test above and pass them all — **while quietly destroying the record
 * the moment somebody used the feature it exists for** (`教训.md` §8.11: the code is there, the
 * behaviour is not).
 */
describe("ledger history", () => {
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
    bookId?: string,
  ): Promise<{ id: string; seq: number }> {
    const target = bookId ?? owner.bookId;
    const category = await prisma.category.findFirstOrThrow({
      where: { bookId: target, isSystem: true },
      select: { id: true },
    });

    const id = `01930000-0000-7000-8000-${String(index).padStart(12, "0")}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: { cookie: owner.cookie, "x-libellum-book": target },
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

  async function events(bookId: string) {
    return prisma.transactionEvent.findMany({
      where: { bookId },
      orderBy: { occurredAt: "asc" },
      select: {
        kind: true,
        transactionId: true,
        transactionSeq: true,
        actorName: true,
        changes: true,
      },
    });
  }

  it("records a creation with the number and who did it", async () => {
    const owner = await account("hist_owner");
    const entry = await addEntry(owner, "超市购物", 1);

    const recorded = await events(owner.bookId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.kind).toBe("created");
    expect(recorded[0]?.transactionSeq).toBe(entry.seq);
    expect(recorded[0]?.actorName).toBe(owner.name);
  });

  it("records which fields an edit changed, with before and after", async () => {
    const owner = await account("hist_owner");
    const entry = await addEntry(owner, "午餐", 1, 3500);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/transactions/${entry.id}`,
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
      payload: {
        version: 2,
        amountCents: 3800,
        /**
         * ⚠️ **`changes` is not decoration — without it the write does not happen.**
         *
         * The route writes only what the conflict judgement decided to write (`settledFields`), and
         * that comes from the change chain the device sends. **A request with no `changes` is judged
         * to have nothing to write**, so it returns 200 and the row is untouched — which is exactly
         * what my first version of this test produced: a passing status code and no edit.
         *
         * ⚠️ **That was a test bug, not a route bug**, and it is worth remembering how it looked:
         * `expect(response.statusCode).toBe(200)` passed while nothing happened. **A status code is
         * not evidence that anything was written.**
         */
        changes: [{ field: "amountCents", base: 3500, wanted: 3800, chain: [3500, 3800] }],
      },
    });
    expect(response.statusCode).toBe(200);

    const recorded = await events(owner.bookId);
    const edit = recorded.find((event) => event.kind === "updated");

    /**
     * ⚠️ **This is the owner's first example line, in data form**: *"将 #000128 午餐的金额从 ¥35 修改为
     * ¥38."* The `changes` object has to carry **both** values — a history that says only "amount
     * changed" answers nothing, and the whole point is to see what it was.
     */
    expect(edit).toBeDefined();
    expect(edit?.transactionSeq).toBe(entry.seq);
    expect(edit?.changes).toEqual({ amountCents: { from: 3500, to: 3800 } });
  });

  it("writes no event when a save changes nothing", async () => {
    const owner = await account("hist_owner");
    const entry = await addEntry(owner, "午餐", 1, 3500);

    // The same amount it already has — the request asks for what is already true.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/transactions/${entry.id}`,
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
      payload: {
        version: 2,
        amountCents: 3500,
        changes: [{ field: "amountCents", base: 3500, wanted: 3500, chain: [3500] }],
      },
    });

    /**
     * ⚠️ **A save that changed nothing is not history.** Recording it would fill the screen with
     * lines describing button presses, and **a history where most lines say nothing is a history
     * nobody reads.**
     */
    const recorded = await events(owner.bookId);
    expect(recorded.filter((event) => event.kind === "updated")).toHaveLength(0);
  });

  it("keeps the record after the entry is deleted", async () => {
    const owner = await account("hist_owner");
    const entry = await addEntry(owner, "出租车", 1);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/transactions/${entry.id}`,
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
    });
    expect(deleted.statusCode).toBe(204);

    const recorded = await events(owner.bookId);
    const deletion = recorded.find((event) => event.kind === "deleted");

    /**
     * ⚠️ **This is the test the whole `ON DELETE SET NULL` decision exists for.** The owner's second
     * example is *"naeor 删除了 #000103"* — **if the foreign key cascaded, that line would be
     * destroyed by the very action it records**, and every other test here would still pass.
     */
    expect(deletion).toBeDefined();
    expect(deletion?.transactionSeq).toBe(entry.seq);

    /**
     * ⚠️ **The row is still there** — the delete is a tombstone, so `transactionId` survives. The
     * number is stored *as well* because a history line must be able to name its entry even when the
     * entry can no longer be listed.
     */
    expect(deletion?.transactionId).toBe(entry.id);
    expect(recorded.map((event) => event.kind)).toEqual(["created", "deleted"]);
  });

  it("records a restore as its own event rather than erasing the delete", async () => {
    const owner = await account("hist_owner");
    const entry = await addEntry(owner, "出租车", 1);

    await app.inject({
      method: "DELETE",
      url: `/api/v1/transactions/${entry.id}`,
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/transactions/${entry.id}/restore`,
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
    });

    /**
     * ⚠️ **The owner's rule for restoring history**: *"恢复应当作为一次新的修改被记录，而不是抹除之后
     * 发生的历史."* So the deletion stays and the restore joins it — **the ledger keeps both the
     * mistake and the correction**, which is what makes this a record rather than a status.
     */
    const recorded = await events(owner.bookId);
    expect(recorded.map((event) => event.kind)).toEqual(["created", "deleted", "restored"]);
  });

  it("keeps two ledgers' histories apart", async () => {
    const owner = await account("hist_owner");
    const second = (
      await app.inject({
        method: "POST",
        url: "/api/v1/books",
        headers: { cookie: owner.cookie },
        payload: { name: "第二本" },
      })
    ).json() as { id: string };

    await addEntry(owner, "第一本的账", 1);
    await addEntry(owner, "第二本的账", 2, 3500, second.id);

    /**
     * ⚠️ **History belongs to a ledger**, and an account with several ledgers must not see one
     * ledger's events on another's screen. Same rule as the entries themselves — and the same reason
     * `bookId` is `NOT NULL` on this table.
     */
    expect(await events(owner.bookId)).toHaveLength(1);
    expect(await events(second.id)).toHaveLength(1);
  });
});
