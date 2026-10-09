import type { SessionUser } from "@libellum/shared";
import type { FastifyRequest } from "fastify";

import type { PrismaClient } from "../db.js";
import { unauthorized } from "../lib/errors.js";
import { SESSION_COOKIE_NAME, hashSessionToken } from "./session.js";

/**
 * Build the guard that every authenticated route uses.
 *
 * It lives here rather than inside the auth routes because ledger routes need
 * exactly the same check — and a second, subtly different copy of an
 * authorization rule is how holes appear.
 */
export function createRequireAuth(
  prisma: PrismaClient,
): (request: FastifyRequest) => Promise<void> {
  return async function requireAuth(request: FastifyRequest): Promise<void> {
    const token = request.cookies[SESSION_COOKIE_NAME];

    if (!token) {
      throw unauthorized("not_authenticated", "请先登录。");
    }

    const session = await prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { user: true },
    });

    if (!session || session.expiresAt.getTime() <= Date.now()) {
      throw unauthorized("session_expired", "登录状态已过期，请重新登录。");
    }

    const user: SessionUser = {
      id: session.user.id,
      accountNumber: session.user.accountNumber,
      username: session.user.username,
      displayName: session.user.displayName,
      isDemo: session.user.isDemo,
      createdAt: session.user.createdAt.toISOString(),
    };

    request.currentUser = user;
  };
}
