import type { PrismaClient } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";

/**
 * Members of one ledger: who is in it, what they may do, and how somebody leaves.
 *
 * ⚠️ **This is a ledger relationship, not a social one.** The owner drew that line himself:
 * *"这里的关系**始终是账本成员关系**，而不是微信或 QQ 那样的**全局社交好友关系**"* and
 * *"**成员管理必须明确属于当前账本。** 用户可能同时参与几本不同的共享账本，而每本账的成员都可能不同."*
 *
 * ⚠️ **So everything here takes a `bookId` and answers about that book only.** A "collaborator"
 * (account-level) is a different thing with a different list — see `routes/collab.ts`.
 */

export type MemberRole = "owner" | "editor" | "viewer";

export interface MemberView {
  readonly userId: string;
  readonly displayName: string;
  readonly username: string;
  readonly accountNumber: string;
  readonly role: MemberRole;
  /** ⚠️ The creator is not removable — see `removeMember`. */
  readonly isCreator: boolean;
}

export async function listMembers(prisma: PrismaClient, bookId: string): Promise<MemberView[]> {
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: { createdBy: true },
  });

  if (!book) throw notFound("book_missing", "找不到这本账。");

  /**
   * ⚠️ **`leftAt: null`, or the list includes people who left.** The same filter the permission
   * guard uses — **a member list that shows somebody the guard refuses is a list that lies about
   * what they can do.**
   */
  const rows = await prisma.bookMember.findMany({
    where: { bookId, leftAt: null },
    orderBy: { joinedAt: "asc" },
    select: {
      role: true,
      user: { select: { id: true, displayName: true, username: true, accountNumber: true } },
    },
  });

  return rows.map((row) => ({
    userId: row.user.id,
    displayName: row.user.displayName,
    username: row.user.username,
    accountNumber: row.user.accountNumber,
    role: row.role,
    isCreator: row.user.id === book.createdBy,
  }));
}

/**
 * Change what one member may do.
 *
 * ⚠️ **The creator's role cannot be lowered, and that is not decoration.** If the only person who
 * can write is demoted to `viewer`, the ledger becomes **unwritable and unadministrable** — nobody
 * can edit, invite, or dispose of it, and there is no screen that could undo it. The owner's answer
 * for a ledger one wants to get rid of is **整本弃置**.
 */
export async function changeMemberRole(
  prisma: PrismaClient,
  bookId: string,
  targetUserId: string,
  role: "editor" | "viewer",
): Promise<{ readonly changed: boolean }> {
  const book = await prisma.book.findUnique({ where: { id: bookId }, select: { createdBy: true } });
  if (!book) throw notFound("book_missing", "找不到这本账。");

  if (book.createdBy === targetUserId && role === "viewer") {
    throw badRequest("creator_is_editor", "创建者不能被降为仅查看，否则这本账将没有人能修改。");
  }

  const membership = await prisma.bookMember.findUnique({
    where: { bookId_userId: { bookId, userId: targetUserId } },
    select: { role: true, leftAt: true },
  });

  if (!membership || membership.leftAt !== null) {
    throw notFound("member_missing", "这个人不在这本账里。");
  }

  if (membership.role === role) return { changed: false };

  await prisma.bookMember.update({
    where: { bookId_userId: { bookId, userId: targetUserId } },
    data: { role },
  });

  return { changed: true };
}

/**
 * Remove somebody from a ledger.
 *
 * ⚠️ **A `leftAt` timestamp, not a deleted row** — identical to `leaveBook`. The row is what the
 * permission guard checks, and it is also the record that **this person was once here**, which is
 * what answers "why are their old entries still in my ledger".
 *
 * ⚠️ **The creator cannot be removed.** Removing them would leave a ledger nobody can write in —
 * the same reason their role cannot be lowered.
 *
 * ⚠️ **Removing yourself is refused too**, and the reason is not symmetry: *"leave"* is a thing a
 * person does to themselves from their own screen, and **doing it through the member list means one
 * tap has no confirmation path.** The route for it is `POST /books/:bookId/leave`.
 */
export async function removeMember(
  prisma: PrismaClient,
  bookId: string,
  targetUserId: string,
  actorId: string,
  now: Date = new Date(),
): Promise<{ readonly removed: boolean }> {
  const book = await prisma.book.findUnique({ where: { id: bookId }, select: { createdBy: true } });
  if (!book) throw notFound("book_missing", "找不到这本账。");

  if (book.createdBy === targetUserId) {
    throw badRequest("creator_cannot_be_removed", "创建者不能被移出这本账，否则这本账将没有人能修改。");
  }

  if (targetUserId === actorId) {
    throw badRequest("remove_self", "不能用移除的方式让自己离开，请用「退出这本账」。");
  }

  const membership = await prisma.bookMember.findUnique({
    where: { bookId_userId: { bookId, userId: targetUserId } },
    select: { leftAt: true },
  });

  if (!membership || membership.leftAt !== null) {
    throw forbidden("member_missing", "这个人不在这本账里。");
  }

  await prisma.bookMember.update({
    where: { bookId_userId: { bookId, userId: targetUserId } },
    data: { leftAt: now },
  });

  return { removed: true };
}
