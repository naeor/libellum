import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { PrismaClient } from "../db.js";
import {
  SHARE_LINK_MAX_DAYS,
  SHARE_LINK_MAX_USES,
  SHARE_LINK_MIN_DAYS,
  SHARE_LINK_MIN_USES,
  createShareLink,
  expiresAtOf,
  joinViaShareLink,
  leaveBook,
  previewShareLink,
  revokeShareLink,
} from "../collab/share.js";
import { changeMemberRole, listMembers, removeMember } from "../collab/members.js";
import { recordEvent } from "../ledger/events.js";
import { requireBook, requireBookForWrite } from "../ledger/access.js";

/**
 * Share links, and the two ways out of a ledger.
 *
 * ⚠️ **Every route here that touches a ledger is registered with plain auth**, and each resolves
 * the ledger itself with `requireBook` / `requireBookForWrite`. That is not a weaker guard — it is
 * the same check, asked where the ledger actually matters, because these routes live on a prefix
 * (`/api/v1/share`) whose ledgers come from the body or the token rather than from a header.
 *
 * ⚠️ **`/share/:token` is the one route that cannot require a ledger header**: the whole point of a
 * link is that the person holding it knows nothing about the ledger yet. It requires **auth** and
 * nothing else, and joining is a separate, deliberate call.
 */
export interface ShareRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
}

