/**
 * **S13 — the admin console's API.**
 *
 * The permission model itself is proven in `admin.test.ts` (32 tests over the guard). This file
 * proves the *console*: that every endpoint sits behind that guard, that the invite lifecycle is
 * safe end to end, that suspension really signs every device out, and that **no management
 * response contains ledger data**.
 *
 * ⚠️ **The last one is the point of the whole feature.** *"管理员可以管理系统，不应因此默认拥有
 * 查看所有私人账本的权限"* — so there is a test that plants a distinctive transaction and then
 * asserts its note and amount appear in **none** of the console's responses.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

type App = ReturnType<typeof makeApp>;

const PASSWORD = "correct-horse-battery";
const ADMIN_NUMBER = "10000020";

/** The endpoints that must all refuse for the same reasons. */
const GET_ENDPOINTS = [
  "/api/v1/admin/self",
  "/api/v1/admin/overview",
  "/api/v1/admin/invites",
  "/api/v1/admin/admins",
  "/api/v1/admin/users?q=10000000",
  "/api/v1/admin/audit",
] as const;

const POST_ENDPOINTS = [
  { url: "/api/v1/admin/invites", payload: { shape: "ordinary" } },
  { url: "/api/v1/admin/invites/00000000-0000-4000-8000-000000000000/revoke", payload: { reason: "x", password: "y" } },
  { url: "/api/v1/admin/accounts/00000000-0000-4000-8000-000000000000/suspend", payload: { reason: "x", password: "y" } },
  { url: "/api/v1/admin/accounts/00000000-0000-4000-8000-000000000000/restore", payload: { reason: "x", password: "y" } },
] as const;

let app: App;

interface Person {
  readonly id: string;
  readonly cookie: string;
}

async function register(username: string): Promise<Person> {
  const cookie = await signUp(app, username);
  const row = await prisma.user.findUniqueOrThrow({ where: { username }, select: { id: true } });
  return { id: row.id, cookie };
}

/** Make an account a **serving administrator**: first-batch number + both independent halves. */
async function makeAdmin(username: string, accountNumber = ADMIN_NUMBER): Promise<Person> {
  const person = await register(username);

  await prisma.user.update({
    where: { id: person.id },
    data: { accountNumber, isAdmin: true },
  });
  await prisma.adminGrant.create({
    data: { userId: person.id, grantedBy: "test-suite" },
  });
  await prisma.adminAllowEntry.create({
    data: { userId: person.id, listedBy: "test-suite" },
  });

  return person;
}

