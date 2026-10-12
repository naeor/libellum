import { bookRoleSchema } from "@libellum/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { PrismaClient } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { createDefaultLedger } from "../ledger/bootstrap.js";
import { DEFAULT_BOOK_NAME } from "../ledger/presets.js";

/**
 * Ledgers themselves: list them, make one, enter one, set one aside, bring it back.
 *
 * ⚠️ **These routes are deliberately *not* registered with a ledger guard.** Every other route in
 * the API answers a question *inside* one ledger, and the guard is what decides whether the
 * caller may be there. These routes are how a caller finds out which ledgers exist — a request
 * asking "which books do I have" has no book to name, and requiring one would be a circle.
 *
 * **They still authenticate**, and each one ends by checking `book_members` for the specific book
 * it touches. Nothing here trusts a book id from the client beyond using it as a lookup key.
 */
export interface BooksRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
}

const bookSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  bookNumber: z.string().nullable(),
  /**
   * ⚠️ **From `book_members` only** — the same rule as everywhere else. A client that names a
   * role means nothing; this is what the server found.
   */
  role: bookRoleSchema,
  /** True when this account made the ledger, which is what decides who may dispose of it. */
  isCreator: z.boolean(),
  /**
   * ⚠️ **Whether *this account* set it aside**, which is a different question from whether it is
   * disposed of at all. The owner asked for the two meanings to stay apart: a ledger somebody else
   * set aside is simply not mine to see, while one I set aside is mine to bring back.
   */
  disposedByMe: z.boolean(),
  memberCount: z.number().int().nonnegative(),
});

const booksResponseSchema = z.object({
  /** Ledgers this account can currently open. */
  books: z.array(bookSummarySchema),
  /** Ones this account set aside. Kept visible so it can be brought back. */
  disposed: z.array(bookSummarySchema),
});

