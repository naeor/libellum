import {
  authResponseSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  meResponseSchema,
  recoverRequestSchema,
  recoveryCodeResponseSchema,
  regenerateRecoveryCodeRequestSchema,
  registerRequestSchema,
  type SessionUser,
} from "@libellum/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createRequireAuth } from "../auth/guard.js";
import { LoginThrottle } from "../auth/login-throttle.js";
import { getDummyHash, hashPassword, verifyPassword } from "../auth/password.js";
import {
  generateAccountNumber,
  generateRecoveryCode,
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
  createdAt: Date;
};

function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    accountNumber: user.accountNumber,
    username: user.username,
    displayName: user.displayName,
    isDemo: user.isDemo,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Account numbers are unique, so a collision needs a retry rather than an
 * error. With 40 bits of randomness a clash is vanishingly unlikely, but
 * "unlikely" is not "impossible" and the unique index would otherwise reject
 * an otherwise valid signup.
 */
async function allocateAccountNumber(tx: {
  user: {
    findUnique(args: {
      where: { accountNumber: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateAccountNumber();
    const taken = await tx.user.findUnique({
      where: { accountNumber: candidate },
      select: { id: true },
    });

    if (!taken) return candidate;
  }

  throw new Error("could not allocate a unique account number");
}

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
   * There is exactly one session per user (`sessions.user_id` is unique), so
   * signing in replaces whatever session existed before. That is the mechanism
   * behind the "one device at a time" rule.
   */
  async function issueSession(reply: FastifyReply, userId: string, meta: RequestMeta): Promise<void> {
    const token = generateSessionToken();
    const expiresAt = sessionExpiryFrom(new Date());

    await prisma.session.upsert({
      where: { userId },
      create: {
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt,
        userAgent: meta.userAgent ?? null,
        ipAddress: meta.ipAddress ?? null,
      },
      update: {
        tokenHash: hashSessionToken(token),
        expiresAt,
        userAgent: meta.userAgent ?? null,
        ipAddress: meta.ipAddress ?? null,
        lastSeenAt: new Date(),
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
    if (invite.usedAt) throw badRequest("invite_used", "该邀请码已被使用。");
    if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
      throw badRequest("invite_expired", "该邀请码已过期。");
    }

    const taken = await prisma.user.findUnique({ where: { username: body.username } });
    if (taken) throw conflict("username_taken", "该用户名已被占用。");

    const passwordHash = await hashPassword(body.password);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await hashPassword(normalizeRecoveryCode(recoveryCode));

    const user = await prisma.$transaction(async (tx) => {
      const accountNumber = await allocateAccountNumber(tx);

      const created = await tx.user.create({
        data: {
          accountNumber,
          username: body.username,
          displayName: body.displayName,
          passwordHash,
          recoveryCodeHash,
        },
      });

      // The account is useless without a ledger, so it is created here, inside
      // the same transaction: book, membership, preset categories and payment
      // methods all exist, or the signup does not happen at all.
      await createDefaultLedger(tx, created.id);

      // Claim the invite inside the same transaction: `usedAt: null` in the
      // filter means two simultaneous registrations cannot both consume it.
      const claimed = await tx.registrationInvite.updateMany({
        where: { id: invite.id, usedAt: null },
        data: { usedByUserId: created.id, usedAt: new Date() },
      });

      if (claimed.count !== 1) {
        throw badRequest("invite_used", "该邀请码已被使用。");
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