function inject(method: "GET" | "POST", url: string, cookie?: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: cookie === undefined ? {} : { cookie },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

beforeEach(async () => {
  await resetDatabase();
  app = makeApp();
});

afterEach(async () => {
  await app.close();
});

describe("1. nothing is reachable without a session or without all five checks", () => {
  it("refuses every endpoint with 401 when unauthenticated", async () => {
    for (const url of GET_ENDPOINTS) {
      const response = await inject("GET", url);
      expect(response.statusCode, url).toBe(401);
    }

    for (const endpoint of POST_ENDPOINTS) {
      const response = await inject("POST", endpoint.url, undefined, endpoint.payload);
      expect(response.statusCode, endpoint.url).toBe(401);
    }
  });

  it("refuses every endpoint with 403 for an ordinary account", async () => {
    const ordinary = await register("ordinary");

    for (const url of GET_ENDPOINTS) {
      const response = await inject("GET", url, ordinary.cookie);
      expect(response.statusCode, url).toBe(403);
      expect(response.json()).toMatchObject({ code: "admin_forbidden" });
    }
  });

  it("refuses an account that has only the grant", async () => {
    const person = await register("grant_only");
    await prisma.user.update({ where: { id: person.id }, data: { accountNumber: ADMIN_NUMBER } });
    await prisma.adminGrant.create({ data: { userId: person.id, grantedBy: "test-suite" } });

    const response = await inject("GET", "/api/v1/admin/overview", person.cookie);
    expect(response.statusCode).toBe(403);
  });

  it("refuses an account that has only the allow-list entry", async () => {
    const person = await register("list_only");
    await prisma.user.update({ where: { id: person.id }, data: { accountNumber: ADMIN_NUMBER } });
    await prisma.adminAllowEntry.create({ data: { userId: person.id, listedBy: "test-suite" } });

    const response = await inject("GET", "/api/v1/admin/overview", person.cookie);
    expect(response.statusCode).toBe(403);
  });

  it("stops working the moment the grant is revoked", async () => {
    const admin = await makeAdmin("the_admin");

    expect((await inject("GET", "/api/v1/admin/self", admin.cookie)).statusCode).toBe(200);

    await prisma.adminGrant.update({
      where: { userId: admin.id },
      data: { revokedAt: new Date(), revokedBy: "test-suite" },
    });

    /**
     * ⚠️ **No cache, so the very next request fails.** A cached admin decision is an
     * administrator who cannot be fired.
     */
    expect((await inject("GET", "/api/v1/admin/self", admin.cookie)).statusCode).toBe(403);
  });
});

describe("2. inviting: create, list, revoke", () => {
  it("creates an ordinary invite, returns the plaintext once, and lists it masked", async () => {
    const admin = await makeAdmin("the_admin");

    const created = await inject("POST", "/api/v1/admin/invites", admin.cookie, {
      shape: "ordinary",
      note: "给母亲的",
    });

    expect(created.statusCode).toBe(200);
    const body = created.json() as {
      code: string;
      invite: { id: string; maskedCode: string; status: string; note: string | null };
    };

    /**
     * ⚠️ **The plaintext exists in this response and nowhere else.** The owner's rule:
     * *"邀请码创建之后不显示"*.
     */
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(body.invite.note).toBe("给母亲的");
    expect(body.invite.maskedCode).not.toContain(body.code);
    expect(body.invite.maskedCode).toMatch(/-••••-••••$/);
    expect(body.invite.status).toBe("available");

    const listed = await inject("GET", "/api/v1/admin/invites", admin.cookie);
    const listBody = listed.json() as { invites: { id: string; maskedCode: string }[] };

    /**
     * ⚠️ **The fixture accounts were themselves registered with invites**, so the list contains
     * those too. The assertion is about *ours*: it appears, masked, and the plaintext is absent.
     */
    const ours = listBody.invites.find((invite) => invite.id === body.invite.id);
    expect(ours?.maskedCode).toBe(body.invite.maskedCode);
    /** ⚠️ The list must not leak the plaintext it was created with. */
    expect(listed.body).not.toContain(body.code);
  });

  it("creates a reserved invite with a first-batch account number and no expiry", async () => {
    const admin = await makeAdmin("the_admin");

    const created = await inject("POST", "/api/v1/admin/invites", admin.cookie, {
      shape: "reserved",
    });
    expect(created.statusCode).toBe(200);

    const body = created.json() as {
      invite: { accountNumber: string | null; expiresAt: string | null };
    };

    expect(body.invite.accountNumber).toMatch(/^100000\d{2}$/);
    expect(body.invite.expiresAt).toBeNull();
  });

  it("writes an audit row for a creation and for a revocation", async () => {
    const admin = await makeAdmin("the_admin");

    const created = await inject("POST", "/api/v1/admin/invites", admin.cookie, {
      shape: "ordinary",
    });
    const inviteId = (created.json() as { invite: { id: string } }).invite.id;

    const revoked = await inject("POST", `/api/v1/admin/invites/${inviteId}/revoke`, admin.cookie, {
      reason: "发错了",
      password: PASSWORD,
    });
    expect(revoked.statusCode).toBe(200);

    const audit = await inject("GET", "/api/v1/admin/audit", admin.cookie);
    const entries = (audit.json() as { entries: { action: string; outcome: string }[] }).entries;

    expect(entries.map((entry) => `${entry.action}:${entry.outcome}`)).toEqual([
      "invite.revoke:success",
      "invite.create:success",
    ]);
  });

  it("refuses to revoke with a wrong password — and records the refusal", async () => {
    const admin = await makeAdmin("the_admin");
    const created = await inject("POST", "/api/v1/admin/invites", admin.cookie, {
      shape: "ordinary",
    });
    const inviteId = (created.json() as { invite: { id: string } }).invite.id;

    const refused = await inject("POST", `/api/v1/admin/invites/${inviteId}/revoke`, admin.cookie, {
      reason: "试试",
      password: "wrong-password",
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "reauth_failed" });

    /** The invite was not touched. */
    const row = await prisma.registrationInvite.findUniqueOrThrow({ where: { id: inviteId } });
    expect(row.revokedAt).toBeNull();

    const audit = await inject("GET", "/api/v1/admin/audit", admin.cookie);
    const entries = (
      audit.json() as { entries: { action: string; outcome: string; target: string | null }[] }
    ).entries;
    expect(entries[0]).toMatchObject({ action: "invite.revoke", outcome: "failed" });
  });

  it("makes a revoked code unusable at registration", async () => {
    const admin = await makeAdmin("the_admin");
    const created = await inject("POST", "/api/v1/admin/invites", admin.cookie, {
      shape: "ordinary",
    });
    const { code, invite } = created.json() as { code: string; invite: { id: string } };

    await inject("POST", `/api/v1/admin/invites/${invite.id}/revoke`, admin.cookie, {
      reason: "作废",
      password: PASSWORD,
    });

    const registration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        inviteCode: code,
        username: "latecomer",
        displayName: "latecomer",
        password: PASSWORD,
      },
    });

    expect(registration.statusCode).toBe(400);
    expect(registration.json()).toMatchObject({ code: "invite_revoked" });
  });

  it("refuses to revoke a redeemed code until the warning is acknowledged, and never closes the account", async () => {
    const admin = await makeAdmin("the_admin");
    const created = await inject("POST", "/api/v1/admin/invites", admin.cookie, {
      shape: "ordinary",
    });
    const { code, invite } = created.json() as { code: string; invite: { id: string } };

    const registration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        inviteCode: code,
        username: "redeemer",
        displayName: "redeemer",
        password: PASSWORD,
      },
    });
    expect(registration.statusCode).toBe(201);

    const unacknowledged = await inject(
      "POST",
      `/api/v1/admin/invites/${invite.id}/revoke`,
      admin.cookie,
      { reason: "回收", password: PASSWORD },
    );
    expect(unacknowledged.statusCode).toBe(400);
    expect(unacknowledged.json()).toMatchObject({ code: "invite_used_needs_acknowledgement" });

    const acknowledged = await inject(
      "POST",
      `/api/v1/admin/invites/${invite.id}/revoke`,
      admin.cookie,
      { reason: "回收", password: PASSWORD, acknowledgeUsed: true },
    );
    expect(acknowledged.statusCode).toBe(200);

    /**
     * ⚠️ **The owner's rule: revoking the code does not close the account.** The account is
     * still there, still able to sign in, and closing it remains a separate manual decision.
     */
    const stillThere = await prisma.user.findUnique({ where: { username: "redeemer" } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.disabledAt).toBeNull();

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "redeemer", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
  });
});

