import {
  INVITE_REJECTION_CODE,
  INVITE_REJECTION_MESSAGE,
  authResponseSchema,
  changePasswordRequestSchema,
  currencySchema,
  loginRequestSchema,
  meResponseSchema,
  recoverRequestSchema,
  recoveryCodeResponseSchema,
  regenerateRecoveryCodeRequestSchema,
  registerRequestSchema,
  rejectInvite,
  type SessionUser,
  updatePreferencesRequestSchema,
} from "@libellum/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createRequireAuth } from "../auth/guard.js";
import { LoginThrottle } from "../auth/login-throttle.js";
import { getDummyHash, hashPassword, verifyPassword } from "../auth/password.js";
import {
  generateRecoveryCode,
  takeNextAccountNumber,
  normalizeRecoveryCode,
} from "../auth/recovery-code.js";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  generateSessionToken,
  hashSessionToken,
  sessionExpiryFrom,
} from "../auth/session.js";
import type { PrismaClient } from "../db.js";
import { recordReferral } from "../collab/referral.js";
import { createDefaultLedger } from "../ledger/bootstrap.js";
import { badRequest, conflict, tooManyRequests, unauthorized } from "../lib/errors.js";

export interface AuthRouteOptions {
  readonly prisma: PrismaClient;
  readonly throttle: LoginThrottle;
  /** Set the cookie's Secure flag (true in production, false on http://localhost). */
  readonly cookieSecure: boolean;
}

interface RequestMeta {
  readonly userAgent: string | undefined;
  readonly ipAddress: string | undefined;
}

type UserRow = {
  id: string;
  accountNumber: string;
  username: string;
  displayName: string;
  isDemo: boolean;
  defaultCurrency: string;
  createdAt: Date;
};

function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    accountNumber: user.accountNumber,
    username: user.username,
    displayName: user.displayName,
    isDemo: user.isDemo,
    // See the guard: the column type is wider than the supported set, and only
    // a manual database edit could put anything else in it.
    defaultCurrency: currencySchema.catch("CNY").parse(user.defaultCurrency),
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Account numbers are unique and now allocated from a server-owned counter, so
 * this helper is gone: it used to generate a random candidate and retry on a
 * clash, which was the right shape while numbers were random and is the wrong
 * shape now. See `takeNextAccountNumber`.
 */

function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

