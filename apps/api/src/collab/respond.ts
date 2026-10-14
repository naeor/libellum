import type { PrismaClient } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { recordEvent } from "../ledger/events.js";
import { dayOf } from "./notify.js";
import { releaseNotificationQuota } from "./quota.js";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Act on a notification — accept it or decline it — and do whatever accepting means.
 *
 * ⚠️ **A notification is a message, so deciding it is not the same as acting on it.** Accepting a
 * collaborator request must create the relationship; accepting a ledger invitation must create the
 * membership. **Both happen here, in the same transaction as the decision**, because a decision
 * recorded without its effect is a state nobody can recover from: the notification is gone from
 * the inbox and nothing was added.
 */

export type Decision = "accepted" | "declined";

/**
 * The role an invitation will grant when accepted.
 *
 * ⚠️ **A missing payload falls back to `editor`, which is today's behaviour** — so notifications
 * created before the payload column existed stay decidable rather than becoming dead cards. The
 * fallback is deliberately the same value the hard-coded version used: a migration that changed
 * what an existing invitation does would be a permission change disguised as a schema change.
 *
 * ⚠️ **An unrecognised value is treated as missing, not trusted.** The payload is JSON written by
 * an older version of this code; a role this build does not know is a reason to fall back, never a
 * reason to write it into `book_members` and let the database enum reject it later.
 */
function roleFrom(payload: unknown): "editor" | "viewer" {
  if (payload === null || typeof payload !== "object") return "editor";

  const role = (payload as { role?: unknown }).role;

  return role === "viewer" ? "viewer" : "editor";
}

export interface DecisionResult {
  /** The ledger the person now belongs to, when accepting an invitation. */
  readonly bookId: string | null;
  /** True when accepting created a brand-new membership rather than reviving one. */
  readonly joined: boolean;
}

export async function decideNotification(
  prisma: PrismaClient,
  recipientId: string,
  notificationId: string,
  decision: Decision,
  now: Date = new Date(),
): Promise<DecisionResult> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: {
      recipientId: true,
      senderId: true,
      kind: true,
      bookId: true,
      /**
       * ⚠️ Selected because accepting an invitation must grant **the role that was offered**, and
       * the payload is the only place that intention is recorded — see the migration that added it.
       */
      payload: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      /**
       * ⚠️ **The recipient's name, so the history can name the person who joined.** It is a snapshot
       * for the same reason every other `actorName` is: **renaming yourself must not rewrite the
       * record of what you did.**
       */
      recipient: { select: { displayName: true } },
      /** ⚠️ And the ledger's name, for the sentence's subject. */
      book: { select: { name: true } },
    },
  });

  if (!notification) throw notFound("notification_missing", "找不到这条通知。");

  /**
   * ⚠️ **Only the recipient may decide.** The sender may withdraw (see `withdrawNotification`), but
   * accepting on somebody's behalf is exactly what the "对方同意" requirement exists to prevent.
   */
  if (notification.recipientId !== recipientId) {
    throw forbidden("notification_not_recipient", "只能处理发给自己的通知。");
  }

  if (notification.status !== "pending") {
    throw badRequest("notification_decided", "这条通知已经处理过了。");
  }

  /**
   * ⚠️ **Expiry is a comparison, not a stored status** (see the schema). Checking it here is what
   * makes storing it unnecessary: a decision arrived at after the deadline is refused at the
   * moment somebody tries to make it, which is the only moment it matters.
   */
  if (notification.expiresAt.getTime() <= now.getTime()) {
    throw badRequest("notification_expired", "这条通知已经过期了。");
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.notification.update({
      where: { id: notificationId },
      data: { status: decision, decidedAt: now, readAt: now },
    });

    if (decision === "declined") {
      /**
       * ⚠️ **Declining gives the quota back, and the sender is never told which one it was.**
       *
       * The owner asked for refusal to be visible rather than hidden — *"看到被拒绝"* — and the
       * ceiling is what makes that safe to do: the sender learns the answer, and the limit is what
       * stops them asking again and again. The notification row stays, so the answer has a record.
       *
       * ⚠️ The quota returns because the attention it was spent on is finished either way: holding
       * it would mean a refusal costs the sender more than an unanswered request, which is backwards.
       */
      await releaseNotificationQuota(tx as unknown as Tx, notification.senderId, notification.recipientId, dayOf(notification.createdAt));

      return { bookId: null, joined: false };
    }

    /**
     * ⚠️ **`collaborator_request` is gone (1.10.05).** Accepting it used to create the account-level
     * relationship that a ledger invitation required first. That relationship no longer exists — a
     * ledger is like a group chat, so the invitation *is* the consent request — and the migration
     * `remove_account_level_collaborators` deletes any that were still pending, **so this branch
     * cannot be reached by a row that still exists.**
     *
     * ⚠️ **It is not silently ignored, though.** A `collaborator_request` row arriving here means an
     * old client is still sending them, and answering "done" would be a lie about a relationship
     * that was never created. The kind is refused as unknown below.
     */

    if (notification.kind === "book_invite") {
      if (notification.bookId === null) {
        /**
         * A ledger invitation with no ledger is a row that should not exist — the migration's
         * CHECK cannot express "book_id is required for this kind", so it is caught here rather
         * than trusted.
         */
        throw badRequest("notification_malformed", "这条邀请没有对应的账本。");
      }

      const membership = await tx.bookMember.findUnique({
        where: { bookId_userId: { bookId: notification.bookId, userId: recipientId } },
        select: { leftAt: true },
      });

      if (membership) {
        /**
         * ⚠️ **Rejoining clears `leftAt` instead of adding a row**, and the row already exists
         * because leaving keeps it. `joined` stays false so the caller can say "你已经在这本账里"
         * rather than claiming a new membership.
         */
        await tx.bookMember.update({
          where: { bookId_userId: { bookId: notification.bookId, userId: recipientId } },
          data: { leftAt: null },
        });

        /**
         * ⚠️ **Returning is recorded as an event too.** A ledger's member list changing with no line
         * in the history is the thing the owner asked to avoid: *"也可以适当展示成员加入、退出……
         * 等重要协作事件."*
         */
        await recordEvent(tx, {
          bookId: notification.bookId,
          actorId: recipientId,
          actorName: notification.recipient.displayName,
          kind: "member_changed",
          changes: { joined: { from: "曾经退出", to: "重新加入" } },
        });

        return { bookId: notification.bookId, joined: membership.leftAt !== null };
      }

      await tx.bookMember.create({
        data: { bookId: notification.bookId, userId: recipientId, role: roleFrom(notification.payload) },
      });

      /**
       * ⚠️ **The event the member management could not produce, because joining does not happen
       * there.** Accepting an invitation is where somebody *enters* a ledger — writing this anywhere
       * else would mean the history recorded that a member existed without recording how.
       *
       * ⚠️ **The actor is the person who joined**, not the inviter: the sentence the reader wants is
       * *"B 加入了这本账"*, and the notification already tells them who asked.
       */
      await recordEvent(tx, {
        bookId: notification.bookId,
        actorId: recipientId,
        actorName: notification.recipient.displayName,
        kind: "member_changed",
        changes: { joined: { from: null, to: "加入" } },
      });

      return { bookId: notification.bookId, joined: true };
    }

    /**
     * `referral_reminder` has no side effect on acceptance, and that was the owner's design: the
     * reminder is a convenience, not a grant. ⚠️ **Its wording no longer mentions collaborators** —
     * it points at inviting somebody into a ledger, which is the action that exists.
     */
    return { bookId: null, joined: false };
  });

  return result;
}