describe("3. suspending and restoring an account", () => {
  it("signs every device out and refuses the next login with the exact message", async () => {
    const admin = await makeAdmin("the_admin");
    const target = await register("troublemaker");

    /** Two devices, as the real system allows. */
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "troublemaker", password: PASSWORD },
    });
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(2);

    const suspended = await inject(
      "POST",
      `/api/v1/admin/accounts/${target.id}/suspend`,
      admin.cookie,
      { reason: "违规", password: PASSWORD },
    );

    expect(suspended.statusCode).toBe(200);
    expect(suspended.json()).toMatchObject({ username: "troublemaker", sessionsRemoved: 2 });

    /** ⚠️ "At that instant": no session survives. */
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "troublemaker", password: PASSWORD },
    });

    expect(login.statusCode).toBe(401);
    expect(login.json()).toMatchObject({
      code: "account_disabled",
      message: "该账户目前已停用或不存在。",
    });

    /** The old cookie is dead too. */
    const withOldCookie = await inject("GET", "/api/v1/auth/me", target.cookie);
    expect(withOldCookie.statusCode).toBe(401);
  });

  it("keeps the ledger data — suspension is not deletion", async () => {
    const admin = await makeAdmin("the_admin");
    const target = await register("suspended_but_intact");

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "suspended_but_intact", password: PASSWORD },
    });

    await inject("POST", `/api/v1/admin/accounts/${target.id}/suspend`, admin.cookie, {
      reason: "暂定",
      password: PASSWORD,
    });

    const membership = await prisma.bookMember.count({ where: { userId: target.id } });
    expect(membership).toBeGreaterThan(0);
  });

  it("refuses to suspend an administrator or yourself", async () => {
    const admin = await makeAdmin("the_admin");

    const self = await inject("POST", `/api/v1/admin/accounts/${admin.id}/suspend`, admin.cookie, {
      reason: "试试",
      password: PASSWORD,
    });
    expect(self.statusCode).toBe(400);
    expect(self.json()).toMatchObject({ code: "cannot_suspend_self" });

    /** A second administrator, ineligible-by-choice? No: a real serving admin is refused. */
    const other = await makeAdmin("other_admin", "10000021");
    const another = await inject(
      "POST",
      `/api/v1/admin/accounts/${other.id}/suspend`,
      admin.cookie,
      { reason: "试试", password: PASSWORD },
    );
    expect(another.statusCode).toBe(400);
    expect(another.json()).toMatchObject({ code: "account_is_admin" });
  });

  it("restores a suspended account and records both actions", async () => {
    const admin = await makeAdmin("the_admin");
    const target = await register("comeback");

    await inject("POST", `/api/v1/admin/accounts/${target.id}/suspend`, admin.cookie, {
      reason: "暂定",
      password: PASSWORD,
    });
    const restored = await inject(
      "POST",
      `/api/v1/admin/accounts/${target.id}/restore`,
      admin.cookie,
      { reason: "恢复", password: PASSWORD },
    );
    expect(restored.statusCode).toBe(200);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "comeback", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);

    const actions = (
      await prisma.adminAuditLog.findMany({ orderBy: { at: "asc" } })
    ).map((row) => row.action);
    expect(actions).toEqual(["account.suspend", "account.restore"]);
  });
});

