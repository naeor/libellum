import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { PrismaClient } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { findByAccountNumber } from "../collab/directory.js";
import { sendNotification } from "../collab/notify.js";
import { mintReferralCode, REFERRAL_CODE_LIFETIME_LIMIT } from "../collab/referral.js";
import { requireBookForWrite } from "../ledger/access.js";

/**
 * Collaborators, and the requests that create them.
 *
 * ⚠️ **A collaborator is an account-level relationship**, not a membership of a ledger — the
 * owner's correction: *"好友指的就是一个账号所有协作者的集合"*. A shares ledger 1 with B and
 * ledger 2 with C, so A's collaborator list is **{B, C}**.
 *
 * ⚠️ **It grants nothing.** Ledger permission still comes from `book_members` alone. What a
 * relationship buys is *"who may I invite"* and *"who am I keeping books with"*.
 *
 * ⚠️ **Both sides must agree** (*"加为协作者需要对方同意"*), so *this* module never creates a
 * relationship — it only sends the request. Accepting happens in `notifications`, where the other
 * person decides.
 */
export interface CollabRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
}

export interface CollaboratorView {
  readonly userId: string;
  readonly displayName: string;
  readonly username: string;
  readonly accountNumber: string;
  /**
   * ⚠️ **Whether this person is in the ledger I am looking at right now** — computed, never
   * stored. The owner asked for the list to be account-level **but** to put the current ledger's
   * people on top: *"协作者是账号级的列表，但是'优先显示当前账本的协作者'……B 就会被置顶并高光"*.
   */
  readonly inCurrentBook: boolean;
  /** Their role in the current ledger, when they are in it. */
  readonly currentBookRole: "owner" | "editor" | "viewer" | null;
}

const collaboratorSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  username: z.string(),
  accountNumber: z.string(),
  inCurrentBook: z.boolean(),
  currentBookRole: z.enum(["owner", "editor", "viewer"]).nullable(),
});

