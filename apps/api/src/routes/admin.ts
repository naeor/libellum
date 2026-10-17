import {
  adminAccountActionResponseSchema,
  adminAuditListResponseSchema,
  adminCreateInviteRequestSchema,
  adminCreateInviteResponseSchema,
  adminInviteListResponseSchema,
  adminOverviewResponseSchema,
  adminRestoreRequestSchema,
  adminRevokeInviteRequestSchema,
  adminRosterResponseSchema,
  adminSelfResponseSchema,
  adminSuspendRequestSchema,
  adminUserSearchResponseSchema,
  type AdminInvite,
  type AuditAction,
} from "@libellum/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { restoreAccount, suspendAccount } from "../admin/accounts.js";
import { recordAudit, recordRefusal, toAuditEntry } from "../admin/audit.js";
import type { AdminActor } from "../admin/guard.js";
import {
  inviteStatus,
  loadInvite,
  maskInviteCode,
  revokeInvite,
  toAdminInvite,
} from "../admin/invites.js";
import { createReauthVerifier } from "../admin/reauth.js";
import { countActiveAdmins, loadAdminRoster } from "../admin/roster.js";
import { createOrdinaryInvite, createReservedInvite } from "../auth/invites.js";
import type { PrismaClient } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";

/**
 * **The admin console's API** — the whole of it, in one file.
 *
 * ⚠️ **Every route is behind the same `createRequireAdmin`.** No handler re-derives who the
 * caller is, no handler reads an identity from the body or a header, and no handler decides
 * permission for itself. That is the design decision the project already made
 * (`管理员与权限边界-设计决定.md` §8.1–§8.2), and this file is where it gets used.
 *
 * ⚠️ **The endpoints exist unconditionally.** An earlier round registered a *test-only* admin
 * route that is absent unless a test asks for it — that was right, because it had no product
 * purpose. These do have one, so they are always registered and always guarded. **Their safety
 * comes from the guard, not from their address being secret.**
 *
 * ⚠️ **What is deliberately absent**: no route reads a ledger, a transaction, an amount or a
 * note. *"管理员可以管理系统，不应因此默认拥有查看所有私人账本的权限"* is enforced here by
 * there being nothing to call — not by a permission flag that could be flipped.
 */
export interface AdminRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAdmin: (request: FastifyRequest) => Promise<void>;
}

/**
 * How many invites one administrator may mint per hour.
 *
 * ⚠️ **Per administrator, not per IP**, because the case this guards against is a runaway loop
 * or a stolen session belonging to a real administrator, and both of those share one identity.
 * Ten an hour is far above normal use (a few a week) and far below what a script produces.
 */
const INVITES_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

/**
 * How old a backup record may be before the console stops calling it "current".
 *
 * ⚠️ **36 hours = daily 03:00 + a full day of grace.** A three-month-old row saying `ok=true`
 * is a true statement about three months ago and a misleading one about today; the API marks it
 * `stale` so the console can say "未知（记录已过期）" instead of "成功" (S13-D §5.5).
 */
const BACKUP_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

