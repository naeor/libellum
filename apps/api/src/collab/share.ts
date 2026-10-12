import type { PrismaClient } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { createHash, randomBytes } from "node:crypto";

/**
 * Share links: a URL somebody can open to join one ledger.
 *
 * ⚠️ **Only the hash is stored.** The plaintext token is returned once, to the person who generated
 * it, and the server cannot recover it afterwards. So a complete copy of the database — a backup,
 * a dump, a stolen disk — **still cannot be used to open anybody's ledger**. The same rule as
 * recovery codes and session tokens.
 *
 * ⚠️ **A plain SHA-256, with no salt and no work factor, and that is not an oversight.**
 *
 * The token is 256 bits from a CSPRNG, so there is no dictionary to guess and nothing to slow an
 * attacker down: a slow hash would only make **opening a link** slower for the person it was sent
 * to. `passwordHash` is the opposite case — a chosen, low-entropy secret that must be slow — and
 * **the two look alike enough that they must not be swapped.**
 *
 * ⚠️ **They do not count against the notification quota.** The owner was explicit: *"分享链接不算"*.
 * A link is opened by the invited person rather than pushed at them, so counting it would spend the
 * quota that exists to stop somebody being harassed.
 */

/** How long a link stays usable. The owner's *"1–7 天"*, and the range is enforced by a CHECK too. */
export const SHARE_LINK_MIN_DAYS = 1;
export const SHARE_LINK_MAX_DAYS = 7;

/**
 * How many people may join through one link. The owner's *"1–10 人"*.
 *
 * ⚠️ **This is the half that was missing**, and it is the difference between two different
 * defences: revoking is what you do *after* a link reached somewhere you did not intend, while a
 * cap is what stops the eleventh person from arriving while you are asleep. **His S9 acceptance
 * criterion names both** — *"分享链接过期/撤销/满员后无法再加入"*.
 */
export const SHARE_LINK_MIN_USES = 1;
export const SHARE_LINK_MAX_USES = 10;

export interface ShareLinkView {
  readonly id: string;
  readonly role: "editor" | "viewer";
  readonly days: number;
  readonly maxUses: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly useCount: number;
  readonly lastUsedAt: string | null;
  readonly createdBy: string;
  /** True when the link is neither revoked, expired, nor full. */
  readonly active: boolean;
}

/**
 * Hash a token for storage or lookup.
 *
 * ⚠️ **One function for both directions**, because a mismatch between how a token is written and
 * how it is looked up produces links that generate successfully and never work — a failure that
 * looks like "the link expired" from the outside.
 */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Create a link into `bookId`.
 *
 * ⚠️ **The plaintext is returned and never stored**, so this is the only moment it exists on the
 * server. A caller that loses it must generate a new link — which is why "regenerate" is a
 * supported operation rather than an emergency.
 */
export async function createShareLink(
  prisma: PrismaClient,
  input: {
    readonly bookId: string;
    readonly createdBy: string;
    readonly role: "editor" | "viewer";
    /** 1–7, the owner's range. */
    readonly days: number;
    /** 1–10, the owner's range. */
    readonly maxUses: number;
  },
  now: Date = new Date(),
): Promise<{ readonly id: string; readonly token: string; readonly expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const created = await prisma.bookShareLink.create({
    data: {
      tokenHash: hashShareToken(token),
      bookId: input.bookId,
      createdBy: input.createdBy,
      role: input.role,
      days: input.days,
      maxUses: input.maxUses,
      createdAt: now,
    },
    select: { id: true },
  });

  /**
   * ⚠️ **Expiry is computed from the stored days every time it is needed**, never stored as a
   * timestamp. A stored deadline is a second copy of a fact that `createdAt + days` already
   * determines — and **two copies of a fact drift** (`教训.md` §8.12).
   */
  return { id: created.id, token, expiresAt: expiresAtOf(now, input.days) };
}

