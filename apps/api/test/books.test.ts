import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * Ledgers themselves: making a second one, entering it, setting one aside, bringing it back.
 *
 * ⚠️ **The test that matters most here is the last one**, and it is not about these routes at all:
 * it records an entry in each of two ledgers and checks that **neither one can see the other's**.
 * Everything before it is plumbing; that one is the owner's acceptance criterion —
 * *"两本账之间切换，数据绝不互相出现"*.
 */
describe("ledgers", () => {
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
      select: { id: true, lastBookId: true },
    });
    return { cookie, userId: user.id };
  }

  async function listBooks(cookie: string) {
    const response = await app.inject({ method: "GET", url: "/api/v1/books", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      books: { id: string; name: string; role: string; isCreator: boolean; memberCount: number }[];
      disposed: { id: string; name: string; disposedByMe: boolean }[];
    };
  }

  it("gives a new account exactly one ledger, as its editor", async () => {
    const owner = await account("books_owner");
    const { books, disposed } = await listBooks(owner.cookie);

    expect(books).toHaveLength(1);
    expect(disposed).toHaveLength(0);
    /**
     * ⚠️ `editor`, not the column default. The default is `viewer` — deliberately, so a forgotten
     * role fails towards read-only — which means **the creator's right has to be granted
     * explicitly**, exactly as the owner asked.
     */
    expect(books[0]?.role).toBe("editor");
    expect(books[0]?.isCreator).toBe(true);
  });

  it("makes a second ledger, enters it, and keeps the first one", async () => {
    const owner = await account("books_owner");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/books",
      headers: { cookie: owner.cookie },
      payload: { name: "家庭账本" },
    });

    expect(created.statusCode).toBe(201);
    const second = created.json() as { id: string; name: string };
    expect(second.name).toBe("家庭账本");

    const { books } = await listBooks(owner.cookie);
    expect(books).toHaveLength(2);

    /**
     * ⚠️ **Making a ledger enters it.** Otherwise the button appears to do nothing — the person
     * stays in the old ledger and the new one is nowhere to be seen.
     */
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: owner.userId },
      select: { lastBookId: true },
    });
    expect(user.lastBookId).toBe(second.id);
  });

  it("names a second ledger by default when no name is given", async () => {
    const owner = await account("books_owner");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/books",
      headers: { cookie: owner.cookie },
      payload: {},
    });

    expect(created.statusCode).toBe(201);
    expect((created.json() as { name: string }).name).toBeTruthy();
  });

  it("remembers which ledger was entered, per account", async () => {
    const owner = await account("books_owner");
    const { books } = await listBooks(owner.cookie);
    const first = books[0]!.id;

    const second = (
      await app.inject({
        method: "POST",
        url: "/api/v1/books",
        headers: { cookie: owner.cookie },
        payload: { name: "第二本" },
      })
    ).json() as { id: string };

    // Back to the first one.
    const activated = await app.inject({
      method: "POST",
      url: `/api/v1/books/${first}/activate`,
      headers: { cookie: owner.cookie },
    });
    expect(activated.statusCode).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: owner.userId },
      select: { lastBookId: true },
    });
    expect(user.lastBookId).toBe(first);
    expect(user.lastBookId).not.toBe(second.id);
  });

  it("refuses to enter a ledger the caller is not in", async () => {
    const alice = await account("books_alice");
    const bob = await account("books_bob");
    const { books } = await listBooks(alice.cookie);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/books/${books[0]!.id}/activate`,
      headers: { cookie: bob.cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("book_forbidden");
  });

  it("sets a ledger aside without deleting a single row, and brings it back", async () => {
    const owner = await account("books_owner");
    const { books } = await listBooks(owner.cookie);
    const bookId = books[0]!.id;

    // An entry, so "nothing was deleted" is a claim with something behind it.
    const category = await prisma.category.findFirstOrThrow({
      where: { bookId, isSystem: true },
      select: { id: true },
    });
    await prisma.transaction.create({
      data: {
        id: "01930000-0000-7000-8000-0000000000aa",
        /**
         * ⚠️ **Written directly here because this test seeds a row, not an API call.** Going through
         * the route would allocate the number the way the application does — and would also make
         * this test about the route rather than about disposing a ledger. **`seq` is still required
         * by the schema**, which is the point: there is no such thing as an unnumbered entry.
         */
        seq: 1,
        idempotencyKey: "01930000-0000-7000-8000-0000000000aa",
        bookId,
        userId: owner.userId,
        categoryId: category.id,
        kind: "expense",
        amountCents: 1234n,
        currency: "CNY",
        occurredAt: new Date(),
        occurredLocalDate: new Date(),
        occurredTz: "Asia/Shanghai",
      },
    });

    const disposed = await app.inject({
      method: "POST",
      url: `/api/v1/books/${bookId}/dispose`,
      headers: { cookie: owner.cookie },
    });
    expect(disposed.statusCode).toBe(200);

    /**
     * ⚠️ **Gone from the open list, still present in the disposed one** — and the second half is
     * the point: setting a ledger aside is only useful if the person who did it can undo it.
     */
    const afterDispose = await listBooks(owner.cookie);
    expect(afterDispose.books).toHaveLength(0);
    expect(afterDispose.disposed.map((entry) => entry.id)).toContain(bookId);
    expect(afterDispose.disposed[0]?.disposedByMe).toBe(true);

    // The rows are untouched — disposing is a timestamp, not a delete.
    expect(await prisma.transaction.count({ where: { bookId } })).toBe(1);

    // And it cannot be entered while it is set aside.
    const activateRefused = await app.inject({
      method: "POST",
      url: `/api/v1/books/${bookId}/activate`,
      headers: { cookie: owner.cookie },
    });
    expect(activateRefused.statusCode).toBe(400);
    expect(activateRefused.json().code).toBe("book_disposed");

    const restored = await app.inject({
      method: "POST",
      url: `/api/v1/books/${bookId}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(restored.statusCode).toBe(200);

    const afterRestore = await listBooks(owner.cookie);
    expect(afterRestore.books.map((entry) => entry.id)).toContain(bookId);
    expect(await prisma.transaction.count({ where: { bookId } })).toBe(1);
  });

  it("refuses to let a non-creator set a ledger aside", async () => {
    /**
     * ⚠️ **Stricter than the usual `editor` check, deliberately.** Disposing hides a ledger from
     * everyone in it, so it is not an edit to the contents — it is a decision about the ledger's
     * existence, and one editor must not be able to make it for another person's book.
     */
    const creator = await account("books_creator");
    const guest = await account("books_guest");
    const { books } = await listBooks(creator.cookie);
    const bookId = books[0]!.id;

    await prisma.bookMember.create({
      data: { bookId, userId: guest.userId, role: "editor" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/books/${bookId}/dispose`,
      headers: { cookie: guest.cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("book_not_creator");
  });

  it("keeps two ledgers' entries apart, in both directions", async () => {
    /**
     * ⚠️ **This is the acceptance criterion, and it is the reason the whole stage exists.**
     * Two ledgers, one entry in each, and neither list may show the other's row.
     *
     * The request names its ledger in the header, so this also exercises the path a second
     * ledger's data actually takes.
     */
    const owner = await account("books_owner");
    const first = (await listBooks(owner.cookie)).books[0]!.id;

    const second = (
      await app.inject({
        method: "POST",
        url: "/api/v1/books",
        headers: { cookie: owner.cookie },
        payload: { name: "第二本" },
      })
    ).json() as { id: string };

    async function addEntry(bookId: string, note: string) {
      const category = await prisma.category.findFirstOrThrow({
        where: { bookId, isSystem: true },
        select: { id: true },
      });

      const id = `01930000-0000-7000-8000-0000000000${bookId === first ? "b1" : "b2"}`;
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/transactions",
        headers: { cookie: owner.cookie, "x-libellum-book": bookId },
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
          note,
          tagIds: [],
        },
      });
      expect(response.statusCode).toBe(201);
    }

    async function notesIn(bookId: string): Promise<string[]> {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/transactions?month=2026-10",
        headers: { cookie: owner.cookie, "x-libellum-book": bookId },
      });
      expect(response.statusCode).toBe(200);
      return (response.json() as { items: { note: string | null }[] }).items.map((item) => item.note ?? "");
    }

    await addEntry(first, "第一本的账");
    await addEntry(second.id, "第二本的账");

    expect(await notesIn(first)).toEqual(["第一本的账"]);
    expect(await notesIn(second.id)).toEqual(["第二本的账"]);
  });
});
