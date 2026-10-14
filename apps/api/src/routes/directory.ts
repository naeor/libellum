import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { PrismaClient } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { findByAccountNumber, findByUsername, type FoundAccount } from "../collab/directory.js";
import { mintReferralCode, REFERRAL_CODE_LIFETIME_LIMIT } from "../collab/referral.js";
import { requireBook } from "../ledger/access.js";

/**
 * **Finding somebody to invite, and the account-level referral codes.**
 *
 * ⚠️ **This file used to be `collab.ts` and it used to hold the account-level collaborator system.**
 * That system was removed in 1.10.05 — the owner's decision, and he asked for it to be removed
 * rather than hidden: *"这次应当真正消除旧的双重确认流程，而不只是把旧协作者系统隐藏起来."*
 *
 * ⚠️ **What replaced it is simpler in exactly one way: an invitation belongs to a ledger.** A ledger
 * is like a group chat — you search for a person, pick their role, and invite them into *this* book.
 * **There is no account-level relationship to establish first**, and nothing here grants ledger
 * access: permission still comes from `book_members` alone, and only after the recipient accepts.
 *
 * ⚠️ **The account lookup is the same narrow endpoint it always was**, and it is deliberately the
 * narrowest question anybody can ask about another account — see `collab/directory.ts` for why it
 * takes a whole identifier and answers with one match or none.
 */
export interface DirectoryRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
}

/**
 * ⚠️ **Both an account number and a username, and the mode is explicit rather than sniffed.**
 *
 * The owner allowed both on 2026-10-13 — *"二者都允许吧……算了也允许用户名精准匹配好了，反正泄露个名字也没啥"* —
 * and weighed the privacy point himself. **The exposure is a display name against a username
 * somebody already knows**, which is not the risk worth designing around here.
 *
 * ⚠️ **The risk that *is* worth designing around is enumeration**, and it is unchanged: an exact
 * match on one identifier answers about one account. **Prefix search stays refused for both** — a
 * `startsWith` on a sequentially allocated number, or on a name, turns "find my friend" into "list
 * the user base". `directory.ts` states the reasoning and the endpoint keeps a dedicated rate limit.
 */
const lookupQuerySchema = z.union([
  z.object({ accountNumber: z.string() }),
  z.object({ username: z.string() }),
]);

const foundAccountSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  username: z.string(),
  accountNumber: z.string(),
  /** True when they are already an active member of the ledger I am looking at. */
  alreadyMember: z.boolean(),
});