/** The actor, or a refusal. The guard ran first, so a missing actor means the two disagreed. */
function actorOf(request: FastifyRequest): AdminActor {
  const actor = request.adminActor;
  if (actor === undefined) {
    throw forbidden("admin_forbidden", "没有权限执行这个操作。");
  }

  return actor;
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): void {
  const { prisma, requireAdmin } = options;

  /**
   * ⚠️ **One verifier for the whole app.** The throttle inside it is in-memory state that only
   * works if it is shared; a verifier built per request would forget every failed attempt.
   */
  const reauth = createReauthVerifier(prisma);

  /** Sliding window of invite creations, keyed by administrator. */
  const inviteCreates = new Map<string, number[]>();

  function noteInviteCreate(adminUserId: string): void {
    const now = Date.now();
    const recent = (inviteCreates.get(adminUserId) ?? []).filter((at) => now - at < HOUR_MS);
    recent.push(now);
    inviteCreates.set(adminUserId, recent);

    if (recent.length > INVITES_PER_HOUR) {
      throw badRequest(
        "invite_rate_limited",
        `一小时内最多创建 ${String(INVITES_PER_HOUR)} 个邀请码，请稍后再试。`,
      );
    }
  }

  /**
   * The second factor, with its refusals recorded.
   *
   * ⚠️ **A wrong password is audited**, because "somebody tried to suspend an account and could
   * not produce the password" is exactly the kind of event an audit trail exists to show.
   */
  async function requirePassword(
    request: FastifyRequest,
    actor: AdminActor,
    password: string,
    action: AuditAction,
    target: string | null,
  ): Promise<void> {
    try {
      await reauth.verify(actor.userId, password);
    } catch (error) {
      await recordRefusal(prisma, request.log, {
        adminUserId: actor.userId,
        adminUsername: actor.username,
        action,
        target,
        outcome: "failed",
        detail: { reason: "二次验证失败" },
        requestId: request.id,
      });

      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/admin/self — "am I an administrator?"
  // ---------------------------------------------------------------------------
  /**
   * ⚠️ **A refusal is the answer for everybody else**, and that is on purpose: the console needs
   * one call to decide whether to render the entry point, and "403" is that decision. It carries
   * no information beyond "not you" — the same flat refusal every admin route gives.
   */
  app.get("/api/v1/admin/self", { preHandler: requireAdmin }, async (request) => {
    const actor = actorOf(request);

    return adminSelfResponseSchema.parse({
      isAdmin: true,
      username: actor.username,
      accountNumber: actor.accountNumber,
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/admin/overview
  // ---------------------------------------------------------------------------
  app.get("/api/v1/admin/overview", { preHandler: requireAdmin }, async () => {
    const now = new Date();

    const [users, suspended, demo, books, used, revoked, expired, roster, lastBackup, recent] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { disabledAt: { not: null } } }),
        prisma.user.count({ where: { isDemo: true } }),
        prisma.book.count(),
        prisma.registrationInvite.count({ where: { usedAt: { not: null } } }),
        prisma.registrationInvite.count({
          where: { usedAt: null, revokedAt: { not: null } },
        }),
        prisma.registrationInvite.count({
          where: { usedAt: null, revokedAt: null, expiresAt: { not: null, lte: now } },
        }),
        loadAdminRoster(prisma),
        prisma.backupLog.findFirst({ orderBy: { startedAt: "desc" } }),
        prisma.adminAuditLog.findMany({ orderBy: { at: "desc" }, take: 10 }),
      ]);

    /** Available = neither used nor revoked nor past its expiry. */
    const totalInvites = await prisma.registrationInvite.count();
    const available = Math.max(0, totalInvites - used - revoked - expired);

    return adminOverviewResponseSchema.parse({
      users: { total: users, suspended, demo },
      books: { total: books },
      invites: { available, used, revoked, expired },
      admins: {
        /** ⚠️ The guard's own definition, computed in one place (`admin/roster.ts`). */
        active: countActiveAdmins(roster.entries),
        halfConfigured: roster.entries.filter(
          (entry) => entry.status === "grant_only" || entry.status === "allowlist_only",
        ).length,
      },
      /**
       * ⚠️ `null` renders as "还没有记录". **It must never render as "正常"** — a screen that
       * invents reassurance is worse than one that admits it does not know.
       *
       * ⚠️ A row older than 36 hours is reported as `stale`, not as "成功/失败": the newest row
       * is a historical fact, and letting it speak for today is the same "invented reassurance"
       * in slower motion. The writer is `deploy/backup-all.sh` (via `backup-log.sh`); heartbeat
       * delivery never changes `ok`.
       */
      lastBackup:
        lastBackup === null
          ? null
          : {
              at: lastBackup.startedAt.toISOString(),
              ok: lastBackup.ok,
              note: lastBackup.note,
              stale: now.getTime() - lastBackup.startedAt.getTime() > BACKUP_STALE_AFTER_MS,
            },
      recentActions: recent.map(toAuditEntry),
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/admin/invites
  // ---------------------------------------------------------------------------
  app.get("/api/v1/admin/invites", { preHandler: requireAdmin }, async () => {
    const rows = await prisma.registrationInvite.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { usedBy: { select: { username: true } } },
    });

    const now = new Date();
    const invites: AdminInvite[] = rows.map((row) =>
      toAdminInvite(row, row.usedBy?.username ?? null, now),
    );

    return adminInviteListResponseSchema.parse({ invites });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/admin/invites
  // ---------------------------------------------------------------------------
  /**
   * ⚠️ **No administrator shape here.** Since 1.10.22 a code never confers administration, so the
   * console offers exactly the two shapes that mean something: an ordinary seven-day code, and a
   * code that reserves an account number and does not expire.
   */
  app.post("/api/v1/admin/invites", { preHandler: requireAdmin }, async (request) => {
    const actor = actorOf(request);
    const body = adminCreateInviteRequestSchema.parse(request.body);

    noteInviteCreate(actor.userId);

    const note = body.note === undefined || body.note === "" ? null : body.note;

    const created = await prisma.$transaction(async (tx) => {
      const invite =
        body.shape === "reserved"
          ? await createReservedInvite(tx, note)
          : await createOrdinaryInvite(tx, note);

      const row = await tx.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } });

      await recordAudit(tx, {
        adminUserId: actor.userId,
        adminUsername: actor.username,
        action: "invite.create",
        target: note ?? maskInviteCode(invite.code),
        outcome: "success",
        detail: {
          shape: body.shape,
          accountNumber: invite.accountNumber,
          expiresAt: invite.expiresAt?.toISOString() ?? null,
        },
        requestId: request.id,
      });

      return row;
    });

    return adminCreateInviteResponseSchema.parse({
      invite: toAdminInvite(created, null),
      /** ⚠️ The only time the plaintext is returned. It is not stored anywhere readable. */
      code: created.code,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/admin/invites/:id/revoke
  // ---------------------------------------------------------------------------
  app.post("/api/v1/admin/invites/:id/revoke", { preHandler: requireAdmin }, async (request) => {
    const actor = actorOf(request);
    const { id } = request.params as { id: string };
    const body = adminRevokeInviteRequestSchema.parse(request.body);

    const invite = await loadInvite(prisma, id);
    if (invite === null) throw notFound("invite_not_found", "没有这个邀请码。");

    const target = invite.note ?? maskInviteCode(invite.code);
    await requirePassword(request, actor, body.password, "invite.revoke", target);

    const statusBefore = inviteStatus(invite);

    const revoked = await prisma.$transaction(async (tx) => {
      await revokeInvite(tx, invite, body.acknowledgeUsed === true);

      await recordAudit(tx, {
        adminUserId: actor.userId,
        adminUsername: actor.username,
        action: "invite.revoke",
        target,
        outcome: "success",
        detail: {
          reason: body.reason,
          statusBefore,
          /** ⚠️ Revoking a code never closes the account it created — see `revokeInvite`. */
          redeemedBy: invite.usedByUsername,
        },
        requestId: request.id,
      });

      return tx.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } });
    });

    return adminInviteListResponseSchema.parse({
      invites: [toAdminInvite(revoked, invite.usedByUsername)],
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/admin/admins — read-only, on purpose
  // ---------------------------------------------------------------------------
  /**
   * ⚠️ **There is no grant/revoke endpoint, and its absence is the design.**
   *
   * Promotion and demotion write `admin_grants` and `admin_allowlist`, two independent facts whose
   * whole purpose is that they can be set separately. If a stolen administrator session could set
   * them, the second lock would be openable from inside the room it protects. The owner confirmed
   * this on 2026-10-17: *"网页不能撤销或者授权管理员"*.
   */
  app.get("/api/v1/admin/admins", { preHandler: requireAdmin }, async () => {
    return adminRosterResponseSchema.parse(await loadAdminRoster(prisma));
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/admin/users?q=...
  // ---------------------------------------------------------------------------
  /**
   * ⚠️ **Exact matches only** — a full account number or a full username. The owner's rule:
   * *"用户搜索允许编号精确和用户名精确的搜索"*. **No fuzzy listing**: an interface that can
   * enumerate accounts turns "the administrator can manage users" into "the administrator can
   * browse people", which is a different power.
   *
   * ⚠️ **The fields are the minimum that answers the question** — no ledger id, no ledger name,
   * no transaction, no amount, no preference.
   */
  app.get("/api/v1/admin/users", { preHandler: requireAdmin }, async (request) => {
    const query = request.query as { q?: string };
    const raw = (query.q ?? "").trim().toLowerCase();

    if (raw === "") {
      return adminUserSearchResponseSchema.parse({ users: [], exactMatchOnly: true });
    }

    const isAccountNumber = /^\d{8}$/.test(raw);

    const rows = await prisma.user.findMany({
      where: isAccountNumber
        ? { accountNumber: raw }
        : { username: { equals: query.q?.trim() ?? "" } },
      take: 5,
      select: {
        id: true,
        accountNumber: true,
        username: true,
        displayName: true,
        createdAt: true,
        isDemo: true,
        disabledAt: true,
        adminGrant: { select: { revokedAt: true } },
        adminAllowEntry: { select: { revokedAt: true } },
        _count: { select: { sessions: true } },
      },
      orderBy: { accountNumber: "asc" },
    });

    return adminUserSearchResponseSchema.parse({
      exactMatchOnly: true,
      users: rows.map((row) => {
        const eligible = row.accountNumber >= "10000000" && row.accountNumber <= "10000099";
        const granted = row.adminGrant !== null && row.adminGrant.revokedAt === null;
        const listed = row.adminAllowEntry !== null && row.adminAllowEntry.revokedAt === null;

        return {
          userId: row.id,
          accountNumber: row.accountNumber,
          username: row.username,
          displayName: row.displayName,
          createdAt: row.createdAt.toISOString(),
          isDemo: row.isDemo,
          isActiveAdmin: eligible && granted && listed,
          suspendedAt: row.disabledAt?.toISOString() ?? null,
          activeSessions: row._count.sessions,
        };
      }),
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/admin/accounts/:userId/suspend
  // ---------------------------------------------------------------------------
  app.post(
    "/api/v1/admin/accounts/:userId/suspend",
    { preHandler: requireAdmin },
    async (request) => {
      const actor = actorOf(request);
      const { userId } = request.params as { userId: string };
      const body = adminSuspendRequestSchema.parse(request.body);

      const looked = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true },
      });
      if (looked === null) throw notFound("account_not_found", "没有这个账户。");

      await requirePassword(request, actor, body.password, "account.suspend", looked.username);

      const result = await prisma.$transaction(async (tx) => {
        const outcome = await suspendAccount(tx, {
          targetUserId: userId,
          actorUserId: actor.userId,
          actorLabel: `${actor.username} (console)`,
        });

        await recordAudit(tx, {
          adminUserId: actor.userId,
          adminUsername: actor.username,
          action: "account.suspend",
          target: outcome.username,
          outcome: "success",
          detail: { reason: body.reason, sessionsRemoved: outcome.sessionsRemoved },
          requestId: request.id,
        });

        return outcome;
      });

      return adminAccountActionResponseSchema.parse({
        ok: true,
        username: result.username,
        sessionsRemoved: result.sessionsRemoved,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/v1/admin/accounts/:userId/restore
  // ---------------------------------------------------------------------------
  app.post(
    "/api/v1/admin/accounts/:userId/restore",
    { preHandler: requireAdmin },
    async (request) => {
      const actor = actorOf(request);
      const { userId } = request.params as { userId: string };
      const body = adminRestoreRequestSchema.parse(request.body);

      const looked = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true },
      });
      if (looked === null) throw notFound("account_not_found", "没有这个账户。");

      await requirePassword(request, actor, body.password, "account.restore", looked.username);

      const result = await prisma.$transaction(async (tx) => {
        const outcome = await restoreAccount(tx, {
          targetUserId: userId,
          actorUserId: actor.userId,
          actorLabel: `${actor.username} (console)`,
        });

        await recordAudit(tx, {
          adminUserId: actor.userId,
          adminUsername: actor.username,
          action: "account.restore",
          target: outcome.username,
          outcome: "success",
          detail: { reason: body.reason },
          requestId: request.id,
        });

        return outcome;
      });

      return adminAccountActionResponseSchema.parse({
        ok: true,
        username: result.username,
        sessionsRemoved: 0,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/v1/admin/audit
  // ---------------------------------------------------------------------------
  app.get("/api/v1/admin/audit", { preHandler: requireAdmin }, async (request) => {
    const query = request.query as { before?: string };
    const before = query.before === undefined ? undefined : new Date(query.before);

    const rows = await prisma.adminAuditLog.findMany({
      where:
        before === undefined || Number.isNaN(before.getTime()) ? {} : { at: { lt: before } },
      orderBy: { at: "desc" },
      take: 50,
    });

    return adminAuditListResponseSchema.parse({ entries: rows.map(toAuditEntry) });
  });
}