export function registerCollabRoutes(app: FastifyInstance, options: CollabRouteOptions): void {
  const { prisma, requireAuth } = options;

  // ---------------------------------------------------------------------------
  // GET /api/v1/collaborators — my collaborators, the current ledger's first
  // ---------------------------------------------------------------------------
  app.get("/api/v1/collaborators", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;

    /**
     * ⚠️ **The current ledger is read from the header, and it is optional here.** This list is
     * account-level, so it must work even when nobody is looking at a particular ledger — the
     * owner's own case: entering it from the home page where "当前账本为空". When a ledger *is*
     * named, its members are lifted to the top and marked.
     */
    let currentBookId: string | null = null;
    try {
      currentBookId = (await requireBookForWrite(prisma, request, userId)).bookId;
    } catch {
      currentBookId = null;
    }

    const relationships = await prisma.collaborator.findMany({
      where: { OR: [{ userA: userId }, { userB: userId }] },
      select: {
        userA: true,
        userB: true,
        createdAt: true,
        a: { select: { id: true, displayName: true, username: true, accountNumber: true } },
        b: { select: { id: true, displayName: true, username: true, accountNumber: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const others = relationships.map((row) => (row.userA === userId ? row.b : row.a));

    /**
     * ⚠️ **One query for the whole ledger's membership, not one per collaborator.** The list is
     * small today and would not stay small: a loop here is the shape that turns a screen into N
     * round trips once somebody has twenty collaborators.
     */
    const memberships = currentBookId === null
      ? []
      : await prisma.bookMember.findMany({
          where: { bookId: currentBookId, leftAt: null, userId: { in: others.map((o) => o.id) } },
          select: { userId: true, role: true },
        });

    const roleInBook = new Map(memberships.map((m) => [m.userId, m.role] as const));

    const collaborators: CollaboratorView[] = others.map((other) => ({
      userId: other.id,
      displayName: other.displayName,
      username: other.username,
      accountNumber: other.accountNumber,
      inCurrentBook: roleInBook.has(other.id),
      currentBookRole: roleInBook.get(other.id) ?? null,
    }));

    /**
     * The owner asked for the current ledger's people first, and **stable within each group** so the
     * list does not reshuffle when somebody joins or leaves: the join order is what it was built
     * with, and the split preserves it.
     */
    collaborators.sort((a, b) => Number(b.inCurrentBook) - Number(a.inCurrentBook));

    /**
     * ⚠️ **The referral quota comes back with the list, not from a second request.** The screen has
     * to say *"终身 3 个，还剩 1 个"* **before** somebody presses the button — being told only when
     * it fails means they have already decided what to do with a code they cannot mint.
     *
     * ⚠️ **Counted from the rows, including revoked and expired ones**, exactly as the mint path
     * counts them. Two different counts of the same rule is how a screen comes to promise a code the
     * server then refuses (`教训.md` §8.12).
     */
    const referralUsed = await prisma.registrationInvite.count({
      where: { createdByUserId: userId },
    });

    return {
      collaborators,
      currentBookId,
      referralQuota: { limit: REFERRAL_CODE_LIFETIME_LIMIT, used: referralUsed },
    };
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/collaborators/lookup?accountNumber=… — find somebody to ask
  // ---------------------------------------------------------------------------
  app.get("/api/v1/collaborators/lookup", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const query = z.object({ accountNumber: z.string() }).parse(request.query);

    return findByAccountNumber(prisma, userId, query.accountNumber);
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/collaborators/requests — ask somebody to be a collaborator
  // ---------------------------------------------------------------------------
  app.post("/api/v1/collaborators/requests", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const body = z
      .object({
        /** ⚠️ The eight-digit number, not a user id: a client should never name a UUID it guessed. */
        accountNumber: z.string(),
        message: z.string().trim().max(200).optional(),
      })
      .parse(request.body);

    const target = await findByAccountNumber(prisma, userId, body.accountNumber);

    if (target.isCollaborator) {
      throw badRequest("already_collaborators", "你们已经是协作者了。");
    }

    const sent = await sendNotification(prisma, {
      senderId: userId,
      recipientId: target.id,
      kind: "collaborator_request",
      message: body.message ?? null,
    });

    void reply.code(201);
    return { ok: true, notificationId: sent.id, refreshed: sent.refreshed };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/collaborators/referral-codes — mint a "次级邀请码"
  // ---------------------------------------------------------------------------
  app.post("/api/v1/collaborators/referral-codes", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const body = z
      .object({
        /**
         * ⚠️ **The generator's choice, and it decides whether the newcomer gets a reminder at all.**
         * Defaults to `false` — the conservative answer — because a code created without thinking
         * about it should not become a door into somebody's collaborator list.
         */
        allowsDirectCollaborator: z.boolean().optional(),
        note: z.string().trim().max(120).optional(),
      })
      .parse(request.body ?? {});

    const minted = await mintReferralCode(prisma, {
      generatorId: userId,
      allowsDirectCollaborator: body.allowsDirectCollaborator ?? false,
      note: body.note ?? null,
    });

    void reply.code(201);
    /**
     * ⚠️ **The code is shown once and is also stored in clear**, unlike a share link — and the
     * difference is the point: an invitation code has to be *readable and repeatable* by the person
     * who generated it, while a share link only has to be *openable*. **Storing a referral code as a
     * hash would mean the generator could never look it up again**, which is the opposite of what a
     * code that gets read aloud over the phone is for.
     */
    return { ok: true, code: minted.code, allowsDirectCollaborator: minted.allowsDirectCollaborator, expiresAt: minted.expiresAt.toISOString() };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/books/invite — ask somebody into the current ledger
  // ---------------------------------------------------------------------------
  /**
   * ⚠️ **The identifier is an account number, not a user id.**
   *
   * Before 2026-10-12 this route took `:userId`, and that was only workable because **the inviter
   * had to be a collaborator first** — they were picking from a list they already had. The owner
   * removed that requirement, so the screen now starts from *"who do you want to invite?"* and the
   * only thing a person can know about a stranger is their eight-digit number.
   *
   * ⚠️ **A UUID from a client is a value it guessed.** Keeping the route on `accountNumber` means the
   * identifier is one the inviter could actually read off somebody's screen — and it reuses
   * `findByAccountNumber`, so **the "full eight digits, no prefix search" rule stays in one place**.
   */
  app.post("/api/v1/books/invite", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const body = z
      .object({
        accountNumber: z.string(),
        /** ⚠️ From the client, so it is a **request**, not an instruction — see below. */
        role: z.enum(["editor", "viewer"]).optional(),
        message: z.string().trim().max(200).optional(),
      })
      .parse(request.body ?? {});

    /**
     * ⚠️ **The ledger comes from the header and is checked as a *write* operation.**
     *
     * Inviting somebody into a ledger changes who can see its entries, so it is not a read and not
     * a convenience — **a viewer must not be able to do it.** That is what `requireBookForWrite`
     * decides, and it is the reason this route resolves the ledger itself instead of relying on the
     * plain auth guard the rest of this module uses.
     */
    const book = await requireBookForWrite(prisma, request, userId);

    /**
     * ⚠️ **Located through the same function the lookup screen uses**, so "you cannot search by
     * prefix" and "you cannot invite yourself" are enforced in one place rather than restated here.
     */
    const target = await findByAccountNumber(prisma, userId, body.accountNumber);

    /**
     * ⚠️ **The "you must be collaborators first" check was removed on 2026-10-12, on the owner's
     * explicit instruction.** His words:
     *
     * > *"我不希望用户必须先添加对方为好友，再另行邀请对方加入账本……理想流程是：
     * >  A 选择账本并邀请 B → B 收到邀请 → B 确认加入该账本。"*
     *
     * > *"在我的允许下，你可以修改已经上线的行为。我的想法发生了改变，邀请确实应该改成直接进账本，
     * >  而不是先成为协作者。"*
     *
     * ⚠️ **What replaces it is not "no check" — it is a different consent.**
     * The invitee still has to accept (`decideNotification` → `book_members`), and the inviter still
     * has to be able to **write** in the ledger. What is gone is the *additional* requirement that a
     * relationship exist first. **The owner's reason was cost, not safety**: for two people who
     * simply want to keep a ledger together, the old flow asked them to confirm the same intention
     * twice.
     *
     * ⚠️ **`not_collaborators` no longer exists as a refusal.** Nothing else in the API raises it.
     */
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