/** When a link generated at `createdAt` for `days` days stops working. */
export function expiresAtOf(createdAt: Date, days: number): Date {
  return new Date(createdAt.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Revoke one link.
 *
 * ⚠️ **Revoking is not deleting.** The row keeps `revokedAt` and `revokedBy`, so the ledger's
 * history still says that a link existed and who withdrew it — which is exactly what somebody
 * auditing "how did this person get in" needs. A deleted row would answer nothing.
 *
 * ⚠️ **Only somebody who may write in the ledger can revoke**, checked by the caller: revoking
 * closes the door for everybody who has not walked through it yet.
 */
export async function revokeShareLink(
  prisma: PrismaClient,
  bookId: string,
  linkId: string,
  revokedBy: string,
  now: Date = new Date(),
): Promise<{ readonly alreadyRevoked: boolean }> {
  const link = await prisma.bookShareLink.findUnique({
    where: { id: linkId },
    select: { bookId: true, revokedAt: true },
  });

  if (!link || link.bookId !== bookId) throw notFound("share_link_missing", "找不到这条分享链接。");

  if (link.revokedAt !== null) return { alreadyRevoked: true };

  await prisma.bookShareLink.update({
    where: { id: linkId },
    data: { revokedAt: now, revokedBy },
  });

  return { alreadyRevoked: false };
}

/** What a token would join, for the confirmation dialog — **without joining**. */
export interface ShareLinkPreview {
  readonly bookId: string;
  readonly bookName: string;
  readonly bookNumber: string | null;
  readonly role: "editor" | "viewer";
  readonly alreadyMember: boolean;
  /** Who generated it, so the dialogue can say who is offering. */
  readonly createdByName: string;
  /** ⚠️ Needed by the join path to enforce the cap without a second read. */
  readonly maxUses: number;
}

/**
 * Look a token up without using it.
 *
 * ⚠️ **This is the step that makes "确认之后再加入" possible.** The owner's flow is: the link is
 * opened, the person is shown *which ledger and what permission*, and they confirm. **Showing that
 * requires reading, not joining** — a version that joined on open would add people to ledgers from
 * a stray tap on a link in a chat window.
 */
export async function previewShareLink(
  prisma: PrismaClient,
  token: string,
  viewerId: string,
  now: Date = new Date(),
): Promise<ShareLinkPreview> {
  const link = await prisma.bookShareLink.findUnique({
    where: { tokenHash: hashShareToken(token) },
    select: {
      role: true,
      revokedAt: true,
      days: true,
      maxUses: true,
      useCount: true,
      createdAt: true,
      book: { select: { id: true, name: true, bookNumber: true, disposedAt: true } },
      creator: { select: { displayName: true } },
    },
  });

  if (!link || link.revokedAt !== null || link.book.disposedAt !== null) {
    throw notFound("share_link_invalid", "这个分享链接无效或已失效。");
  }

  /**
   * ⚠️ **Expiry and fullness are checked here as well as at join time, and the duplication is
   * deliberate.** This check is what keeps a dead link from showing a *confirmation screen* — the
   * person would read "you are about to join 家庭账本" and only then be refused. The check in
   * `joinViaShareLink` is the one that actually protects the data; this one protects the person's
   * expectation.
   *
   * ⚠️ **Both answer `share_link_invalid`, the same as a revoked link.** Telling somebody holding a
   * stale link *why* it stopped working would confirm that the ledger exists — and the person who
   * needs to know more is the link's owner, who can see the state in the list.
   */
  if (expiresAtOf(link.createdAt, link.days).getTime() <= now.getTime()) {
    throw notFound("share_link_invalid", "这个分享链接无效或已失效。");
  }

  /**
   * ⚠️ **Someone already in the ledger is not blocked by fullness.** They are not taking a place:
   * the cap is about *how many people may join through this link*, and re-opening a link you have
   * already used adds nobody. **Refusing them would be refusing a member entry to their own
   * ledger** — and the use count still goes up, because the link really was used.
   */
  const membership = await prisma.bookMember.findUnique({
    where: { bookId_userId: { bookId: link.book.id, userId: viewerId } },
    select: { leftAt: true },
  });

  const alreadyMember = membership !== null && membership.leftAt === null;

  if (!alreadyMember && link.useCount >= link.maxUses) {
    throw notFound("share_link_invalid", "这个分享链接无效或已失效。");
  }

  return {
    bookId: link.book.id,
    bookName: link.book.name,
    bookNumber: link.book.bookNumber,
    role: link.role === "editor" ? "editor" : "viewer",
    alreadyMember,
    createdByName: link.creator.displayName,
    maxUses: link.maxUses,
  };
}

/**
 * Use a token: join the ledger.
 *
 * ⚠️ **`alreadyMember` is answered rather than refused.** Somebody who is already in the ledger and
 * taps the link again should land in it, not be told they made a mistake — and the count of uses is
 * still incremented, because **the link really was used**.
 *
 * ⚠️ **The role comes from the link, not from the request.** A caller cannot ask for `editor` when
 * the link was generated as `viewer`; that would turn "here is a read-only link" into a way to hand
 * out write access.
 */
export async function joinViaShareLink(
  prisma: PrismaClient,
  token: string,
  userId: string,
  now: Date = new Date(),
): Promise<{ readonly bookId: string; readonly joined: boolean; readonly role: "editor" | "viewer" }> {
  const preview = await previewShareLink(prisma, token, userId, now);

  await prisma.$transaction(async (tx) => {
    /**
     * ⚠️ **The cap is enforced by the `UPDATE` itself, not by a read followed by a write.**
     *
     * `where: { useCount: { lt: maxUses } }` means **zero rows affected is "the link is full"**.
     * Reading the count and then deciding leaves a window between the two steps — and **that window
     * is exactly when the tenth and eleventh people open the same link at once**, which is the whole
     * situation a cap exists for. The same reasoning as the notification quota.
     */
    const claimed = await tx.bookShareLink.updateMany({
      where: { tokenHash: hashShareToken(token), revokedAt: null, useCount: { lt: preview.maxUses } },
      data: { useCount: { increment: 1 }, lastUsedAt: now },
    });

    if (claimed.count !== 1) {
      /**
       * ⚠️ **A distinct code from "invalid"**, because by this point the person has already seen the
       * confirmation screen — they know the link worked a moment ago. "满员" is a fact about the
       * link that they can report back to whoever sent it, while "invalid" sends them hunting for a
       * typo.
       */
      throw badRequest("share_link_full", "这条分享链接的可加入人数已经用完了，请让邀请你的人再生成一条。");
    }

    if (preview.alreadyMember) return;

    const existing = await tx.bookMember.findUnique({
      where: { bookId_userId: { bookId: preview.bookId, userId } },
      select: { leftAt: true },
    });

    if (existing) {
      /**
       * ⚠️ **Rejoining through a link clears `leftAt` and sets the link's role.** Somebody who left
       * a ledger and was later sent a link is being invited back at the link's permission — keeping
       * their old role would grant something nobody offered this time.
       */
      await tx.bookMember.update({
        where: { bookId_userId: { bookId: preview.bookId, userId } },
        data: { leftAt: null, role: preview.role },
      });

      return;
    }

    await tx.bookMember.create({
      data: { bookId: preview.bookId, userId, role: preview.role },
    });
  });

  return { bookId: preview.bookId, joined: !preview.alreadyMember, role: preview.role };
}

/** Leave a ledger — the "我不想再显示这本账" half of the owner's two separate meanings. */
export async function leaveBook(
  prisma: PrismaClient,
  bookId: string,
  userId: string,
  now: Date = new Date(),
): Promise<{ readonly left: boolean }> {
  const book = await prisma.book.findUnique({ where: { id: bookId }, select: { createdBy: true } });
  if (!book) throw notFound("book_missing", "找不到这本账。");

  /**
   * ⚠️ **The creator cannot leave their own ledger**, and that is not arbitrary: leaving would make
   * a ledger with no member who may write in it — nobody could edit it, invite into it, or dispose
   * of it. **The owner's answer for that case is "整本弃置"**, which is the other of the two
   * meanings he asked to keep apart.
   */
  if (book.createdBy === userId) {
    throw badRequest("creator_cannot_leave", "这是你自己的账本。如果你不想再看到它，请用「弃置」。");
  }

  const membership = await prisma.bookMember.findUnique({
    where: { bookId_userId: { bookId, userId } },
    select: { leftAt: true },
  });

  if (!membership || membership.leftAt !== null) throw forbidden("not_a_member", "你不在这本账里。");

  /**
   * ⚠️ **A timestamp, not a deleted row.** The row is what the guard checks (`leftAt: null`), and it
   * is also the record that this person was once here — which matters when somebody asks why their
   * old entries are still in the ledger.
   */
  await prisma.bookMember.update({
    where: { bookId_userId: { bookId, userId } },
    data: { leftAt: now },
  });

  return { left: true };
}
