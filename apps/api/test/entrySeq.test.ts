import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { formatTransactionNumber } from "@libellum/shared";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * The number a person reads: `#000001`, per ledger, assigned by the server.
 *
 * ⚠️ **Two rules from the owner drive every test here**, and the second one is the easy one to get
 * wrong:
 *
 * 1. *"所有的编号都由服务器统一分配"* — an entry typed offline has no number until it syncs.
 * 2. *"每一笔帐本都从 #000001 开始"* — **each ledger has its own series**, so two ledgers both have
 *    a `#000001`. A global counter would pass a "numbers are unique" test and fail this one.
 */
describe("entry numbers", () => {
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
    const user = await prisma.user.findUniqueOrThrow({ where: { username }, select: { id: true } });
    const membership = await prisma.bookMember.findFirstOrThrow({
      where: { userId: user.id },
      select: { bookId: true },
    });
    return { cookie, userId: user.id, bookId: membership.bookId };
  }

  async function addEntry(
    cookie: string,
    bookId: string,
    note: string,
    index: number,
  ): Promise<number> {
    const category = await prisma.category.findFirstOrThrow({
      where: { bookId, isSystem: true },
      select: { id: true },
    });

    const id = `01930000-0000-7000-8000-${String(index).padStart(12, "0")}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: { cookie, "x-libellum-book": bookId },
      payload: {
        id,
        idempotencyKey: id,
        kind: "expense",
        amountCents: 100 + index,
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
    return (response.json() as { seq: number }).seq;
  }

  it("numbers the first entry #000001 and counts up from there", async () => {
    const owner = await account("seq_owner");

    /**
     * ⚠️ **The owner's own example**: *"A 账本的第一个账目编号就是 #000001。第二个账目编号就是
     * #000002."* Written out literally, because "starts at 1" is the kind of thing that quietly
     * becomes "starts at 0" or "starts at 1 but the first row is skipped".
     */
    expect(await addEntry(owner.cookie, owner.bookId, "第一笔", 1)).toBe(1);
    expect(await addEntry(owner.cookie, owner.bookId, "第二笔", 2)).toBe(2);

    expect(formatTransactionNumber(1)).toBe("#000001");
    expect(formatTransactionNumber(2)).toBe("#000002");
    expect(formatTransactionNumber(123456)).toBe("#123456");
  });

  it("gives each ledger its own series, both starting at one", async () => {
    const owner = await account("seq_owner");

    const second = (
      await app.inject({
        method: "POST",
        url: "/api/v1/books",
        headers: { cookie: owner.cookie },
        payload: { name: "第二本" },
      })
    ).json() as { id: string };

    await addEntry(owner.cookie, owner.bookId, "旧账的一笔", 1);
    await addEntry(owner.cookie, owner.bookId, "旧账的第二笔", 2);

    /**
     * ⚠️ **The new ledger starts again at 1.** This is the assertion a *global* counter would fail
     * while still producing unique numbers — **"unique" is not the rule; "one series per ledger"
     * is.** The owner asked for the second, and it is also what makes a number meaningful when read
     * aloud ("第 3 笔" of *this* ledger).
     */
    expect(await addEntry(owner.cookie, second.id, "新账的第一笔", 3)).toBe(1);
  });

  it("does not reuse a number after a delete", async () => {
    const owner = await account("seq_owner");

    const first = await addEntry(owner.cookie, owner.bookId, "会被删掉", 1);
    const created = await prisma.transaction.findFirstOrThrow({
      where: { bookId: owner.bookId, seq: first },
      select: { id: true },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/transactions/${created.id}`,
      headers: { cookie: owner.cookie, "x-lellum-book": owner.bookId, "x-libellum-book": owner.bookId },
    });
    expect(deleted.statusCode).toBe(204);

    /**
     * ⚠️ **The next entry is #000002, not #000001 again.** A number is a piece of history: somebody
     * may have written it down, and **re-issuing it would make two different entries answer to the
     * same label.** This is why the counter is stored rather than derived from `MAX(seq)` — and why
     * the migration's counter could not be `COUNT(*) + 1`.
     */
    expect(await addEntry(owner.cookie, owner.bookId, "删掉之后的下一笔", 2)).toBe(2);
  });

  it("gives two simultaneous entries two different numbers", async () => {
    const owner = await account("seq_owner");

    const category = await prisma.category.findFirstOrThrow({
      where: { bookId: owner.bookId, isSystem: true },
      select: { id: true },
    });

    /**
     * ⚠️ **This is the test the whole `UPDATE … RETURNING` design exists for.**
     *
     * Ten requests are fired **without awaiting**, so they race. A read-then-write implementation
     * (`SELECT MAX(seq)`, then `INSERT`) would hand several of them the same number; the unique
     * constraint on `(book_id, seq)` would then reject the losers, so the damage would be **failed
     * requests** rather than duplicated labels.
     *
     * ⚠️ And the assertion is not "no duplicates" but **"the numbers are exactly 1…10"** — a
     * duplicate-free set of `{1,2,3,5,6,7,8,9,10,11}` would mean one request had been served out of
     * order and a number had been skipped. **Both would be wrong, and only the exact set catches the
     * second.**
     */
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        const id = `01930000-0000-7000-8000-${String(index + 100).padStart(12, "0")}`;
        return app.inject({
          method: "POST",
          url: "/api/v1/transactions",
          headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
          payload: {
            id,
            idempotencyKey: id,
            kind: "expense",
            amountCents: 100,
            currency: "CNY",
            categoryId: category.id,
            paymentMethodId: null,
            occurredAt: new Date().toISOString(),
            occurredLocalDate: "2026-10-12",
            occurredTz: "Asia/Shanghai",
            note: `并发 ${String(index)}`,
            tagIds: [],
          },
        });
      }),
    );

    for (const response of results) {
      expect(response.statusCode).toBe(201);
    }

    const numbers = results.map((response) => (response.json() as { seq: number }).seq).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("refuses to accept a number from the client", async () => {
    const owner = await account("seq_owner");

    const category = await prisma.category.findFirstOrThrow({
      where: { bookId: owner.bookId, isSystem: true },
      select: { id: true },
    });

    const id = "01930000-0000-7000-8000-0000000000ff";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
      /** ⚠️ A client that sends `seq` must not be able to choose it — the owner: *"编号不可被用户修改"*. */
      payload: {
        id,
        idempotencyKey: id,
        seq: 999999,
        kind: "expense",
        amountCents: 100,
        currency: "CNY",
        categoryId: category.id,
        paymentMethodId: null,
        occurredAt: new Date().toISOString(),
        occurredLocalDate: "2026-10-12",
        occurredTz: "Asia/Shanghai",
        note: "我想要的编号",
        tagIds: [],
      },
    });

    expect(response.statusCode).toBe(201);

    /**
     * ⚠️ **The sent value is ignored, not rejected.** Zod strips unknown keys by default, so the
     * request succeeds and the number is the server's — which is the better outcome: **a client
     * that sends `seq` is out of date, not malicious**, and failing its request would break saving
     * for a reason the person cannot see.
     */
    expect((response.json() as { seq: number }).seq).toBe(1);
  });
});
