import type { PrismaClient } from "../db.js";
import { verifyPassword } from "../auth/password.js";
import { LoginThrottle } from "../auth/login-throttle.js";
import { forbidden, tooManyRequests } from "../lib/errors.js";

/**
 * **The second factor for sensitive management actions.**
 *
 * The owner's requirement (2026-10-17): *"敏感操作需要二次验证"*.
 *
 * ⚠️ **The password is asked for in the request body, not remembered as a token.** A step-up
 * token would be a second, weaker session: it has to be issued, stored, expired and revoked, and
 * every one of those is a chance to get it wrong. Re-checking the actual password against the
 * actual hash is smaller, has no state to leak, and cannot outlive the operation it authorised.
 *
 * ⚠️ **It is verified server-side, always.** A dialog in the browser protects nothing — the rule
 * has to hold for a request that never rendered the dialog.
 *
 * ⚠️ **Failures are throttled**, on top of the global rate limit: an administrator session that
 * has been stolen must not also become an offline-feeling password oracle.
 */
const REAUTH_THROTTLE = {
  maxFailures: 3,
  lockoutMs: 5 * 60_000,
  windowMs: 15 * 60_000,
} as const;

export interface ReauthVerifier {
  /** Throws unless `password` is the administrator's current password. */
  verify(userId: string, password: string): Promise<void>;
}

/**
 * Build the verifier.
 *
 * ⚠️ **One instance per app**, because the throttle is in-memory state that must be shared
 * across requests (a per-request instance would reset on every attempt and throttle nothing).
 */
export function createReauthVerifier(
  prisma: PrismaClient,
  throttle: LoginThrottle = new LoginThrottle(REAUTH_THROTTLE),
): ReauthVerifier {
  return {
    async verify(userId: string, password: string): Promise<void> {
      const keys = [`admin:${userId}`];

      const retryAfter = throttle.retryAfterSeconds(keys);
      if (retryAfter > 0) {
        throw tooManyRequests(
          "reauth_throttled",
          `密码尝试次数过多，请 ${String(retryAfter)} 秒后再试。`,
        );
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true },
      });

      /**
       * ⚠️ **A missing row is a refusal, not a 500.** The guard already proved the session is
       * real, so this can only happen if the account vanished mid-request — and the honest answer
       * to "re-enter your password" is still "no".
       */
      if (user === null) {
        throw forbidden("reauth_failed", "密码不正确，操作没有执行。");
      }

      if (!(await verifyPassword(user.passwordHash, password))) {
        throttle.recordFailure(keys);
        throw forbidden("reauth_failed", "密码不正确，操作没有执行。");
      }

      throttle.recordSuccess(keys);
    },
  };
}
