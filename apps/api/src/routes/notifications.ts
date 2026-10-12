import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { PrismaClient } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { withdrawNotification } from "../collab/notify.js";
import { PER_SUBJECT_DAILY_LIMIT, TOTAL_DAILY_LIMIT } from "../collab/quota.js";
import { decideNotification } from "../collab/respond.js";

/**
 * The inbox: what is waiting for me, and what I decide about it.
 *
 * ⚠️ **This is where an undecided thing lives** — not in the collaborator table and not in
 * `book_members`. A relationship row exists only after both sides agreed, so there is exactly one
 * record of "waiting" and it cannot disagree with itself (`教训.md` §8.7).
 *
 * ⚠️ **Expiry is computed, never stored.** A status that needs a scheduled job to become true is
 * wrong on any day the job does not run, so `expires_at <= now` is asked at read time and at
 * decision time. Both matter: the first keeps a stale card off the screen, the second refuses a
 * decision that arrived too late.
 */
export interface NotificationsRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
}

const notificationView = z.object({
  id: z.string(),
  kind: z.enum(["collaborator_request", "book_invite", "referral_reminder"]),
  status: z.enum(["pending", "accepted", "declined"]),
  message: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  readAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  /** The account that sent it, so the card can say who is asking. */
  sender: z.object({ displayName: z.string(), username: z.string(), accountNumber: z.string() }),
  /** The ledger in question, for an invitation. Null for everything else, and that is meaningful. */
  book: z.object({ id: z.string(), name: z.string(), bookNumber: z.string().nullable() }).nullable(),
});

export function registerNotificationRoutes(app: FastifyInstance, options: NotificationsRouteOptions): void {
  const { prisma, requireAuth } = options;

  /** The select shape every read here uses, so the view and the query cannot drift apart. */
  const include = {
    sender: { select: { displayName: true, username: true, accountNumber: true } },
    book: { select: { id: true, name: true, bookNumber: true } },
  } as const;

  // ---------------------------------------------------------------------------
  // GET /api/v1/notifications — the inbox
  // ---------------------------------------------------------------------------
  app.get("/api/v1/notifications", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const now = new Date();

    /**
     * ⚠️ **Expired ones are excluded by the query itself**, not filtered afterwards: a card that
     * the screen has to hide is a card that some other screen will forget to hide. `decided` rows
     * are kept and returned — the owner asked to see refusals, so the answer has to remain
     * readable rather than vanish.
     */
    const rows = await prisma.notification.findMany({
      where: { recipientId: userId, expiresAt: { gt: now } },
      include,
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return {
      notifications: rows.map((row) => notificationView.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
      })),
      /** ⚠️ The red dot's source. Derived from the same rows, so it cannot disagree with the list. */
      pendingCount: rows.filter((row) => row.status === "pending").length,
      unreadCount: rows.filter((row) => row.status === "pending" && row.readAt === null).length,
      quota: { perSubject: PER_SUBJECT_DAILY_LIMIT, total: TOTAL_DAILY_LIMIT },
    };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/notifications/:id/decide — accept or decline
  // ---------------------------------------------------------------------------
  app.post("/api/v1/notifications/:id/decide", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const { id } = request.params as { id: string };
    const body = z.object({ decision: z.enum(["accepted", "declined"]) }).parse(request.body);

    const result = await decideNotification(prisma, userId, id, body.decision);

    /**
     * ⚠️ **The answer says what accepting did**, because the screen has to say it too: joining a
     * ledger and merely becoming collaborators lead to different places, and a response that only
     * said "ok" would leave the client to guess which happened.
     */
    return { ok: true, bookId: result.bookId, joined: result.joined };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/notifications/:id/read — mark one as seen
  // ---------------------------------------------------------------------------
  app.post("/api/v1/notifications/:id/read", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const { id } = request.params as { id: string };

    const existing = await prisma.notification.findUnique({
      where: { id },
      select: { recipientId: true, readAt: true },
    });

    if (!existing) throw notFound("notification_missing", "找不到这条通知。");
    if (existing.recipientId !== userId) {
      throw forbidden("notification_not_recipient", "只能标记发给自己的通知。");
    }

    if (existing.readAt === null) {
      await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    }

    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/v1/notifications/:id — withdraw one I sent
  // ---------------------------------------------------------------------------
  app.delete("/api/v1/notifications/:id", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const { id } = request.params as { id: string };

    await withdrawNotification(prisma, userId, id);

    void reply.code(204);
    return null;
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/notifications/read-all — clear the dot
  // ---------------------------------------------------------------------------
  app.post("/api/v1/notifications/read-all", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;

    /**
     * ⚠️ **Only pending ones.** Marking a decided notification as "read" would erase the fact that
     * its answer is still unseen, and the owner asked to be able to see refusals — which means the
     * answer has to stay visible until he has actually looked at it.
     */
    const updated = await prisma.notification.updateMany({
      where: { recipientId: userId, status: "pending", readAt: null },
      data: { readAt: new Date() },
    });

    return { ok: true, marked: updated.count };
  });
}
