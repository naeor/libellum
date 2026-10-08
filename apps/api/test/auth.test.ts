import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createPrismaClient } from "../src/db.js";

const prisma = createPrismaClient(process.env["DATABASE_URL"] ?? "");

const INVITE_CODE = "TESTINVITE01";
const USERNAME = "mama";
const PASSWORD = "correct-horse-battery";

const REGISTER_BODY = {
  inviteCode: INVITE_CODE,
  username: USERNAME,
  displayName: "妈妈",
  password: PASSWORD,
};

function makeApp(): FastifyInstance {
  return buildApp({
    version: "0.1.0-test",
    checkDatabase: async () => true,
    prisma,
    webOrigin: "http://localhost:5173",
    cookieSecure: false,
    // Small numbers so the lockout behaviour can be tested quickly.
    loginThrottleOptions: { maxFailures: 3, lockoutMs: 60_000, windowMs: 60_000 },
  });
}

function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== "string") {
    throw new Error("response did not set a cookie");
  }

  return value.split(";")[0] ?? "";
}

async function resetDatabase(): Promise<void> {
  await prisma.session.deleteMany();
  await prisma.registrationInvite.deleteMany();
  await prisma.user.deleteMany();
}

async function seedInvite(code: string = INVITE_CODE): Promise<void> {
  await prisma.registrationInvite.create({ data: { code } });
}

async function register(app: FastifyInstance, body = REGISTER_BODY) {
  return app.inject({ method: "POST", url: "/api/v1/auth/register", payload: body });
}

async function login(app: FastifyInstance, password = PASSWORD, username = USERNAME) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app = makeApp();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/v1/auth/register", () => {
  it("rejects an unknown invite code", async () => {
    const response = await register(app, { ...REGISTER_BODY, inviteCode: "NOPE-NOPE" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invite_invalid" });
  });

  it("creates the account, signs the user in and returns a recovery code once", async () => {
    await seedInvite();

    const response = await register(app);
    const body = response.json() as { user: { username: string }; recoveryCode: string };

    expect(response.statusCode).toBe(201);
    expect(body.user.username).toBe(USERNAME);
    expect(body.recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(cookieFrom(response.headers)).toContain("libellum_session=");

    // The plaintext code is never stored — only its hash.
    const stored = await prisma.user.findUniqueOrThrow({ where: { username: USERNAME } });
    expect(stored.recoveryCodeHash).not.toBeNull();
    expect(stored.recoveryCodeHash).not.toContain(body.recoveryCode);
  });

  it("refuses to reuse an invite code", async () => {
    await seedInvite();
    await register(app);

    const second = await register(app, { ...REGISTER_BODY, username: "baba" });

    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ code: "invite_used" });
  });

  it("refuses a username that is already taken", async () => {
    await seedInvite();
    await register(app);
    await seedInvite("TESTINVITE03");

    const second = await register(app, { ...REGISTER_BODY, inviteCode: "TESTINVITE03" });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "username_taken" });
  });

  it("refuses a password that is too short", async () => {
    await seedInvite();

    const response = await register(app, { ...REGISTER_BODY, password: "short" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_failed" });
  });
});

describe("POST /api/v1/auth/login", () => {
  it("signs an existing user in and lets them read their own session", async () => {
    await seedInvite();
    await register(app);

    const response = await login(app);
    expect(response.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: cookieFrom(response.headers) },
    });

    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { username: string } }).user.username).toBe(USERNAME);
  });

  it("answers the same way for an unknown user and a wrong password", async () => {
    await seedInvite();
    await register(app);

    const wrongPassword = await login(app, "definitely-wrong");
    const unknownUser = await login(app, "definitely-wrong", "nobody");

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json()).toMatchObject({ code: "invalid_credentials" });
    expect(unknownUser.json()).toMatchObject({ code: "invalid_credentials" });
  });

  it("locks the account out after repeated failures", async () => {
    await seedInvite();
    await register(app);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await login(app, "definitely-wrong");
    }

    const locked = await login(app, "definitely-wrong");

    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ code: "too_many_attempts" });
    expect(locked.headers["retry-after"]).toBeDefined();

    // The correct password is refused too — that is the point of a lockout.
    const blocked = await login(app);
    expect(blocked.statusCode).toBe(429);
  });

  it("keeps only one session per account", async () => {
    await seedInvite();
    const registered = await register(app);
    const firstCookie = cookieFrom(registered.headers);

    const second = await login(app);
    const secondCookie = cookieFrom(second.headers);

    expect(secondCookie).not.toBe(firstCookie);

    const withOldCookie = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: firstCookie },
    });

    expect(withOldCookie.statusCode).toBe(401);
    expect(withOldCookie.json()).toMatchObject({ code: "session_expired" });
  });
});

describe("GET /api/v1/auth/me", () => {
  it("rejects a request without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/me" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "not_authenticated" });
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("destroys the session", async () => {
    await seedInvite();
    const registered = await register(app);
    const cookie = cookieFrom(registered.headers);

    const loggedOut = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie },
    });
    expect(loggedOut.statusCode).toBe(200);

    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});

describe("POST /api/v1/auth/password", () => {
  it("changes the password and invalidates the old one", async () => {
    await seedInvite();
    const registered = await register(app);
    const cookie = cookieFrom(registered.headers);

    const wrongCurrent = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: { cookie },
      payload: { currentPassword: "nope", newPassword: "brand-new-password" },
    });
    expect(wrongCurrent.statusCode).toBe(401);

    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: "brand-new-password" },
    });
    expect(changed.statusCode).toBe(200);

    expect((await login(app, PASSWORD)).statusCode).toBe(401);
    expect((await login(app, "brand-new-password")).statusCode).toBe(200);
  });
});

describe("POST /api/v1/auth/recover", () => {
  it("resets the password with the recovery code and hands out a fresh one", async () => {
    await seedInvite();
    const registered = await register(app);
    const recoveryCode = (registered.json() as { recoveryCode: string }).recoveryCode;

    const recovered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recover",
      payload: { username: USERNAME, recoveryCode, newPassword: "recovered-password" },
    });

    expect(recovered.statusCode).toBe(200);
    const newCode = (recovered.json() as { recoveryCode: string }).recoveryCode;
    expect(newCode).not.toBe(recoveryCode);

    expect((await login(app, "recovered-password")).statusCode).toBe(200);
    expect((await login(app, PASSWORD)).statusCode).toBe(401);
  });

  it("rejects a recovery code that was already used", async () => {
    await seedInvite();
    const registered = await register(app);
    const recoveryCode = (registered.json() as { recoveryCode: string }).recoveryCode;

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/recover",
      payload: { username: USERNAME, recoveryCode, newPassword: "recovered-password" },
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recover",
      payload: { username: USERNAME, recoveryCode, newPassword: "another-password" },
    });

    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: "invalid_recovery_code" });
  });

  it("rejects an obviously wrong recovery code", async () => {
    await seedInvite();
    await register(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recover",
      payload: {
        username: USERNAME,
        recoveryCode: "ZZZZ-ZZZZ-ZZZZ-ZZZZ",
        newPassword: "recovered-password",
      },
    });

    expect(response.statusCode).toBe(401);
  });
});
