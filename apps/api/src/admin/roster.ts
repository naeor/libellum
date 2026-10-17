import type { AdminRosterEntry, AdminRosterResponse } from "@libellum/shared";

import type { PrismaClient } from "../db.js";
import { isFirstBatchAccountNumber } from "./rules.js";

/**
 * **The administrator picture, read-only.**
 *
 * The console shows this and can do nothing else with it. Promotion and demotion stay at a
 * server terminal (`pnpm admin:grant` / `admin:allow` / `admin:revoke` / `admin:disallow`), which
 * is the owner's decision on 2026-10-17: *"网页不能撤销或者授权管理员"*.
 *
 * ⚠️ **"Only half" is the interesting row, and it is why this is a roster rather than a list.**
 * A grant without a listing (or the reverse) is a refusal that looks like an administrator in
 * any UI that only reads one table. The four states are shown as four states.
 *
 * ⚠️ **`active` is computed with the same rule the guard uses**, not a second definition of
 * "administrator": a live grant, a live allow-list entry, and a first-batch account number.
 * Anything else is not an administrator here either.
 */
type RosterRow = {
  id: string;
  accountNumber: string;
  username: string;
  displayName: string;
  adminGrant: { grantedAt: Date; revokedAt: Date | null } | null;
  adminAllowEntry: { listedAt: Date; revokedAt: Date | null } | null;
};

function isLive(record: { revokedAt: Date | null } | null): boolean {
  return record !== null && record.revokedAt === null;
}

function statusOf(row: RosterRow): AdminRosterEntry["status"] {
  const granted = isLive(row.adminGrant);
  const listed = isLive(row.adminAllowEntry);

  if (granted && listed && isFirstBatchAccountNumber(row.accountNumber)) return "active";
  if (granted && !listed) return "grant_only";
  if (!granted && listed) return "allowlist_only";

  return "eligible";
}

/** How many of these entries actually hold administration. */
export function countActiveAdmins(entries: readonly AdminRosterEntry[]): number {
  return entries.filter((entry) => entry.status === "active").length;
}

export async function loadAdminRoster(prisma: PrismaClient): Promise<AdminRosterResponse> {
  const rows = await prisma.user.findMany({
    where: {
      OR: [
        /** Inside the only range that may ever hold administration. */
        { accountNumber: { gte: "10000000", lte: "10000099" } },
        /** Anyone with a grant or a listing, even if their number is outside the range. */
        { adminGrant: { isNot: null } },
        { adminAllowEntry: { isNot: null } },
      ],
    },
    select: {
      id: true,
      accountNumber: true,
      username: true,
      displayName: true,
      adminGrant: { select: { grantedAt: true, revokedAt: true } },
      adminAllowEntry: { select: { listedAt: true, revokedAt: true } },
    },
    orderBy: { accountNumber: "asc" },
  });

  const entries: AdminRosterEntry[] = rows.map((row: RosterRow) => ({
    userId: row.id,
    accountNumber: row.accountNumber,
    username: row.username,
    displayName: row.displayName,
    status: statusOf(row),
    grantedAt: row.adminGrant?.grantedAt.toISOString() ?? null,
    listedAt: row.adminAllowEntry?.listedAt.toISOString() ?? null,
  }));

  return {
    entries,
    eligibleTotal: rows.filter((row) => isFirstBatchAccountNumber(row.accountNumber)).length,
  };
}