export function registerDirectoryRoutes(
  app: FastifyInstance,
  options: DirectoryRouteOptions,
): void {
  const { prisma, requireAuth } = options;

  // ---------------------------------------------------------------------------
  // GET /api/v1/directory/lookup — find one account to invite
  // ---------------------------------------------------------------------------
  app.get("/api/v1/directory/lookup", { preHandler: requireAuth }, async (request) => {
    const me = request.currentUser!.id;
    const parsed = lookupQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      throw badRequest(
        "lookup_shape",
        "按 8 位账号编号，或完整的用户名查找。",
      );
    }

    const found: FoundAccount = "accountNumber" in parsed.data
      ? await findByAccountNumber(prisma, me, parsed.data.accountNumber)
      : await findByUsername(prisma, me, parsed.data.username);

    /**
     * ⚠️ **The ledger is optional here, and resolving it must not be able to refuse the lookup.**
     *
     * This route is registered with the plain auth guard, so `request.book` is not populated — and
     * **it must not become a route that demands a ledger**: looking somebody up is an account-level
     * question, and the screen asks it while the ledger is still being named. So the ledger is
     * resolved *if the header names one the caller may write in*, and otherwise the answer simply
     * carries no ledger context.
     *
     * ⚠️ **A refusal is swallowed on purpose, and it is not a hole.** Every question below that
     * depends on a ledger is about *this caller's own view of it*; none of them grants anything. The
     * route that actually changes data — `POST /books/invite` — does its own `requireBookForWrite`
     * and repeats the membership check, so a lookup that answered optimistically would still not get
     * anybody into anywhere.
     */
    let bookId: string | null = null;
    try {
      bookId = (await requireBook(prisma, request, me)).bookId;
    } catch {
      bookId = null;
    }

    const [membership, invitation] =
      bookId === null
        ? [null, null]
        : await Promise.all([
            prisma.bookMember.findUnique({
              where: { bookId_userId: { bookId, userId: found.id } },
              select: { leftAt: true },
            }),
            /**
             * ⚠️ **The most recent invitation that has not expired**, so the screen can say
             * *"已邀请，等待对方确认"* or *"对方拒绝了"* instead of offering the same button again.
             *
             * ⚠️ **This is why sent invitations do not need their own endpoint.** The owner asked
             * that *"邀请接受或拒绝后，状态正确更新"* — and the person who needs to know is the
             * **sender**, who by definition is the one doing the looking-up. `GET /notifications`
             * returns what was *received*, which is the right question for the inbox and the wrong
             * one here; asking it again at the moment somebody is about to re-invite is both
             * sufficient and cheaper than a second list to keep in step (`教训.md` §8.12).
             */
            prisma.notification.findFirst({
              where: {
                senderId: me,
                recipientId: found.id,
                kind: "book_invite",
                bookId,
                expiresAt: { gt: new Date() },
              },
              orderBy: { createdAt: "desc" },
              select: { id: true, status: true, createdAt: true },
            }),
          ]);

    return {
      account: foundAccountSchema.parse({
        ...found,
        alreadyMember: membership !== null && membership.leftAt === null,
      }),
      /** Whether *I* may invite into the ledger I am looking at, so the screen can say why not. */
      canInvite: request.book?.role !== "viewer",
      /**
       * The invitation already outstanding for this person in this ledger, if any — so the screen
       * can show its state rather than offering to send the same invitation twice.
       */
      invitation:
        invitation === null
          ? null
          : {
              id: invitation.id,
              status: invitation.status as "pending" | "accepted" | "declined",
              createdAt: invitation.createdAt.toISOString(),
            },
    };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/referral-codes — an account-level code, not a ledger invitation
  // ---------------------------------------------------------------------------
  /**
   * ⚠️ **This moved off the collaborator route, and it is account-level by definition.** A referral
   * code creates a **new account**; it grants no access to any of my ledgers. The owner separated
   * the two himself and moved the screen to 账户, and the path now says the same thing the screen
   * says: it belongs to the account, not to a ledger.
   */
  app.post("/api/v1/referral-codes", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.currentUser!.id;

    const body = (request.body ?? {}) as { allowsDirectCollaborator?: boolean };

    /**
     * ⚠️ **The `allowsDirectCollaborator` flag is gone, and this rejects it rather than ignoring
     * it.** A caller still sending it is running an older client, and silently minting a code
     * without the effect they asked for would be the quiet kind of wrong. See
     * `collab/referral.ts`.
     */
    if (body.allowsDirectCollaborator !== undefined) {
      throw badRequest(
        "referral_flag_removed",
        "邀请码不再有「直接加为协作者」这个选项了。账本邀请请直接邀请对方加入账本。",
      );
    }

    const minted = await mintReferralCode(prisma, { generatorId: userId });

    void reply.code(201);
    return {
      code: minted.code,
      expiresAt: minted.expiresAt,
      /** The lifetime ceiling travels with the code so the screen never has to keep its own copy. */
      quota: { limit: REFERRAL_CODE_LIFETIME_LIMIT },
    };
  });

  /**
   * ⚠️ **The remaining referral quota has to be readable without the collaborator list.** The
   * account screen used to get this bundled with `GET /collaborators` — a list that no longer
   * exists. Bundling it with a list that is gone is exactly how a screen ends up showing a number
   * nothing maintains (`教训.md` §8.12), so it is now its own question about the account.
   */
  app.get("/api/v1/referral-codes", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;

    const used = await prisma.registrationInvite.count({
      where: { createdByUserId: userId, accountNumber: null },
    });

    return {
      quota: { limit: REFERRAL_CODE_LIFETIME_LIMIT, used },
    };
  });
}