describe("4. reading: overview, admins, users, and what is never disclosed", () => {
  it("reports counts, a null backup, and the four administrator states", async () => {
    const admin = await makeAdmin("the_admin");
    await register("ordinary");

    const overview = await inject("GET", "/api/v1/admin/overview", admin.cookie);
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      users: { total: 2, suspended: 0, demo: 0 },
      books: { total: 2 },
      admins: { active: 1, halfConfigured: 0 },
      /** ⚠️ No backup has ever been recorded, so the console says so instead of guessing. */
      lastBackup: null,
    });

    const roster = await inject("GET", "/api/v1/admin/admins", admin.cookie);
    const entries = (roster.json() as { entries: { username: string; status: string }[] }).entries;
    expect(entries.find((entry) => entry.username === "the_admin")?.status).toBe("active");
    /**
     * ⚠️ **An account outside the first-batch range with no grant is not in the picture at all** —
     * the roster lists accounts that *may* hold administration plus anybody with a record, not
     * every user. Showing all of them would be a user list, which the owner explicitly did not ask
     * for (search is exact-match only for the same reason).
     */
    expect(entries.find((entry) => entry.username === "ordinary")).toBeUndefined();
  });

  it("distinguishes a fresh success, a fresh failure and a stale record", async () => {
    const admin = await makeAdmin("the_admin");
    const HOUR = 60 * 60 * 1000;
    const now = Date.now();

    /**
     * ⚠️ **A stale "success" must not read as "the backups are fine today".** The API marks the
     * newest row stale after 36 hours; the console renders "未知（记录已过期）" instead.
     */
    const stale = await prisma.backupLog.create({
      data: { startedAt: new Date(now - 40 * HOUR), ok: true, note: "local+restore+encrypt+upload+remote-meta ok" },
    });
    let overview = await inject("GET", "/api/v1/admin/overview", admin.cookie);
    expect(overview.json()).toMatchObject({
      lastBackup: { at: stale.startedAt.toISOString(), ok: true, stale: true },
    });

    await prisma.backupLog.deleteMany();

    /** A fresh success is current. */
    const fresh = await prisma.backupLog.create({
      data: { startedAt: new Date(now - HOUR), ok: true, note: "fresh" },
    });
    overview = await inject("GET", "/api/v1/admin/overview", admin.cookie);
    expect(overview.json()).toMatchObject({
      lastBackup: { at: fresh.startedAt.toISOString(), ok: true, stale: false },
    });

    await prisma.backupLog.deleteMany();

    /** A fresh failure is a failure, and it is not stale. */
    const failed = await prisma.backupLog.create({
      data: { startedAt: new Date(now - HOUR), ok: false, note: "[upload] 上传 COS 失败" },
    });
    overview = await inject("GET", "/api/v1/admin/overview", admin.cookie);
    expect(overview.json()).toMatchObject({
      lastBackup: { at: failed.startedAt.toISOString(), ok: false, stale: false },
    });
  });

  it("shows a half-configured account as half, not as an administrator", async () => {
    const admin = await makeAdmin("the_admin");
    const half = await register("half");
    await prisma.user.update({ where: { id: half.id }, data: { accountNumber: "10000022" } });
    await prisma.adminGrant.create({ data: { userId: half.id, grantedBy: "test-suite" } });

    const roster = await inject("GET", "/api/v1/admin/admins", admin.cookie);
    const entries = (
      roster.json() as { entries: { username: string; status: string }[] }
    ).entries;

    /** ⚠️ A grant without a listing is a refusal, and the console must not call it an admin. */
    expect(entries.find((entry) => entry.username === "half")?.status).toBe("grant_only");
  });

  it("finds an account by exact number or exact username and by nothing else", async () => {
    const admin = await makeAdmin("the_admin");
    await register("zhangsan");

    const byName = await inject("GET", "/api/v1/admin/users?q=zhangsan", admin.cookie);
    const names = (byName.json() as { users: { username: string }[] }).users.map((u) => u.username);
    expect(names).toEqual(["zhangsan"]);

    const number = (
      await prisma.user.findUniqueOrThrow({ where: { username: "zhangsan" }, select: { accountNumber: true } })
    ).accountNumber;

    const byNumber = await inject("GET", `/api/v1/admin/users?q=${number}`, admin.cookie);
    expect((byNumber.json() as { users: { username: string }[] }).users.map((u) => u.username)).toEqual([
      "zhangsan",
    ]);

    /** ⚠️ A partial name must not list anybody: exact matches only. */
    const fuzzy = await inject("GET", "/api/v1/admin/users?q=zhang", admin.cookie);
    expect((fuzzy.json() as { users: unknown[] }).users).toHaveLength(0);
  });

  it("never discloses ledger content, credentials or session material", async () => {
    const admin = await makeAdmin("the_admin");
    const owner = await register("ledger_owner");

    const ledger = await app.inject({
      method: "GET",
      url: "/api/v1/ledger",
      headers: { cookie: owner.cookie },
    });
    const bookId = (ledger.json() as { book: { id: string } }).book.id;

    /** A note and an amount that would be recognisable in any leak. */
    await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: { cookie: owner.cookie, "x-libellum-book": bookId },
      payload: {
        id: "01a1b2c3-d4e5-7f60-8123-456789abcdef",
        kind: "expense",
        amountCents: 987_654,
        currency: "CNY",
        occurredAt: new Date().toISOString(),
        occurredLocalDate: "2026-10-17",
        occurredTz: "Asia/Shanghai",
        note: "绝密备注-do-not-leak",
        idempotencyKey: "01a1b2c3-d4e5-7f60-8123-456789abcdef",
      },
    });

    const responses: string[] = [];
    for (const url of GET_ENDPOINTS) {
      const response = await inject("GET", url, admin.cookie);
      expect(response.statusCode, url).toBe(200);
      responses.push(response.body);
    }

    const all = responses.join("\n");
    for (const forbidden of [
      "绝密备注-do-not-leak",
      "987654",
      "passwordHash",
      "recoveryCodeHash",
      "libellum_session",
      "tokenHash",
    ]) {
      expect(all, forbidden).not.toContain(forbidden);
    }
  });
});

