import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { createPrismaClient } from "../src/db.js";

/**
 * Shared fixtures for the integration suites.
 *
 * They talk to a real PostgreSQL database — the only way to test idempotency,
 * unique constraints and cascades honestly. `test/setup.ts` points
 * DATABASE_URL at the test database before anything here runs.
 */
export const prisma = createPrismaClient(process.env["DATABASE_URL"] ?? "");

export function makeApp(): FastifyInstance {
  return buildApp({
    version: "0.1.0-test",
    checkDatabase: async () => true,
    prisma,
    webOrigin: "http://localhost:5173",
    cookieSecure: false,
    // High enough that unrelated tests never trip the lockout.
    loginThrottleOptions: { maxFailures: 50, lockoutMs: 1_000, windowMs: 60_000 },
  });
}

export function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") throw new Error("response did not set a cookie");
  return value.split(";")[0] ?? "";
}

/**
 * Wipe every table between test cases.
 *
 * Order matters and is not alphabetical: `transactions.category_id` is
 * ON DELETE RESTRICT, so a cascade that reaches a category still holding
 * entries would be refused. Entries go first, always.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.transactionTag.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.category.deleteMany();
  await prisma.paymentMethod.deleteMany();
  await prisma.bookMember.deleteMany();
  await prisma.book.deleteMany();
  await prisma.session.deleteMany();
  await prisma.registrationInvite.deleteMany();
  await prisma.user.deleteMany();
}

/** Register a fresh account and return its session cookie. */
export async function signUp(app: FastifyInstance, username: string): Promise<string> {
  // Registration upper-cases the code before looking it up, so store it that way.
  const code = `INVITE-${username}`.toUpperCase();
  await prisma.registrationInvite.create({ data: { code } });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      inviteCode: code,
      username,
      displayName: username,
      password: "correct-horse-battery",
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(`signup failed: ${String(response.statusCode)} ${response.body}`);
  }

  return cookieFrom(response.headers);
}

export interface LedgerMeta {
  readonly book: { id: string; name: string };
  readonly categories: {
    id: string;
    name: string;
    kind: string;
    isSystem: boolean;
    isArchived: boolean;
  }[];
  readonly paymentMethods: { id: string; name: string; isArchived: boolean }[];
  readonly tags: { id: string; name: string; color: string }[];
}

export async function ledgerOf(app: FastifyInstance, cookie: string): Promise<LedgerMeta> {
  const response = await app.inject({ method: "GET", url: "/api/v1/ledger", headers: { cookie } });
  if (response.statusCode !== 200) {
    throw new Error(`GET /ledger failed: ${String(response.statusCode)} ${response.body}`);
  }
  return response.json() as LedgerMeta;
}
