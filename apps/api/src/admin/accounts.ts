import type { Prisma } from "../generated/prisma/client.js";
import { badRequest, notFound } from "../lib/errors.js";
import { isGrantActive } from "./rules.js";

/**
 * **Suspending and restoring an account** — the one write the console performs on a person.
 *
 * The owner's specification (2026-10-17), in his words:
 *
 * > *"在停用账户的一瞬间，服务器会把账户上的所有登录设备都踢出去，然后服务器把对应账户标记为
 * > 停用状态。停用状态的账户没法被登录，会在登录时显示'该账户目前已停用或不存在'。"*
 *
 * Three requirements fall out of that sentence, and each is a trap if done separately:
 *
 * 1. **Every device is signed out at that instant.** Deleting the sessions in the *same
 *    transaction* as the flag is what makes "at that instant" true. Marking first and cleaning
 *    later would leave a suspended person signed in for up to 30 days.
 * 2. **The account is marked, not deleted.** The ledger, the entries and the history stay:
 *    suspending a person is a different decision from destroying their records.
 * 3. **The login failure message is indistinguishable from "no such account"** —
 *    *"该账户目前已停用或不存在"*. A distinct message would turn the login form into a way to
 *    ask "does this username exist, and was it banned?"
 *
 * ⚠️ **The caller supplies the transaction**, exactly like `ledger/events.ts`: the flag, the
 * session deletions and the audit row have to commit together, so this function must not start
 * its own transaction and leave the caller unable to join it.
 *
 * ⚠️ **Two server-side refusals that a dialog cannot provide:**
 *
 * * **You cannot suspend yourself.** The session that performs the action is deleted by it.
 * * **You cannot suspend a serving administrator.** Administration is what can restore an
 *   account; suspending the last administrator leaves nobody able to undo anything. Revoke the
 *   administrator first (`pnpm admin:revoke` + `admin:disallow`), then suspend. This is enforced
 *   here rather than only warned about in the UI, because *"不能仅依靠界面上的弹窗保护危险 API"*.
 */

type Tx = Prisma.TransactionClient;

export interface AccountActionOptions {
  readonly targetUserId: string;
  readonly actorUserId: string;
  /** Recorded on the row (`disabled_by`), like `granted_by` on a grant. */
  readonly actorLabel: string;
}

export interface AccountActionResult {
  readonly username: string;
  readonly sessionsRemoved: number;
}

/** Whether this account currently holds administration by the guard's own definition. */
async function holdsAdministration(tx: Tx, userId: string): Promise<boolean> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      accountNumber: true,
      adminGrant: { select: { userId: true, revokedAt: true } },
      adminAllowEntry: { select: { userId: true, revokedAt: true } },
    },
  });

  if (user === null) return false;

  const eligible = user.accountNumber >= "10000000" && user.accountNumber <= "10000099";
  return eligible && isGrantActive(user.adminGrant) && isGrantActive(user.adminAllowEntry);
}

/**
 * Suspend an account and sign out every device, in the caller's transaction.
 *
 * ⚠️ **`deleteMany` on `sessions` is inside the transaction**, so a failure to flag the account
 * also undoes the sign-outs — the state a suspended person is in is either "suspended and signed
 * out" or "untouched", never half of each.
 */
export async function suspendAccount(
  tx: Tx,
  options: AccountActionOptions,
): Promise<AccountActionResult> {
  const { targetUserId, actorUserId, actorLabel } = options;

  if (targetUserId === actorUserId) {
    throw badRequest("cannot_suspend_self", "不能停用你自己的账户。");
  }

  const target = await tx.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, username: true, disabledAt: true },
  });

  if (target === null) throw notFound("account_not_found", "没有这个账户。");

  if (target.disabledAt !== null) {
    throw badRequest("account_already_suspended", "这个账户已经处于停用状态。");
  }

  if (await holdsAdministration(tx, targetUserId)) {
    throw badRequest(
      "account_is_admin",
      "不能停用一个现任管理员。请先在服务器终端撤销其管理员身份（admin:revoke + admin:disallow），再停用账户。",
    );
  }

  const sessions = await tx.session.deleteMany({ where: { userId: targetUserId } });

  await tx.user.update({
    where: { id: targetUserId },
    data: { disabledAt: new Date(), disabledBy: actorLabel },
  });

  return { username: target.username, sessionsRemoved: sessions.count };
}

/** Put a suspended account back. No sessions are created: the person signs in again. */
export async function restoreAccount(
  tx: Tx,
  options: AccountActionOptions,
): Promise<AccountActionResult> {
  const { targetUserId, actorUserId } = options;

  if (targetUserId === actorUserId) {
    throw badRequest("cannot_restore_self", "不能对自己执行这个操作。");
  }

  const target = await tx.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, username: true, disabledAt: true },
  });

  if (target === null) throw notFound("account_not_found", "没有这个账户。");

  if (target.disabledAt === null) {
    throw badRequest("account_not_suspended", "这个账户本来就没有被停用。");
  }

  await tx.user.update({
    where: { id: targetUserId },
    data: { disabledAt: null, disabledBy: null },
  });

  return { username: target.username, sessionsRemoved: 0 };
}
