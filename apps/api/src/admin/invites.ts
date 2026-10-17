import type { AdminInvite, AdminInviteStatus } from "@libellum/shared";

import type { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "../db.js";
import { badRequest } from "../lib/errors.js";

/**
 * Reading and revoking registration invites from the console.
 *
 * ⚠️ **The status is computed, never stored.** A stored status needs something to keep it true,
 * and on any day that thing does not run the status is a lie. `rejectInvite` in `shared` already
 * derives the answer for registration; this file derives the same answer for the list — the order
 * (used → revoked → expired) is copied from there deliberately, because a code that reads
 * "已作废" in the console and "已被使用" at registration is a support ticket.
 *
 * ⚠️ **The plaintext never leaves the creation response.** `maskInviteCode` is what the list
 * shows, and no function here returns the raw code for an existing row.
 */

/** The fields this module needs from an invite row. */
export interface InviteRow {
  readonly id: string;
  readonly code: string;
  readonly note: string | null;
  readonly accountNumber: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly usedAt: Date | null;
}

/** Used first, then revoked, then expired — the same order `rejectInvite` applies. */
export function inviteStatus(invite: InviteRow, now: Date = new Date()): AdminInviteStatus {
  if (invite.usedAt !== null) return "used";
  if (invite.revokedAt !== null) return "revoked";
  if (invite.expiresAt !== null && invite.expiresAt.getTime() <= now.getTime()) return "expired";

  return "available";
}

/**
 * `7K2M-••••-••••` — the first group is enough to tell two codes apart on screen and not enough
 * to use one.
 *
 * ⚠️ **Masking is not decoration.** The owner's rule is *"邀请码创建之后不显示"*, and this is the
 * shape of "not showing it": the operator can recognise the row they created, and a screenshot
 * of the console is not a working credential.
 */
export function maskInviteCode(code: string): string {
  const groups = code.split("-");
  if (groups.length < 2) return "••••";

  return [`${groups[0] ?? "••••"}`, ...groups.slice(1).map(() => "••••")].join("-");
}

/** Map a row (plus the redeemer's username, when there is one) to the wire shape. */
export function toAdminInvite(
  invite: InviteRow,
  usedByUsername: string | null,
  now: Date = new Date(),
): AdminInvite {
  return {
    id: invite.id,
    maskedCode: maskInviteCode(invite.code),
    note: invite.note,
    accountNumber: invite.accountNumber,
    status: inviteStatus(invite, now),
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt?.toISOString() ?? null,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    usedAt: invite.usedAt?.toISOString() ?? null,
    usedByUsername,
  };
}

/**
 * The revocable/irrevocable question, answered against a real row.
 */
export async function loadInvite(
  prisma: PrismaClient,
  id: string,
): Promise<(InviteRow & { usedByUsername: string | null }) | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;

  const row = await prisma.registrationInvite.findUnique({
    where: { id },
    include: { usedBy: { select: { username: true } } },
  });

  if (row === null) return null;

  return { ...row, usedByUsername: row.usedBy?.username ?? null };
}

/**
 * Withdraw a code.
 *
 * ⚠️ **A timestamp, never a delete.** `revoked_at` keeps "when was this taken back", which is the
 * question whoever audits the code will ask; a deleted row would have destroyed the history. The
 * owner's instruction on 2026-10-10 was exactly this, and it is printed in the operator's manual.
 *
 * ⚠️ **Revoking a code that was already redeemed does NOT close the account it created.** The
 * owner was explicit: *"注销邀请码并不意味着要注销这个账户，对应的账户依然要手动进行相关操作"*.
 * The caller must acknowledge that warning (`acknowledgeUsed`), and the account is left alone.
 *
 * ⚠️ **Reserved codes ARE revocable** — the owner confirmed it on 2026-10-17. The reserved number
 * stays consumed either way: account numbers are handed out like printed cards, and taking a card
 * back does not put the number back in the drawer.
 */
export async function revokeInvite(
  prisma: Prisma.TransactionClient,
  invite: InviteRow,
  acknowledgeUsed: boolean,
): Promise<void> {
  const status = inviteStatus(invite);

  if (status === "revoked") {
    throw badRequest("invite_already_revoked", "这个邀请码已经作废过了。");
  }

  if (status === "used" && !acknowledgeUsed) {
    throw badRequest(
      "invite_used_needs_acknowledgement",
      "这个邀请码已经被注册使用了。作废它不会关闭已经注册的账户——账户仍需你单独处理。请确认后重试。",
    );
  }

  await prisma.registrationInvite.update({
    where: { id: invite.id },
    data: { revokedAt: new Date() },
  });
}
