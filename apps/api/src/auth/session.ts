import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "libellum_session";

/** 30 days. Long enough that a family member is not asked to log in weekly. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The raw token goes into the cookie; only its SHA-256 hash is stored.
 *
 * A fast hash is the right choice here (unlike for passwords): the token is
 * 256 bits of randomness, so there is nothing to brute-force, and this runs on
 * every authenticated request.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}