function metaFrom(request: FastifyRequest): RequestMeta {
  return {
    userAgent: request.headers["user-agent"],
    ipAddress: request.ip,
  };
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { prisma, throttle, cookieSecure } = options;

  /**
   * Sign one device in, without touching any other device's session.
   *
   * ⚠️ **This used to be one session per user, and the owner removed that rule after a real test**:
   * "我觉得是时候删除掉每个账号只能有一台设备登录的限制了；每个账号现在都应该可以被多台设备同时登录，而不会被
   * 踢掉."
   *
   * What it did: `upsert({ where: { userId } })` overwrote whatever session existed, so **signing in on the
   * phone logged the tablet out at its next request.** And it was interfering with the feature being tested —
   * **the offline design is built on two devices holding two copies of one ledger**, and conflict detection only
   * exists because those copies can diverge. **A rule that logs one of them out removes the ability to use, and
   * to test, the thing it interrupts.**
   *
   * ⚠️ **Nothing about the security model needed it.** A session is identified by the hash of its own token,
   * which is unique on its own; revocation is per-token; and a password change still clears every session for
   * the account, **which is the one place where "all devices, all at once" is actually the intent.**
   *
   * ⚠️ **Old sessions are not cleaned up here.** They expire on their own after `SESSION_TTL_MS`, and deleting
   * them on sign-in would be deleting rows on a path that has nothing to do with them — **a device that is
   * logged out by somebody else's login is exactly the behaviour being removed.**
   */
  async function issueSession(reply: FastifyReply, userId: string, meta: RequestMeta): Promise<void> {
    const token = generateSessionToken();

    await prisma.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt: sessionExpiryFrom(new Date()),
        userAgent: meta.userAgent ?? null,
        ipAddress: meta.ipAddress ?? null,
      },
    });

    setSessionCookie(reply, token, cookieSecure);
  }

  const requireAuth = createRequireAuth(prisma);

  async function assertNotThrottled(
    request: FastifyRequest,
    reply: FastifyReply,
    keys: readonly string[],
  ): Promise<void> {
    const retryAfter = throttle.retryAfterSeconds(keys);

    if (retryAfter > 0) {
      reply.header("retry-after", String(retryAfter));
      throw tooManyRequests("too_many_attempts", `尝试次数过多，请 ${String(retryAfter)} 秒后再试。`);
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/register
  // ---------------------------------------------------------------------------
  app.post("/api/v1/auth/register", async (request, reply) => {
    const body = registerRequestSchema.parse(request.body);
    const inviteCode = body.inviteCode.toUpperCase();

    const invite = await prisma.registrationInvite.findUnique({ where: { code: inviteCode } });

    if (!invite) throw badRequest("invite_invalid", "邀请码无效。");

    /**
     * Why this code cannot be used, if it cannot.
     *
     * The rule lives in `shared` (`rejectInvite`) because the invite list has to
     * label a code the same way registration rejects it — a code that reads
     * "已过期" in one place and "可用" in another is a support ticket. `used` is
     * checked first there, so a code that was both used and has since expired
     * says "used", which is the fact that ends the story.
     */
    const rejection = rejectInvite(invite);
    if (rejection !== null) {
      throw badRequest(INVITE_REJECTION_CODE[rejection], INVITE_REJECTION_MESSAGE[rejection]);
    }

    const taken = await prisma.user.findUnique({ where: { username: body.username } });
    if (taken) throw conflict("username_taken", "该用户名已被占用。");

    const passwordHash = await hashPassword(body.password);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await hashPassword(normalizeRecoveryCode(recoveryCode));

    const user = await prisma.$transaction(async (tx) => {
      /**
       * The number comes from the invite when the invite reserved one, and from
       * the counter otherwise.
       *
       * A reserved number is *not* re-checked against `users`: the migration put
       * a unique index on `registration_invites.account_number`, so the same
       * number cannot sit on two codes, and the block those codes draw from was
       * placed below the counter's starting point. The unique index on
       * `users.account_number` still fails the insert if that reasoning is ever
       * wrong, which is the point of having it.
       */
      const accountNumber = invite.accountNumber ?? (await takeNextAccountNumber(tx));

      const created = await tx.user.create({
        data: {
          accountNumber,
          username: body.username,
          displayName: body.displayName,
          passwordHash,
          recoveryCodeHash,
          /**
           * ⚠️ **`false`, always — registration cannot create an administrator** (2026-10-14,
           * 1.10.22).
           *
           * This used to be `invite.grantsAdmin`, and before that
           * `invite.accountNumber !== null`. Both were the same mistake at different
           * removes: **a piece of paper decided a privilege.**
           *
           * The batch of 98 codes the owner had printed (`10000002`–`10000099`) carried
           * `grants_admin = true`, never expired, and were meant to be handed out over
           * months. Redeeming one silently produced an administrator — **without anybody
           * deciding so at the moment it happened, which is the only moment a privilege
           * should need.** An invitation says "you may have an account"; it says nothing
           * about who may administer the platform, and a code in somebody's drawer cannot
           * be asked.
           *
           * Administration is now an explicit act: an `AdminGrant` row written by
           * `tools/grant-admin.mjs`, which the admin guard requires. The reserved numbers
           * those codes hand out are unaffected — they were never the privilege.
           */
          isAdmin: false,
        },
      });

      // The account is useless without a ledger, so it is created here, inside
      // the same transaction: book, membership, preset categories and payment
      // methods all exist, or the signup does not happen at all.
      await createDefaultLedger(tx, created.id);

      /**
       * Claim the invite inside the same transaction: `usedAt: null` in the
       * filter means two simultaneous registrations cannot both consume it.
       *
       * `revokedAt: null` is checked again here, not only above, because a code
       * revoked between that check and this line must not register anybody. The
       * window is small and the guard is one extra condition.
       */
      const claimed = await tx.registrationInvite.updateMany({
        where: { id: invite.id, usedAt: null, revokedAt: null },
        data: { usedByUserId: created.id, usedAt: new Date() },
      });

      if (claimed.count !== 1) {
        throw badRequest("invite_used", "该邀请码已被使用。");
      }

      /**
       * ⚠️ **A referral code leaves two traces, and both are written here, in the same transaction.**
       *
       * `referredByUserId` on the new account is *who invited me*; the reminder is what the newcomer
       * actually sees for seven days.
       *
       * ⚠️ **Inside the transaction, because a half-recorded referral cannot be repaired**: an
       * account created without its `referredByUserId`, or with one but no invitation marked used,
       * is a state where "who invited whom" has two different answers depending on which table you
       * ask. **`教训.md` §8.7 is about exactly that.**
       *
       * ⚠️ **A plain invitation leaves neither** — `createdByUserId` is what distinguishes a referral
       * code from a batch-minted ticket, and this is where that distinction pays off.
       */
      if (invite.createdByUserId !== null) {
        const generator = await tx.user.findUnique({
          where: { id: invite.createdByUserId },
          select: { displayName: true },
        });

        if (generator) {
          await recordReferral(tx, {
            newUserId: created.id,
            generatorId: invite.createdByUserId,
            generatorDisplayName: generator.displayName,
          });
        }
      }

      return created;
    });

    await issueSession(reply, user.id, metaFrom(request));
    reply.status(201);

    return authResponseSchema.parse({ user: toSessionUser(user), recoveryCode });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/login
  // ---------------------------------------------------------------------------
  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = loginRequestSchema.parse(request.body);
    const keys = [`user:${body.username.toLowerCase()}`, `ip:${request.ip}`];

    await assertNotThrottled(request, reply, keys);

    const user = await prisma.user.findUnique({ where: { username: body.username } });
    let passwordOk = false;

    if (user) {
      passwordOk = await verifyPassword(user.passwordHash, body.password);
    } else {
      // Equalise timing so an unknown username is not measurably faster.
      await verifyPassword(await getDummyHash(), body.password);
    }

    if (!user || !passwordOk) {
      throttle.recordFailure(keys);
      throw unauthorized("invalid_credentials", "用户名或密码不正确。");
    }

    /**
     * **A suspended account cannot sign in** (S13).
     *
     * ⚠️ **The message is the one the owner specified** — *"该账户目前已停用或不存在"* — and it
     * is written to be indistinguishable from "no such account", which is what keeps the login
     * form from answering *"does this username exist, and was it banned?"*. The password is
     * verified **before** this check so a suspended account costs the same time as a real one.
     *
     * ⚠️ It counts as a failed attempt, so a suspended person guessing passwords is throttled
     * exactly like anybody else.
     */
    if (user.disabledAt !== null) {
      throttle.recordFailure(keys);
      throw unauthorized("account_disabled", "该账户目前已停用或不存在。");
    }

    throttle.recordSuccess(keys);
    await issueSession(reply, user.id, metaFrom(request));

    return authResponseSchema.parse({ user: toSessionUser(user) });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/logout
  // ---------------------------------------------------------------------------
  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];

    if (token) {
      await prisma.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
    }

    clearSessionCookie(reply);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/auth/me
  // ---------------------------------------------------------------------------
  app.get("/api/v1/auth/me", { preHandler: requireAuth }, async (request) => {
    return meResponseSchema.parse({ user: request.currentUser });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/v1/auth/me
  // ---------------------------------------------------------------------------

  /**
   * Account-level preferences.
   *
   * Only the default currency for now. It lives on the user rather than the
   * book because it describes how the owner thinks about money, not how a
   * particular ledger is kept.
   */
  app.patch("/api/v1/auth/me", { preHandler: requireAuth }, async (request) => {
    const body = updatePreferencesRequestSchema.parse(request.body);
    const userId = request.currentUser!.id;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { defaultCurrency: body.defaultCurrency },
    });

    return meResponseSchema.parse({
      user: toSessionUser(updated),
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/password
  // ---------------------------------------------------------------------------
  app.post("/api/v1/auth/password", { preHandler: requireAuth }, async (request, reply) => {
    const body = changePasswordRequestSchema.parse(request.body);
    const current = request.currentUser!;

    const user = await prisma.user.findUniqueOrThrow({ where: { id: current.id } });

    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
      throw unauthorized("invalid_password", "当前密码不正确");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.newPassword) },
    });

    // Rotate the session token: a password change invalidates anything that
    // was signed in before.
    await issueSession(reply, user.id, metaFrom(request));

    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/recover — reset a forgotten password with the recovery code
  // ---------------------------------------------------------------------------
  app.post("/api/v1/auth/recover", async (request, reply) => {
    const body = recoverRequestSchema.parse(request.body);
    const keys = [`recover:${body.username.toLowerCase()}`, `ip:${request.ip}`];

    await assertNotThrottled(request, reply, keys);

    const user = await prisma.user.findUnique({ where: { username: body.username } });
    const usable = Boolean(user?.recoveryCodeHash) && !user?.recoveryCodeUsedAt;

    let codeOk = false;
    if (user?.recoveryCodeHash && usable) {
      codeOk = await verifyPassword(user.recoveryCodeHash, normalizeRecoveryCode(body.recoveryCode));
    } else {
      await verifyPassword(await getDummyHash(), body.recoveryCode);
    }

    if (!user || !codeOk) {
      throttle.recordFailure(keys);
      throw unauthorized("invalid_recovery_code", "用户名或恢复码不正确");
    }

    throttle.recordSuccess(keys);

    // A recovery code is single use; hand out a fresh one so the account is
    // never left without a way back in.
    const newRecoveryCode = generateRecoveryCode();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(body.newPassword),
        recoveryCodeHash: await hashPassword(normalizeRecoveryCode(newRecoveryCode)),
        recoveryCodeUsedAt: null,
      },
    });

    await prisma.session.deleteMany({ where: { userId: user.id } });
    clearSessionCookie(reply);

    return recoveryCodeResponseSchema.parse({ recoveryCode: newRecoveryCode });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/recovery-code — issue a new recovery code while signed in
  // ---------------------------------------------------------------------------
  app.post("/api/v1/auth/recovery-code", { preHandler: requireAuth }, async (request) => {
    const body = regenerateRecoveryCodeRequestSchema.parse(request.body);
    const current = request.currentUser!;

    const user = await prisma.user.findUniqueOrThrow({ where: { id: current.id } });

    if (!(await verifyPassword(user.passwordHash, body.password))) {
      throw unauthorized("invalid_password", "密码不正确");
    }

    const recoveryCode = generateRecoveryCode();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        recoveryCodeHash: await hashPassword(normalizeRecoveryCode(recoveryCode)),
        recoveryCodeUsedAt: null,
      },
    });

    return recoveryCodeResponseSchema.parse({ recoveryCode });
  });
}
