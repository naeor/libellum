import type { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { reserveNotificationQuota, releaseNotificationQuota } from "./quota.js";

/**
 * Notifications: sending them, and acting on the ones that arrive.
 *
 * ⚠️ **A notification is the only place an undecided thing lives.** A collaborator row exists only
 * after both sides agreed, and a `book_members` row only after an invitation was accepted — so
 * there is exactly one record of "waiting", and it cannot disagree with itself
 * (`教训.md` §8.7).
 */

/** Seven days, the same for all three kinds (the owner: "统一七天"). */
export const NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type NotificationKind = "collaborator_request" | "book_invite" | "referral_reminder";

/**
 * ⚠️ **A concrete shape rather than `Record<string, unknown>`, and that is the safer choice.**
 *
 * `payload` decides what accepting a notification *does*, so an untyped bag would let a typo like
 * `{ roles: "viewer" }` be stored happily and then be read as "no role given" — **the invitation
 * would silently grant the default instead of what was chosen.** Naming the fields makes that a
 * compile error at the place the invitation is sent, which is the only place it can be fixed.
 */
export interface NotificationPayload {
  readonly role?: "editor" | "viewer";
}

/**
 * Send a notification, or refresh the one already waiting.
 *
 * ⚠️ **Re-sending does not create a second row, but it does cost quota.**
 *
 * Two people can press the same button twice, and two rows saying the same thing would make the
 * recipient decide twice about one question. So an existing pending notification from the same
 * sender about the same thing is **updated** — its message and its deadline — rather than
 * duplicated.
 *
 * ⚠️ **Quota is spent either way, and the distinction matters**: quota limits *how many times you
 * may push something at somebody*, not how many rows exist. If re-sending were free, the ceiling
 * would not bound the behaviour it was set to bound — somebody could press the button all day and
 * the recipient would see the notification rise to the top all day.
 */
export async function sendNotification(
  prisma: PrismaClient,
  input: {
    readonly senderId: string;
    readonly recipientId: string;
    readonly kind: NotificationKind;
    readonly bookId?: string | null;
    readonly message?: string | null;
    /**
     * ⚠️ **What accepting will do.** It travels with the notification because at the moment the
     * recipient accepts there is nowhere else to learn it from — see the migration that added the
     * column. Patching the row without replacing the payload would silently discard the intended
     * role, so a refresh carries it forward when the caller supplies one.
     */
    readonly payload?: NotificationPayload | null;
  },
  now: Date = new Date(),
): Promise<{ readonly id: string; readonly refreshed: boolean }> {
  if (input.senderId === input.recipientId) {
    throw badRequest("notification_self", "不能给自己发通知。");
  }

  const bookId = input.bookId ?? null;
  const expiresAt = new Date(now.getTime() + NOTIFICATION_TTL_MS);

  /**
   * ⚠️ **The quota is reserved before the row is written**, and both live in the same transaction
   * as the rest of the caller's work where there is one. The failure that leaves behind is
   * "quota spent, nothing sent" — **the direction that annoys rather than the direction that
   * harasses.**
   */
  await reserveNotificationQuota(prisma, input.senderId, input.recipientId, now);

  const existing = await prisma.notification.findFirst({
    where: {
      senderId: input.senderId,
      recipientId: input.recipientId,
      kind: input.kind,
      bookId,
      status: "pending",
    },
    select: { id: true },
  });

  if (existing) {
    await prisma.notification.update({
      where: { id: existing.id },
      data: {
        message: input.message ?? null,
        expiresAt,
        createdAt: now,
        readAt: null,
        /**
         * ⚠️ **Only overwritten when the caller supplies one.** Re-sending the same invitation
         * without a role must not wipe the role the first send recorded — that would turn a
         * `viewer` invitation into a default-role one, which is the exact silent widening this
         * column exists to prevent.
         */
        ...(input.payload === undefined || input.payload === null
          ? {}
          : { payload: input.payload as unknown as Prisma.InputJsonValue }),
      },
    });

    return { id: existing.id, refreshed: true };
  }

  const created = await prisma.notification.create({
    data: {
      senderId: input.senderId,
      recipientId: input.recipientId,
      kind: input.kind,
      bookId,
      message: input.message ?? null,
      ...(input.payload === undefined || input.payload === null
        ? {}
        : { payload: input.payload as unknown as Prisma.InputJsonValue }),
      expiresAt,
      createdAt: now,
    },
    select: { id: true },
  });

  return { id: created.id, refreshed: false };
}

/**
 * Withdraw a pending notification, and give its quota back.
 *
 * ⚠️ **Only the sender may withdraw**, and only while it is still pending — once somebody has
 * decided, the decision is theirs and not the sender's to erase.
 */
export async function withdrawNotification(
  prisma: PrismaClient,
  senderId: string,
  notificationId: string,
  now: Date = new Date(),
): Promise<void> {
  const existing = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: { senderId: true, recipientId: true, status: true, createdAt: true },
  });

  if (!existing) throw notFound("notification_missing", "找不到这条通知。");
  if (existing.senderId !== senderId) throw forbidden("notification_not_sender", "只能撤回自己发出的通知。");
  if (existing.status !== "pending") throw badRequest("notification_decided", "这条通知已经被处理过了。");

  await prisma.notification.delete({ where: { id: notificationId } });
  await releaseNotificationQuota(prisma, senderId, existing.recipientId, dayOf(existing.createdAt));
}

/** The UTC day a timestamp falls in — shared with `quota.ts` so the two cannot drift apart. */
export function dayOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
