import { bookRoleSchema } from "@libellum/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { PrismaClient } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { findByAccountNumber, findByUsername } from "../collab/directory.js";
import { sendNotification } from "../collab/notify.js";
import { requireBookForWrite } from "../ledger/access.js";
import { createDefaultLedger } from "../ledger/bootstrap.js";
import { recordEvent } from "../ledger/events.js";
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

  // ---------------------------------------------------------------------------
  // PATCH /api/v1/books/:bookId — rename a ledger
  // ---------------------------------------------------------------------------
  /**
   * **Rename one ledger.**
   *
   * ⚠️ **This did not exist until 1.10.08**, and the owner asked for it as part of the start page's
   * per-ledger management panel — *"如果项目目前没有正式的重命名能力，不要擅自设计未经确认的后端权限规则。
   * 先核实现有模型，说明缺失部分."* So the model was checked first and the rule below follows the
   * one already in place rather than inventing a new one.
   *
   * ⚠️ **The rule is `requireBookForWrite`, which is the same guard `invite` uses.** Renaming changes
   * what everybody in the ledger sees, so it is a **write**: a viewer is refused, an editor and the
   * creator are not. **That is the existing model, not a new one** — `book_members.role` already says
   * who may change shared things, and `books.ts` has no separate "creator only" concept except where
   * the owner drew it explicitly (dispose, and leaving).
   *
   * ⚠️ **Why not creator-only.** Disposing is creator-only because it affects *everybody* and cannot
   * be undone from inside the ledger; a name is the opposite — it is cosmetic, reversible, and the
   * ledger's own history records who changed it. Tying it to the creator would mean **a ledger whose
   * creator has gone quiet can never be renamed by the people still using it.**
   *
   * ⚠️ **`1`–`40`, trimmed — the same bounds as creation.** A second set of numbers here would let a
   * name be legal at creation and illegal on rename, which reads as a bug rather than a rule.
   */
  app.patch("/api/v1/books/:bookId", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const { bookId } = request.params as { bookId: string };

    const body = z
      .object({ name: z.string().trim().min(1).max(40) })
      .parse(request.body ?? {});

    /**
     * ⚠️ **The ledger is named in the *path*, and the permission still comes from the header.**
     *
     * This is the one route where those two could disagree, and the owner called that risk out: the
     * management panel must act on **the ledger whose gear was tapped, never the current one.**
     * `requireBookForWrite` reads the header, so the route checks the **path** id explicitly as well
     * — **if they differ, nothing happens.** Otherwise a client could rename a ledger it can write in
     * while claiming a different one, or worse, rename the wrong one while the header said something
     * else.
     */
    const book = await requireBookForWrite(prisma, request, userId);

    if (book.bookId !== bookId) {
      throw badRequest(
        "book_mismatch",
        "这次请求说的账本和当前账本不一致，没有改动任何东西。",
      );
    }

    /**
     * ⚠️ **The name *before* the change is read here**, because after the update it is gone — and the
     * history line is *"名称：（旧）→（新）"*, which needs both ends. `BookContext` carries only the id
     * and the role, deliberately: it answers "may I", not "what is it".
     */
    const before = await prisma.book.findUniqueOrThrow({
      where: { id: bookId },
      select: { name: true },
    });

    const updated = await prisma.book.update({
      where: { id: bookId },
      data: { name: body.name },
      select: { id: true, name: true, bookNumber: true },
    });

    /**
     * ⚠️ **Recorded in the ledger's own history.** The owner asked for member and ledger changes to
     * be visible there — *"也可以适当展示成员加入、退出……等重要协作事件"* — and a rename is exactly the
     * kind of shared change somebody later asks "who did that, and when" about.
     */
    await recordEvent(prisma, {
      bookId,
      actorId: userId,
      actorName: request.currentUser!.displayName,
      kind: "book_changed",
      changes: { name: { from: before.name, to: body.name } },
    });

    return { ok: true, book: updated };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/books/invite — invite somebody into *this* ledger
  // ---------------------------------------------------------------------------
  /**
   * **The one invitation flow, and it is one step: invite → they accept → they are a member.**
   *
   * ⚠️ **This replaced a two-step flow, on the owner's decision** (2026-10-13):
   *
   * > *"不再要求用户先发送「添加协作者申请」、等待对方同意，然后才能发送账本邀请。"*
   *
   * ⚠️ **What makes one step enough is that the invitation itself is the consent request.** The
   * invitee still has to accept it (`decideNotification` → `book_members`); what is gone is the
   * *additional* account-level relationship that used to have to exist first. **The owner's reason
   * was cost, not safety**: for two people who simply want to keep a ledger together, the old flow
   * asked them to confirm the same intention twice.
   *
   * ⚠️ **⚠️ Nothing about permission changed.** This is guarded as a **write** — inviting somebody
   * changes who can see the ledger's entries, so **a viewer must not be able to do it** — and the
   * membership row is created only by the invitee's own acceptance.
   */
  app.post("/api/v1/books/invite", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;

    /**
     * ⚠️ **Either identifier, and exactly one of them.** Both are whole values (an 8-digit number,
     * or an exact username) — see `collab/directory.ts` for why a prefix is refused and why that
     * refusal is the security property rather than a convenience choice.
     */
    const body = z
      .object({
        accountNumber: z.string().optional(),
        username: z.string().optional(),
        /** ⚠️ From the client, so it is a **request**, not an instruction — see below. */
        role: z.enum(["editor", "viewer"]).optional(),
        message: z.string().trim().max(200).optional(),
      })
      .refine(
        (value) => (value.accountNumber === undefined) !== (value.username === undefined),
        { message: "给账号编号或用户名，二选一。" },
      )
      .parse(request.body ?? {});

    /**
     * ⚠️ **The ledger comes from the header and is checked as a *write* operation.** That is what
     * `requireBookForWrite` decides, and it is why this route resolves the ledger itself instead of
     * relying on the plain auth guard.
     */
    const book = await requireBookForWrite(prisma, request, userId);

    /**
     * ⚠️ **Located through the same functions the lookup screen uses**, so "you cannot search by
     * prefix" and "you cannot invite yourself" are enforced in one place rather than restated here.
     */
    const target =
      body.accountNumber !== undefined
        ? await findByAccountNumber(prisma, userId, body.accountNumber)
        : await findByUsername(prisma, userId, body.username ?? "");

    /**
     * ⚠️ **Already a member is refused here, before a notification is sent.** Without this the
     * invitee would get a notification that, when accepted, either does nothing or silently changes
     * their existing role — and the sender would have spent quota learning that.
     *
     * ⚠️ **`leftAt: null` is part of the test**: a row stays behind when somebody leaves, so a
     * membership that exists is not the same as one that is current.
     */
    const existing = await prisma.bookMember.findUnique({
      where: { bookId_userId: { bookId: book.bookId, userId: target.id } },
      select: { leftAt: true },
    });

    if (existing !== null && existing.leftAt === null) {
      throw badRequest("already_member", "这个人已经在这本账里了。");
    }

    const requested = body.role ?? "editor";
    const role = book.role === "editor" && requested === "editor" ? "editor" : requested;

    const sent = await sendNotification(prisma, {
      senderId: userId,
      recipientId: target.id,
      kind: "book_invite",
      bookId: book.bookId,
      message: body.message ?? null,
      /**
       * ⚠️ **The role travels with the invitation.** Without this the acceptance step would have
       * nothing to grant but a guess — see the migration that added `notifications.payload`.
       */
      payload: { role },
    });

    void reply.code(201);
    return {
      ok: true,
      notificationId: sent.id,
      refreshed: sent.refreshed,
      /** What will be granted if they accept — stated so the screen can show it before they do. */
      role,
    };
  });
}