export function registerBooksRoutes(app: FastifyInstance, options: BooksRouteOptions): void {
  const { prisma, requireAuth } = options;

  // ---------------------------------------------------------------------------
  // GET /api/v1/books
  // ---------------------------------------------------------------------------
  app.get("/api/v1/books", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;

    /**
     * ⚠️ **Two sets, and both are needed.**
     *
     * The first is every ledger this account is a member of. The second is every ledger it
     * *created*, **including ones it has set aside** — because setting a ledger aside is only
     * useful if the person who did it can undo it, and `disposed_at` lives on the book rather
     * than on the membership.
     *
     * ⚠️ A ledger somebody else disposed of is **not** in either list: it is not this account's
     * to see, and the owner ruled out the administrator view for this stage.
     */
    const [memberships, created] = await Promise.all([
      prisma.bookMember.findMany({
        where: { userId, leftAt: null },
        select: {
          role: true,
          book: {
            select: {
              id: true,
              name: true,
              bookNumber: true,
              createdBy: true,
              disposedAt: true,
              _count: { select: { members: true } },
            },
          },
        },
        orderBy: { joinedAt: "asc" },
      }),
      prisma.book.findMany({
        where: { createdBy: userId, disposedAt: { not: null } },
        select: {
          id: true,
          name: true,
          bookNumber: true,
          createdBy: true,
          disposedAt: true,
          _count: { select: { members: true } },
        },
      }),
    ]);

    const mine = new Map(memberships.map((entry) => [entry.book.id, entry] as const));
    const open: z.infer<typeof bookSummarySchema>[] = [];
    const disposed: z.infer<typeof bookSummarySchema>[] = [];

    for (const entry of memberships) {
      const book = entry.book;
      if (book.disposedAt !== null) continue;

      open.push({
        id: book.id,
        name: book.name,
        bookNumber: book.bookNumber,
        role: entry.role,
        isCreator: book.createdBy === userId,
        disposedByMe: false,
        memberCount: book._count.members,
      });
    }

    for (const book of created) {
      disposed.push({
        id: book.id,
        name: book.name,
        bookNumber: book.bookNumber,
        // The membership is what grants a role; a creator who left their own ledger has none.
        role: mine.get(book.id)?.role ?? "editor",
        isCreator: true,
        disposedByMe: true,
        memberCount: book._count.members,
      });
    }

    return booksResponseSchema.parse({ books: open, disposed });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/books — a second ledger
  // ---------------------------------------------------------------------------
  app.post("/api/v1/books", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const body = z.object({ name: z.string().trim().min(1).max(40).optional() }).parse(request.body ?? {});

    /**
     * ⚠️ **The name is optional on purpose.** Most people have one ledger and never open this
     * screen; the ones who do are usually splitting "mine" from "ours", and a name they have to
     * invent before they can start is a step in the way. The same default the first ledger gets.
     *
     * ⚠️ **Nothing is copied from the ledger they were in.** A new ledger gets its own preset
     * categories and payment methods — copying the other one's would silently duplicate every
     * customisation into a book that was meant to be separate.
     */
    const bookId = await prisma.$transaction((tx) =>
      createDefaultLedger(tx, userId, body.name ?? DEFAULT_BOOK_NAME),
    );

    /**
     * ⚠️ **Making a ledger is entering it.** Creating one and then leaving the person in the old
     * one would mean the button appears to do nothing.
     */
    await prisma.user.update({ where: { id: userId }, data: { lastBookId: bookId } });

    const book = await prisma.book.findUniqueOrThrow({
      where: { id: bookId },
      select: { id: true, name: true, bookNumber: true },
    });

    void reply.code(201);
    return book;
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/books/:bookId/activate — enter it, and remember that choice
  // ---------------------------------------------------------------------------
  app.post("/api/v1/books/:bookId/activate", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const { bookId } = request.params as { bookId: string };

    const membership = await prisma.bookMember.findUnique({
      where: { bookId_userId: { bookId, userId } },
      select: { leftAt: true, book: { select: { disposedAt: true } } },
    });

    /**
     * 403 rather than 404, as everywhere else: the caller is authenticated and simply has no
     * business here, and a 404 would confirm which ledger ids exist.
     */
    if (!membership || membership.leftAt !== null) {
      throw forbidden("book_forbidden", "无权访问该账本。");
    }

    if (membership.book.disposedAt !== null) {
      throw badRequest("book_disposed", "这本账已被弃置，请先恢复它。");
    }

    /**
     * ⚠️ **The server remembers which ledger this account was last in**, so signing in on another
     * device returns to it — that is what the owner asked for when he chose "服务器保存上次使用的
     * 账本". The device keeps its own copy too, because the first request of a session cannot wait
     * for a round trip.
     */
    await prisma.user.update({ where: { id: userId }, data: { lastBookId: bookId } });

    return { ok: true, bookId };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/books/:bookId/dispose — set it aside (the owner's word)
  // ---------------------------------------------------------------------------
  app.post("/api/v1/books/:bookId/dispose", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const { bookId } = request.params as { bookId: string };

    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: { createdBy: true, disposedAt: true },
    });

    if (!book) throw notFound("book_missing", "找不到这本账。");

    /**
     * ⚠️ **Only the creator may set a ledger aside**, and this is stricter than the usual
     * `editor` check on purpose: disposing hides the ledger from **everyone** in it, so it is
     * not an edit to the contents — it is a decision about the ledger's existence. One editor
     * should not be able to do that to another's book.
     */
    if (book.createdBy !== userId) {
      throw forbidden("book_not_creator", "只有创建者能弃置这本账。");
    }

    if (book.disposedAt !== null) {
      return { ok: true, alreadyDisposed: true };
    }

    /**
     * ⚠️ **The data is not touched.** "弃置" keeps every row — no soft-delete, no transaction
     * marked, nothing removed. It sets one timestamp, and the ledger stops being listed.
     * **Ordinary users can no longer see it; an administrator still can** (that view is a later
     * stage, but the data being intact is what makes it possible at all).
     */
    await prisma.book.update({ where: { id: bookId }, data: { disposedAt: new Date() } });

    return { ok: true, alreadyDisposed: false };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/books/:bookId/restore — bring it back
  // ---------------------------------------------------------------------------
  app.post("/api/v1/books/:bookId/restore", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const { bookId } = request.params as { bookId: string };

    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: { createdBy: true, disposedAt: true },
    });

    if (!book) throw notFound("book_missing", "找不到这本账。");

    if (book.createdBy !== userId) {
      throw forbidden("book_not_creator", "只有创建者能恢复这本账。");
    }

    if (book.disposedAt === null) {
      return { ok: true, alreadyOpen: true };
    }

    /**
     * ⚠️ **Just the timestamp.** The rows were never touched, so bringing a ledger back is one
     * update and nothing has to be rebuilt — which is the whole reason disposing one does not
     * delete anything.
     */
    await prisma.book.update({ where: { id: bookId }, data: { disposedAt: null } });

    return { ok: true, alreadyOpen: false };
  });
}