const linkView = z.object({
  id: z.string(),
  role: z.enum(["editor", "viewer"]),
  days: z.number().int(),
  maxUses: z.number().int(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  useCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
  createdBy: z.string(),
  active: z.boolean(),
});

export function registerShareRoutes(app: FastifyInstance, options: ShareRouteOptions): void {
  const { prisma, requireAuth } = options;

  // ---------------------------------------------------------------------------
  // GET /api/v1/share/links — the links into the current ledger
  // ---------------------------------------------------------------------------
  app.get("/api/v1/share/links", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    /** ⚠️ Read is enough to list them: knowing a link exists is not opening a door. */
    const book = await requireBook(prisma, request, userId);

    const links = await prisma.bookShareLink.findMany({
      where: { bookId: book.bookId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        role: true,
        days: true,
        maxUses: true,
        createdAt: true,
        revokedAt: true,
        useCount: true,
        lastUsedAt: true,
        createdBy: true,
      },
    });

    const now = new Date();

    return {
      links: links.map((link) => {
        const expiresAt = expiresAtOf(link.createdAt, link.days);

        return linkView.parse({
          ...link,
          createdAt: link.createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          revokedAt: link.revokedAt?.toISOString() ?? null,
          lastUsedAt: link.lastUsedAt?.toISOString() ?? null,
          /**
           * ⚠️ **`active` is computed on the server, from the same three facts the join path uses.**
           * A client that worked it out for itself would eventually disagree with the server about
           * whether a link still works — and **the screen would be the one that was wrong**.
           */
          active:
            link.revokedAt === null &&
            expiresAt.getTime() > now.getTime() &&
            link.useCount < link.maxUses,
        });
      }),
    };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/share/links — generate one
  // ---------------------------------------------------------------------------
  app.post("/api/v1/share/links", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const body = z
      .object({
        role: z.enum(["editor", "viewer"]).optional(),
        /**
         * ⚠️ **The owner's range, enforced here *and* by a CHECK constraint.** The split is
         * deliberate: this gives the person a useful message, the constraint makes the range true
         * even for a caller that never goes through this route. **Validation in one place is a
         * convention; validation in two is a property.**
         */
        days: z.number().int().min(SHARE_LINK_MIN_DAYS).max(SHARE_LINK_MAX_DAYS).optional(),
        maxUses: z.number().int().min(SHARE_LINK_MIN_USES).max(SHARE_LINK_MAX_USES).optional(),
      })
      .parse(request.body ?? {});

    /**
     * ⚠️ **Generating a link is a write.** A link is a standing invitation to read somebody's
     * ledger, so a viewer must not be able to mint one — and the server decides that, rather than
     * relying on the screen not offering the button.
     */
    const book = await requireBookForWrite(prisma, request, userId);

    const created = await createShareLink(prisma, {
      bookId: book.bookId,
      createdBy: userId,
      role: body.role ?? "viewer",
      /** ⚠️ Defaults sit at the permissive end, so a caller that says nothing gets a usable link. */
      days: body.days ?? SHARE_LINK_MAX_DAYS,
      maxUses: body.maxUses ?? SHARE_LINK_MAX_USES,
    });

    void reply.code(201);
    /**
     * ⚠️ **The token is in this response and nowhere else, ever again.** The client must show it
     * now; a caller that loses it generates another link, which is why regeneration is a normal
     * operation rather than a recovery procedure.
     */
    return { ok: true, id: created.id, token: created.token, expiresAt: created.expiresAt.toISOString() };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/share/links/:linkId/revoke — close a door
  // ---------------------------------------------------------------------------
  app.post("/api/v1/share/links/:linkId/revoke", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const { linkId } = request.params as { linkId: string };

    const book = await requireBookForWrite(prisma, request, userId);
    const result = await revokeShareLink(prisma, book.bookId, linkId, userId);

    return { ok: true, alreadyRevoked: result.alreadyRevoked };
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/share/:token — what would this link do?
  // ---------------------------------------------------------------------------
  app.get("/api/v1/share/:token", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const { token } = request.params as { token: string };

    const preview = await previewShareLink(prisma, token, userId);
    return { ...preview };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/share/:token/join — do it
  // ---------------------------------------------------------------------------
  app.post("/api/v1/share/:token/join", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const { token } = request.params as { token: string };

    const result = await joinViaShareLink(prisma, token, userId);
    return { ok: true, ...result };
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/books/members — who is in this ledger, and what they may do
  // ---------------------------------------------------------------------------
  /**
   * ⚠️ **Read access is enough, and that is the owner's rule about viewers**: *"查看者：可以查看账本
   * 内容，但不能新增、修改或删除账目."* Seeing **who else is here** is part of seeing the ledger —
   * a viewer who could not tell who made a change would find the history half-useless.
   */
  app.get("/api/v1/books/members", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const book = await requireBook(prisma, request, userId);

    return { members: await listMembers(prisma, book.bookId), myRole: book.role };
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/v1/books/members/:memberId — change what somebody may do
  // ---------------------------------------------------------------------------
  app.patch("/api/v1/books/members/:memberId", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const { memberId } = request.params as { memberId: string };
    const body = z.object({ role: z.enum(["editor", "viewer"]) }).parse(request.body ?? {});

    /**
     * ⚠️ **Changing a role is a write**, so `requireBookForWrite` decides it — a viewer must not be
     * able to promote themselves. The owner's rule for the editor role covers this:
     * *"编辑者：可以查看并编辑账目，也可以按照既有权限规则参与成员管理."*
     */
    const book = await requireBookForWrite(prisma, request, userId);
    const result = await changeMemberRole(prisma, book.bookId, memberId, body.role);

    /**
     * ⚠️ **Recorded as an event**, because the owner asked for member changes to be visible in the
     * history: *"此外，也可以适当展示成员加入、退出或权限变动等重要协作事件."*
     */
    if (result.changed) {
      const target = await prisma.user.findUnique({
        where: { id: memberId },
        select: { displayName: true },
      });

      await recordEvent(prisma, {
        bookId: book.bookId,
        actorId: userId,
        actorName: request.currentUser!.displayName,
        kind: "member_changed",
        changes: {
          role: { from: book.role, to: `${target?.displayName ?? "成员"}：${body.role === "editor" ? "可编辑" : "仅查看"}` },
        },
      });
    }

    return { ok: true, changed: result.changed };
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/v1/books/members/:memberId — take somebody out
  // ---------------------------------------------------------------------------
  app.delete("/api/v1/books/members/:memberId", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const { memberId } = request.params as { memberId: string };

    const book = await requireBookForWrite(prisma, request, userId);
    await removeMember(prisma, book.bookId, memberId, userId);

    /**
     * ⚠️ **Two events for one removal, and they say different things.**
     *
     * `member_changed` records **the fact that somebody left** — that is what the owner wants the
     * history to show. A `leftAt` on the membership row is invisible to the history screen, so
     * **without this the ledger would silently lose a member and the record would show nothing.**
     */
    await recordEvent(prisma, {
      bookId: book.bookId,
      actorId: userId,
      actorName: request.currentUser!.displayName,
      kind: "member_changed",
      changes: { removed: { from: null, to: null } },
    });

    void reply.code(204);
    return null;
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/books/messages — the ledger's public board
  // ---------------------------------------------------------------------------
  /**
   * ⚠️ **Read access, and the owner was explicit that a viewer may take part**:
   * *"**查看者原则上也可以参与文字留言**，因为**交流并不等于修改账目**."* So both routes here use
   * `requireBook`, not `requireBookForWrite` — **a viewer who could not ask "昨天的菜记了吗" would be
   * a second-class member of the household**, and the message board touches no entry.
   */
  app.get("/api/v1/books/messages", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const book = await requireBook(prisma, request, userId);

    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
      .parse(request.query ?? {});

    /**
     * ⚠️ **Newest first, then reversed for display** — the same shape the history endpoint uses, and
     * for the same reason: **the cap must drop the oldest, not the newest.** A board that hides what
     * was just said is worse than one that forgets last month.
     */
    const rows = await prisma.bookMessage.findMany({
      where: { bookId: book.bookId },
      orderBy: { createdAt: "desc" },
      take: query.limit ?? 50,
      select: { id: true, senderId: true, senderName: true, body: true, createdAt: true },
    });

    return {
      messages: rows.reverse().map((row) => ({
        id: row.id,
        senderId: row.senderId,
        senderName: row.senderName,
        body: row.body,
        createdAt: row.createdAt.toISOString(),
        mine: row.senderId === userId,
      })),
      total: await prisma.bookMessage.count({ where: { bookId: book.bookId } }),
    };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/books/messages — say something
  // ---------------------------------------------------------------------------
  app.post("/api/v1/books/messages", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const book = await requireBook(prisma, request, userId);
    const body = z.object({ body: z.string().trim().min(1).max(500) }).parse(request.body ?? {});

    const created = await prisma.bookMessage.create({
      data: {
        bookId: book.bookId,
        senderId: userId,
        /**
         * ⚠️ **The name is copied in, not joined on read.** Joining would show the name the account
         * has *now*, so **renaming yourself would silently rewrite every message you ever sent** —
         * the same reasoning as `TransactionEvent.actorName`.
         */
        senderName: request.currentUser!.displayName,
        body: body.body,
      },
      select: { id: true, createdAt: true },
    });

    void reply.code(201);
    return { ok: true, id: created.id, createdAt: created.createdAt.toISOString() };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/books/:bookId/leave — leave a shared ledger
  // ---------------------------------------------------------------------------
  app.post("/api/v1/books/:bookId/leave", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const { bookId } = request.params as { bookId: string };

    const result = await leaveBook(prisma, bookId, userId);

    /**
     * ⚠️ **Leaving is recorded too.** The owner's sentence covers it: *"成员加入、退出……等重要协作事件."*
     * And it is the case where the record matters most — **the person who left cannot tell you why
     * the ledger changed under them.**
     */
    await recordEvent(prisma, {
      bookId,
      actorId: userId,
      actorName: request.currentUser!.displayName,
      kind: "member_changed",
      changes: { left: { from: null, to: null } },
    });

    return { ok: true, ...result };
  });
}
