/**
 * **The administrator mechanism: who is one, and how the server knows.**
 *
 * Thirteen of these tests are the acceptance list from the owner's brief, in its order; the
 * rest fill gaps the list implies. They are grouped by *which check is being exercised*
 * rather than by what the assertion looks like, because the interesting property is not
 * "the response was 403" — it is **"the response was 403 for the reason I intended"**.
 *
 * ⚠️ **The guard is tested as a function as well as through a route.** Both are necessary
 * and neither is sufficient:
 *
 *  * **through the route** — proves the wiring: a real cookie, a real session, a real 401
 *    versus 403, and that the refusal body says nothing useful to an attacker;
 *  * **as a function** — proves the *reason*. Several of these cases are indistinguishable
 *    from the outside by design (`not_allowlisted` and `no_grant` produce the same
 *    response, deliberately). Without calling `decideAdmin` directly, a test could not tell
 *    "the allow list refused" from "the allow list was never consulted", and the brief
 *    explicitly forbids shipping a guard where the second check is decorative.
 *
 * ⚠️ **No test touches real data.** Everything runs against the test database
 * (`test/setup.ts` points `DATABASE_URL` at it and `resetDatabase` refuses to run against
 * anything else), and every account here is made by the suite.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decideAdmin, hasActiveAdminGrant, isOnAdminAllowList } from "../src/admin/guard.js";
import {
  FIRST_BATCH_ACCOUNT_FIRST,
  FIRST_BATCH_ACCOUNT_LAST,
  isFirstBatchAccountNumber,
} from "../src/admin/rules.js";
import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

type App = ReturnType<typeof makeApp>;

/** The app every test in this file talks to, with the test-only admin route switched on. */
function appWithAdminRoute(): App {
  /**
     * ⚠️ **No special option any more (S13).** The console''s real `GET /admin/self` is
     * registered unconditionally, so the guard is exercised through the same route production
     * serves — the old test-only route existed only because there was no admin API at all.
     */
    return makeApp();
}

/**
 * Session cookies, by username.
 *
 * ⚠️ **The internal UUID is never taken from the API.** `/auth/me` deliberately does not
 * return `users.id` — the brief requires internal UUIDs stay server-side, and the identity a
 * person is given is their eight-digit account number. The first version of this suite
 * assumed `/auth/me` returned the id and failed loudly, which is the right behaviour from an
 * API that keeps internal identifiers to itself; the fixtures below look the row up in the
 * database instead, which is also what `tools/grant-admin.mjs` expects an operator to do.
 */
const sessions = new Map<string, { id: string; cookie: string }>();

let app: App;

async function register(username: string): Promise<string> {
  const cookie = await signUp(app, username);
  const row = await prisma.user.findUniqueOrThrow({
    where: { username },
    select: { id: true },
  });
  sessions.set(username, { id: row.id, cookie });
  return cookie;
}

function cookieOf(username: string): string {
  const session = sessions.get(username);
  if (session === undefined) throw new Error(`${username} has not registered in this test`);
  return session.cookie;
}

function idOf(username: string): string {
  const session = sessions.get(username);
  if (session === undefined) throw new Error(`${username} has not registered in this test`);
  return session.id;
}

/**
 * Move an account into (or out of) the first-batch range.
 *
 * ⚠️ **Written directly rather than by registering a hundred accounts.** The range is a
 * property of the number, and the test that matters is "does the guard honour the range" —
 * not "can the suite count to a hundred". The numbers used are ones the counters will never
 * hand out during a run, so a later signup cannot collide with them.
 */
async function setAccountNumber(userId: string, accountNumber: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { accountNumber } });
}

/** Give an account a live admin grant, as `pnpm admin:grant` would — and nothing else. */
async function grant(userId: string, grantedBy = "test-suite"): Promise<void> {
  await prisma.adminGrant.upsert({
    where: { userId },
    create: { userId, grantedBy },
    update: { grantedAt: new Date(), grantedBy, revokedAt: null, revokedBy: null },
  });
  await prisma.user.update({ where: { id: userId }, data: { isAdmin: true } });
}

/** Revoke it, as `pnpm admin:revoke` would. */
async function revoke(userId: string, revokedBy = "test-suite"): Promise<void> {
  await prisma.adminGrant.update({
    where: { userId },
    data: { revokedAt: new Date(), revokedBy },
  });
  await prisma.user.update({ where: { id: userId }, data: { isAdmin: false } });
}

/**
 * Put an account on the allow list, as `pnpm admin:allow` would — **and nothing else**.
 *
 * ⚠️ **Deliberately separate from `grant` above, and the separation is the subject of this
 * whole file.** Before 1.10.23 the second check was derived from `admin_grants`, so "grant"
 * silently meant both; the helpers here are two functions because the production commands are
 * two commands. A test that called one helper expecting both halves to be satisfied would be
 * reproducing the bug rather than checking for it.
 */
async function allow(userId: string, listedBy = "test-suite"): Promise<void> {
  await prisma.adminAllowEntry.upsert({
    where: { userId },
    create: { userId, listedBy },
    update: { listedAt: new Date(), listedBy, revokedAt: null, revokedBy: null },
  });
}

/** Take it off the list, as `pnpm admin:disallow` would — leaving the grant untouched. */
async function disallow(userId: string, revokedBy = "test-suite"): Promise<void> {
  await prisma.adminAllowEntry.update({
    where: { userId },
    data: { revokedAt: new Date(), revokedBy },
  });
}

/** Both halves at once: what a real administrator has. */
async function makeAdministrator(userId: string): Promise<void> {
  await grant(userId);
  await allow(userId);
}

/** Call the test-only admin route with a session. */
async function callAdminSelf(username: string, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: "GET",
    url: "/api/v1/admin/self",
    headers: { cookie: cookieOf(username), ...extraHeaders },
  });
}

/**
 * The two kill switches the guard exposes, saved and restored around each test.
 *
 * ⚠️ **`ADMIN_ALLOWLIST_SCOPE` used to be here and is gone** (1.10.23): it was the lever for
 * narrowing the *derived* list, and there is no longer a derived list to narrow. Removing an
 * entry and revoking a grant are now the two real levers, and both are covered below.
 */
const ENV_KEYS = ["ADMIN_GRANT_CHECK_DISABLED", "ADMIN_ALLOWLIST_CHECK_DISABLED"] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  sessions.clear();
  await resetDatabase();
  app = appWithAdminRoute();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("first-batch qualification", () => {
  /**
   * The rule is a *range of account numbers*, and these are the boundaries. Both ends are
   * included and both neighbours are not — an off-by-one here would either admit account
   * 101 or exclude the owner.
   */
  it("qualifies exactly the first hundred account numbers", () => {
    expect(isFirstBatchAccountNumber(FIRST_BATCH_ACCOUNT_FIRST)).toBe(true);
    expect(isFirstBatchAccountNumber(FIRST_BATCH_ACCOUNT_LAST)).toBe(true);
    expect(isFirstBatchAccountNumber("10000001")).toBe(true);
    expect(isFirstBatchAccountNumber("10000050")).toBe(true);

    // Just outside, on both sides.
    expect(isFirstBatchAccountNumber("10000100")).toBe(false);
    expect(isFirstBatchAccountNumber("10000101")).toBe(false);
    expect(isFirstBatchAccountNumber("09999999")).toBe(false);
  });

  /**
   * ⚠️ **A malformed value is ineligible rather than an exception.** This function is a
   * gate, and a gate facing something it does not understand must say no — an exception
   * would turn a data problem into a 500, and a 500 on a privilege check is a denial of
   * service with extra steps.
   */
  it("treats anything that is not eight digits as ineligible", () => {
    for (const value of ["", "1000000", "100000000", "1000000a", " 10000000", "-1000000"]) {
      expect(isFirstBatchAccountNumber(value), value).toBe(false);
    }
  });

  /**
   * ⚠️ **Qualification is not a grant.** This is the owner's rule stated as an assertion:
   * *"第 1 个账号：有资格，但不自动成为管理员"*. An account sitting inside the range with no
   * grant row must be refused, and refused for the *grant* reason — not because it failed to
   * qualify.
   */
  it("does not make an eligible account an administrator", async () => {
    await register("eligible");
    await setAccountNumber(idOf("eligible"), "10000042");

    const decision = await decideAdmin(prisma, idOf("eligible"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("no_grant");
  });
});

describe("1–2. unauthenticated and ordinary callers are refused", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/self" });

    /**
     * 401 rather than 403: "who are you" and "not you" are different answers, and collapsing
     * them makes a login bug look like a permission bug.
     */
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "not_authenticated" });
  });

  it("refuses an ordinary signed-in account with 403", async () => {
    await register("ordinary");

    const response = await callAdminSelf("ordinary");

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "admin_forbidden" });
  });

  /**
   * ⚠️ **The refusal must not say which check failed.** *"no grant"* and *"not on the list"*
   * are different facts, and telling a caller which one they hit answers *"am I close?"* —
   * the question an attacker is actually asking.
   */
  it("does not reveal which check refused the request", async () => {
    await register("nosy");
    await setAccountNumber(idOf("nosy"), "10000020");

    const response = await callAdminSelf("nosy");
    const body = response.body;

    expect(response.statusCode).toBe(403);
    for (const leak of ["grant", "allowlist", "first_batch", "allow_list", "uuid"]) {
      expect(body.toLowerCase()).not.toContain(leak);
    }
  });
});

describe("3–4. the two checks are independently enforced", () => {
  /**
   * ⚠️ **Case 3: holds the grant, is not on the allow list.**
   *
   * ⚠️ **This is the test that the 1.10.23 change exists for.** Before it, the allow-list half
   * was *derived* from `admin_grants` — "granted **and** first-batch" — so an account like
   * this one satisfied both halves and would have been admitted. The owner found it:
   *
   * > *"如果未来误将另一个合格账号加入 admin_grants，在默认的 first-batch 范围下，
   * > 它可能同时通过所谓的两重检查。"*
   *
   * The account here is **fully eligible** and **has a live grant**, and that is deliberate:
   * every other reason to refuse has been removed so that the only thing left is the missing
   * list entry.
   */
  it("refuses an eligible account that holds a grant but is not on the allow list", async () => {
    await register("grantonly");
    await setAccountNumber(idOf("grantonly"), "10000007"); // inside the range
    await grant(idOf("grantonly"));
    // Deliberately no `allow(...)` call.

    // The grant half alone says yes…
    expect(await hasActiveAdminGrant(prisma, idOf("grantonly"))).toBe(true);
    // …and the allow-list half says no, because it reads a different table.
    expect(await isOnAdminAllowList(prisma, idOf("grantonly"))).toBe(false);

    const decision = await decideAdmin(prisma, idOf("grantonly"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not_allowlisted");

    expect((await callAdminSelf("grantonly")).statusCode).toBe(403);
  });

  /**
   * ⚠️ **Case 4: on the allow list, holds no grant.**
   *
   * The mirror image. Inside the range, listed, and with no `admin_grants` row — refused for
   * the grant reason. Together with case 3 this pins the two halves as *separately
   * sufficient to refuse*, which is what "independent" has to mean in practice.
   */
  it("refuses an eligible account that is on the allow list but holds no grant", async () => {
    await register("allowonly");
    await setAccountNumber(idOf("allowonly"), "10000007");
    await allow(idOf("allowonly"));
    // Deliberately no `grant(...)` call.

    expect(await hasActiveAdminGrant(prisma, idOf("allowonly"))).toBe(false);
    expect(await isOnAdminAllowList(prisma, idOf("allowonly"))).toBe(true);

    const decision = await decideAdmin(prisma, idOf("allowonly"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("no_grant");

    expect((await callAdminSelf("allowonly")).statusCode).toBe(403);
  });

  /**
   * ⚠️⚠️ **The regression test the owner asked for by name.** *"管理员授权意外增加第二个
   * 合格账号，而名单不变时，第二个账号仍然被拒绝。"*
   *
   * Two eligible accounts. The first is a real administrator. The second — **by mistake, or
   * by a mis-typed UUID** — gets a live `admin_grants` row. **The allow list is not touched.**
   *
   * Under the old derived design this account would have passed: it was granted, and it was
   * first-batch, which was the whole of the second check. Under the two-table design it is
   * refused, and **only** this test distinguishes the two designs once every other test in
   * the file is passing. That is precisely why it exists.
   */
  it("still refuses a second eligible account granted by mistake, while the list is unchanged", async () => {
    await register("theOnlyAdmin");
    await setAccountNumber(idOf("theOnlyAdmin"), "10000020");
    await makeAdministrator(idOf("theOnlyAdmin"));

    await register("grantedByMistake");
    await setAccountNumber(idOf("grantedByMistake"), "10000021");
    await grant(idOf("grantedByMistake")); // the mis-typed command
    // The list is deliberately left exactly as it was.

    // It is a genuinely eligible account with a genuinely live grant.
    expect(await hasActiveAdminGrant(prisma, idOf("grantedByMistake"))).toBe(true);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: idOf("grantedByMistake") },
      select: { accountNumber: true },
    });
    expect(isFirstBatchAccountNumber(row.accountNumber)).toBe(true);

    // And it still cannot administer.
    expect(await isOnAdminAllowList(prisma, idOf("grantedByMistake"))).toBe(false);
    const decision = await decideAdmin(prisma, idOf("grantedByMistake"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not_allowlisted");
    expect((await callAdminSelf("grantedByMistake")).statusCode).toBe(403);

    // The real administrator is unaffected — a fix that refused everybody would also pass
    // the assertion above.
    expect((await callAdminSelf("theOnlyAdmin")).statusCode).toBe(200);
  });

  /**
   * ⚠️ **The test that keeps the two checks from collapsing into one.**
   *
   * A guard written as `isAdmin && isAdmin` passes every functional case above. This one
   * fails it: each half is switched off in turn, and **either switch alone must deny**. A
   * missing check is not a passed check, and this is where that sentence becomes something
   * the build enforces instead of something a comment claims.
   */
  it("denies when either half of the check is disabled", async () => {
    await register("bothhalves");
    await setAccountNumber(idOf("bothhalves"), "10000008");
    await makeAdministrator(idOf("bothhalves"));

    // Both on: allowed. Establishes the baseline the two negative cases depart from.
    expect((await decideAdmin(prisma, idOf("bothhalves"))).ok).toBe(true);
    expect((await callAdminSelf("bothhalves")).statusCode).toBe(200);

    process.env["ADMIN_GRANT_CHECK_DISABLED"] = "1";
    const noGrantHalf = await decideAdmin(prisma, idOf("bothhalves"));
    expect(noGrantHalf.ok).toBe(false);
    expect((await callAdminSelf("bothhalves")).statusCode).toBe(403);
    delete process.env["ADMIN_GRANT_CHECK_DISABLED"];

    process.env["ADMIN_ALLOWLIST_CHECK_DISABLED"] = "1";
    const noListHalf = await decideAdmin(prisma, idOf("bothhalves"));
    expect(noListHalf.ok).toBe(false);
    if (!noListHalf.ok) expect(noListHalf.reason).toBe("not_allowlisted");
    expect((await callAdminSelf("bothhalves")).statusCode).toBe(403);
    delete process.env["ADMIN_ALLOWLIST_CHECK_DISABLED"];

    // Restored: allowed again. Without this the test could pass on a guard that broke
    // permanently the first time a switch was touched.
    expect((await callAdminSelf("bothhalves")).statusCode).toBe(200);
  });

  /**
   * ⚠️ **An empty allow list denies everybody, and an empty list is the default state.**
   *
   * This replaces a test that used to exercise `ADMIN_ALLOWLIST_SCOPE`, an environment
   * variable from the derived design. That variable is gone (1.10.23) — the list is a table
   * now — and what took its place is a more important assertion: **a deployment where nobody
   * has been listed yet must refuse every admin request**, rather than treating an empty list
   * as "no restriction". The second check disappearing exactly when the system is least
   * understood is the failure this pins.
   */
  it("denies everybody while the allow list is empty", async () => {
    await register("unlisted");
    await setAccountNumber(idOf("unlisted"), "10000009");
    await grant(idOf("unlisted"));

    // Nothing has listed this account, so it is not on the list…
    expect(await isOnAdminAllowList(prisma, idOf("unlisted"))).toBe(false);
    // …and a grant alone is not enough.
    expect((await decideAdmin(prisma, idOf("unlisted"))).ok).toBe(false);
    expect((await callAdminSelf("unlisted")).statusCode).toBe(403);

    // Adding the listing — and nothing else — is what makes it work.
    await allow(idOf("unlisted"));
    expect((await callAdminSelf("unlisted")).statusCode).toBe(200);
  });
});

describe("5. ineligible accounts cannot be authorized", () => {
  /**
   * ⚠️ **The guard refuses on qualification regardless of what either table says.** A grant
   * or a listing for an account outside the range is a state that should not exist — both
   * scripts refuse to create one — but the guard must not depend on a script having been
   * correct. This writes the rows by hand and checks the guard still says no.
   *
   * ⚠️ **The reason is `not_first_batch`, and getting that right took a deliberate ordering
   * decision in `decideAdmin`** (see the note there). If the allow-list check ran first, this
   * account would still be refused — but for the wrong reason, and a later reader could
   * reasonably conclude the qualification rule was unreachable and delete it.
   */
  it("refuses an account whose number is outside the first hundred, even with both records", async () => {
    await register("outsider");

    // The direct counter starts at 10000101, so this is what an ordinary signup gets.
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: idOf("outsider") },
      select: { accountNumber: true },
    });
    expect(isFirstBatchAccountNumber(row.accountNumber)).toBe(false);

    // Both records, written by hand — the state the scripts would refuse to create.
    await makeAdministrator(idOf("outsider"));

    // Both halves are genuinely live: the refusal is about eligibility, not about either of
    // them.
    expect(await hasActiveAdminGrant(prisma, idOf("outsider"))).toBe(true);
    expect(await isOnAdminAllowList(prisma, idOf("outsider"))).toBe(true);

    const decision = await decideAdmin(prisma, idOf("outsider"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not_first_batch");

    expect((await callAdminSelf("outsider")).statusCode).toBe(403);
  });

  /**
   * ⚠️ **A demo account can never administer, whatever its number.** The credential is
   * public by design, so treating one as an administrator would publish the privilege.
   */
  it("refuses a demo account even when it is eligible and granted", async () => {
    await register("demoadmin");
    await setAccountNumber(idOf("demoadmin"), "10000010");
    await makeAdministrator(idOf("demoadmin"));
    await prisma.user.update({ where: { id: idOf("demoadmin") }, data: { isDemo: true } });

    const decision = await decideAdmin(prisma, idOf("demoadmin"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("account_unavailable");
  });
});

describe("6. the correctly authorized account passes", () => {
  it("admits an eligible account that holds a live grant", async () => {
    await register("theadministrator");
    await setAccountNumber(idOf("theadministrator"), FIRST_BATCH_ACCOUNT_FIRST);
    await makeAdministrator(idOf("theadministrator"));

    const decision = await decideAdmin(prisma, idOf("theadministrator"));
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.actor.userId).toBe(idOf("theadministrator"));
      expect(decision.actor.accountNumber).toBe(FIRST_BATCH_ACCOUNT_FIRST);
    }

    const response = await callAdminSelf("theadministrator");
    expect(response.statusCode, response.body).toBe(200);
    /**
       * ⚠️ **The body changed in S13** — this is now the console's real endpoint, so it answers
       * `{ isAdmin: true, username, accountNumber }` rather than the old test route's
       * `{ ok: true, ... }`.
       */
      expect(response.json()).toMatchObject({
        isAdmin: true,
        accountNumber: FIRST_BATCH_ACCOUNT_FIRST,
      });
  });
});

describe("7. forged identity claims are ignored", () => {
  /**
   * ⚠️ **Identity comes from the session and from nowhere else.**
   *
   * Every one of these headers is a way a client could try to name itself: the brief lists
   * the flag, the role, the username, the public number and a custom admin header. All of
   * them must be inert — the guard never reads a header, and this test is what would catch a
   * future "small optimisation" that did.
   */
  it("ignores headers claiming administrator identity", async () => {
    await register("forger");
    await setAccountNumber(idOf("forger"), "10000011");
    // Note: deliberately *not* granted. Only the headers claim otherwise.

    const response = await callAdminSelf("forger", {
      "x-admin": "true",
      "x-libellum-admin": "true",
      "x-user-id": idOf("forger"),
      "x-account-number": "10000000",
      "x-username": "naeor",
    });

    expect(response.statusCode).toBe(403);
  });

  it("ignores an administrator flag or id supplied in the body or query", async () => {
    await register("forger2");
    await setAccountNumber(idOf("forger2"), "10000012");

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/admin/self?isAdmin=true&userId=${idOf("forger2")}&role=admin`,
      headers: { cookie: cookieOf("forger2") },
      payload: { isAdmin: true, role: "admin", userId: idOf("forger2") },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("8. client-side state cannot create server permission", () => {
  /**
   * ⚠️ **There is no client-side administrator state to forge, and this asserts it.**
   *
   * The web app never receives an `isAdmin` field — `SessionUser` has no such member, and
   * `/auth/me` does not return one. The brief's case 8 is therefore satisfied by the shape of
   * the API rather than by a check, which is the stronger version: there is nothing to
   * tamper with.
   */
  it("never tells the client whether the caller is an administrator", async () => {
    await register("clientstate");
    await setAccountNumber(idOf("clientstate"), "10000030");
    await makeAdministrator(idOf("clientstate"));

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: cookieOf("clientstate") },
    });

    expect(me.statusCode).toBe(200);
    for (const leak of ["isAdmin", "is_admin", "adminGrant", "admin"]) {
      expect(me.body, `me leaked "${leak}"`).not.toContain(leak);
    }
  });
});

describe("9–10. revocation takes effect on the next request", () => {
  /**
   * ⚠️ **Case 9: revoking the authorization, with the session left alone.**
   *
   * The same cookie that worked a moment ago must stop working. If somebody ever adds a
   * cache to the guard for performance, this is the test that fails — which is exactly why it
   * exists, and why it does *not* sign in again in between.
   */
  it("stops an existing session as soon as the grant is revoked", async () => {
    await register("revokedgrant");
    await setAccountNumber(idOf("revokedgrant"), "10000013");
    await makeAdministrator(idOf("revokedgrant"));

    expect((await callAdminSelf("revokedgrant")).statusCode).toBe(200);

    await revoke(idOf("revokedgrant"));

    expect((await callAdminSelf("revokedgrant")).statusCode).toBe(403);

    // And the session itself is still valid — this was a privilege revocation, not a logout.
    const stillSignedIn = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: cookieOf("revokedgrant") },
    });
    expect(stillSignedIn.statusCode).toBe(200);
  });

  /**
   * ⚠️ **Case 10: the allow list, taken away separately from the grant.** The grant row is
   * left untouched and live; only the account's position on the list changes. Refused — which
   * is the whole reason the two checks are two checks.
   */
  it("stops an existing session the moment the account is taken off the allow list", async () => {
    await register("revokedlist");
    await setAccountNumber(idOf("revokedlist"), "10000014");
    await makeAdministrator(idOf("revokedlist"));

    expect((await callAdminSelf("revokedlist")).statusCode).toBe(200);

    /**
     * ⚠️ **`disallow` — the real operation — and *not* "move the account out of the range".**
     *
     * An earlier version of this test moved the account number outside `10000000`–`10000099`,
     * which did make the old derived check return false. With the two-table design that would
     * ALSO fail the qualification gate, so the test would pass while proving nothing about the
     * list. Taking the listing away is the operation an incident responder actually performs,
     * and it is the only thing changed here.
     */
    await disallow(idOf("revokedlist"), "test-suite-incident");

    // The grant is deliberately left live: it is the *listing* that was withdrawn, and the
    // two facts are supposed to be able to disagree.
    expect(await hasActiveAdminGrant(prisma, idOf("revokedlist"))).toBe(true);
    expect(await isOnAdminAllowList(prisma, idOf("revokedlist"))).toBe(false);

    const after = await callAdminSelf("revokedlist");
    expect(after.statusCode).toBe(403);

    const decision = await decideAdmin(prisma, idOf("revokedlist"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not_allowlisted");

    // The session is still valid — this was the list, not a logout.
    const stillSignedIn = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: cookieOf("revokedlist") },
    });
    expect(stillSignedIn.statusCode).toBe(200);

    // And putting it back — with no other change — restores administration.
    await allow(idOf("revokedlist"), "test-suite-restore");
    expect((await callAdminSelf("revokedlist")).statusCode).toBe(200);
  });

  /**
   * A revoked grant can be revived, and revival is a real grant again.
   *
   * ⚠️ This matters operationally: *"撤销 → 重新授权"* is the ordinary way an incident ends,
   * and a design where revocation were a delete would leave a second row behind.
   */
  it("revives a revoked grant without leaving a second row", async () => {
    await register("revived");
    await setAccountNumber(idOf("revived"), "10000015");
    await grant(idOf("revived"));
    await revoke(idOf("revived"));
    await allow(idOf("revived"));
    await grant(idOf("revived"), "test-suite-again");

    expect(await prisma.adminGrant.count({ where: { userId: idOf("revived") } })).toBe(1);
    expect((await callAdminSelf("revived")).statusCode).toBe(200);
  });
});

describe("11. no ordinary path creates an administrator", () => {
  /**
   * ⚠️ **The security fix this round, stated as a test.**
   *
   * A registration code carrying `grants_admin = true` used to promote whoever redeemed it.
   * 98 such codes existed — never expiring, reserving numbers 10000002–10000099 — so anybody
   * holding one of the owner's printed cards could have become an administrator **without
   * anybody deciding so at that moment**.
   *
   * ⚠️ **This test is the inverse of the one it replaces**, which asserted the opposite and
   * was correct when written (a deliberate privilege, chosen by name). The owner then decided
   * that registration must not confer administration at all — see
   * `docs/开发过程记录/管理员与权限边界-设计决定.md` §5.
   */
  it("does not make the holder of an admin code an administrator", async () => {
    await prisma.registrationInvite.create({
      data: { code: "FORMER-ADMIN-CODE", accountNumber: "10000060", grantsAdmin: true },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        inviteCode: "FORMER-ADMIN-CODE",
        username: "usedanadmincode",
        displayName: "曾经的管理员码",
        password: "reserved-password-2026",
      },
    });

    expect(response.statusCode, response.body).toBe(201);

    const row = await prisma.user.findUniqueOrThrow({
      where: { username: "usedanadmincode" },
      select: { id: true, isAdmin: true, accountNumber: true },
    });

    // The reserved number is still honoured — that was never the privilege.
    expect(row.accountNumber).toBe("10000060");
    // …and no administration came with it.
    expect(row.isAdmin).toBe(false);
    expect(await hasActiveAdminGrant(prisma, row.id)).toBe(false);
  });

  it("does not make an ordinary signup an administrator", async () => {
    await register("plain");

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: idOf("plain") },
      select: { isAdmin: true },
    });
    expect(row.isAdmin).toBe(false);
    expect(await prisma.adminGrant.count({ where: { userId: idOf("plain") } })).toBe(0);
  });

  /**
   * ⚠️ **A reserved number, without the flag, produces an ordinary account.** This was the
   * earlier bug the owner caught — administration inferred from "the code reserved a number"
   * — and the assertion is worth keeping after the fix, because the fix could be reversed by
   * somebody deciding the flag was redundant.
   */
  it("does not make a reserved number an administrator by itself", async () => {
    await prisma.registrationInvite.create({
      data: { code: "RESERVED-PLAIN", accountNumber: "10000061", grantsAdmin: false },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        inviteCode: "RESERVED-PLAIN",
        username: "reservedplain",
        displayName: "普通",
        password: "reserved-password-2026",
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    const row = await prisma.user.findUniqueOrThrow({
      where: { username: "reservedplain" },
      select: { isAdmin: true, accountNumber: true },
    });
    expect(row.accountNumber).toBe("10000061");
    expect(row.isAdmin).toBe(false);
  });

  /**
   * ⚠️ **Changing what you are called cannot promote you.**
   *
   * Two halves, because there are two ways to imagine this attack:
   *
   *  1. **Through the API.** `PATCH /auth/me` accepts preferences only — `defaultCurrency`,
   *     and nothing else. There is no display-name or username field to send, which is a
   *     stronger guarantee than validating one: the input does not exist. (This test was
   *     first written sending `displayName` and got a 400, which is the endpoint correctly
   *     refusing a field it does not accept.)
   *  2. **In the database.** Even with the display name changed by hand to the owner's —
   *     the shape the brief is really guarding against — the guard still refuses. An
   *     administrator's identity is their account row and their grant, and **not one character
   *     of it is a name.**
   */
  it("does not grant administration through a display-name change", async () => {
    await register("renamer");
    await setAccountNumber(idOf("renamer"), "10000016");

    // 1. The API does not accept a name at all.
    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/me",
      headers: { cookie: cookieOf("renamer") },
      payload: { displayName: "管理员" },
    });
    expect(renamed.statusCode).toBe(400);

    // The accepted field works and confers nothing.
    const changed = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/me",
      headers: { cookie: cookieOf("renamer") },
      payload: { defaultCurrency: "USD" },
    });
    expect(changed.statusCode).toBe(200);
    expect(await prisma.adminGrant.count({ where: { userId: idOf("renamer") } })).toBe(0);

    // 2. Even impersonating the owner's name in the database changes nothing.
    await prisma.user.update({
      where: { id: idOf("renamer") },
      data: { displayName: "naeor" },
    });

    expect((await callAdminSelf("renamer")).statusCode).toBe(403);
    expect(await prisma.adminGrant.count({ where: { userId: idOf("renamer") } })).toBe(0);

    // And the real owner is not affected by somebody sharing their display name.
    await register("realowner");
    await setAccountNumber(idOf("realowner"), FIRST_BATCH_ACCOUNT_FIRST);
    await makeAdministrator(idOf("realowner"));
    expect((await callAdminSelf("realowner")).statusCode).toBe(200);
  });
});

describe("12–13. ledger permissions are untouched", () => {
  /** The first ledger of a registered account. */
  async function bookOf(username: string): Promise<string> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/books",
      headers: { cookie: cookieOf(username) },
    });
    const body = response.json() as { books: { id: string }[] };
    const id = body.books[0]?.id;
    if (id === undefined) throw new Error(`${username} has no ledger`);
    return id;
  }

  /**
   * ⚠️ **Case 13, and the most important boundary in this round: an administrator is not a
   * member of anybody's ledger.**
   *
   * Ledger access comes from `book_members` and from nothing else. An admin with no
   * membership must be refused exactly like anybody else — if this ever passes, the admin
   * role has quietly become a master key to everybody's finances, which the brief forbids in
   * as many words (*"管理员身份不自动意味着拥有所有用户私人账目的读取和修改权限"*).
   */
  it("does not let an administrator read a ledger they are not a member of", async () => {
    await register("ledgerowner");
    const ownerBookId = await bookOf("ledgerowner");

    await register("nosympathies");
    await setAccountNumber(idOf("nosympathies"), "10000017");
    await makeAdministrator(idOf("nosympathies"));

    // The administrator is an administrator…
    expect((await callAdminSelf("nosympathies")).statusCode).toBe(200);

    // …and still cannot read somebody else's ledger, through any of the usual doors.
    for (const url of ["/api/v1/ledger", "/api/v1/transactions", "/api/v1/summary", "/api/v1/stats"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: cookieOf("nosympathies"), "x-libellum-book": ownerBookId },
      });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(403);
    }

    // Nor write to it.
    const write = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: { cookie: cookieOf("nosympathies"), "x-libellum-book": ownerBookId },
      payload: {
        kind: "expense",
        amountCents: 100,
        currency: "CNY",
        categoryId: null,
        occurredAt: new Date().toISOString(),
      },
    });
    expect(write.statusCode).toBe(403);

    // Sanity: the owner can read their own ledger, so the 403s above are about membership
    // rather than about a broken fixture.
    const ownerRead = await app.inject({
      method: "GET",
      url: "/api/v1/ledger",
      headers: { cookie: cookieOf("ledgerowner"), "x-libellum-book": ownerBookId },
    });
    expect(ownerRead.statusCode).toBe(200);
  });

  /**
   * ⚠️ **Case 12: ordinary ledger permissions behave exactly as before.** Becoming (or
   * ceasing to be) an administrator changes nothing about owner/editor/viewer.
   */
  it("leaves owner and viewer permissions unchanged", async () => {
    await register("permowner");
    const bookId = await bookOf("permowner");
    const ownerHeaders = { cookie: cookieOf("permowner"), "x-libellum-book": bookId };

    await register("permviewer");
    await prisma.bookMember.create({
      data: { bookId, userId: idOf("permviewer"), role: "viewer" },
    });
    const viewerHeaders = { cookie: cookieOf("permviewer"), "x-libellum-book": bookId };

    const newExpense = {
      kind: "expense",
      amountCents: 100,
      currency: "CNY",
      categoryId: null,
      occurredAt: new Date().toISOString(),
    };

    // A viewer reads and cannot write.
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/ledger", headers: viewerHeaders }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/transactions",
          headers: viewerHeaders,
          payload: newExpense,
        })
      ).statusCode,
    ).toBe(403);

    // Make the *viewer* an administrator: nothing about their ledger role may change.
    await setAccountNumber(idOf("permviewer"), "10000018");
    await makeAdministrator(idOf("permviewer"));

    expect((await callAdminSelf("permviewer")).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/ledger", headers: viewerHeaders }))
        .statusCode,
    ).toBe(200);
    const stillCannotWrite = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: viewerHeaders,
      payload: newExpense,
    });
    expect(stillCannotWrite.statusCode, stillCannotWrite.body).toBe(403);

    // And the owner is unaffected throughout.
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/ledger", headers: ownerHeaders }))
        .statusCode,
    ).toBe(200);
  });
});

describe("14. the data survives, and reads as the database says", () => {
  /**
   * ⚠️ **The grant and the allow-list position are read from the database on every request,
   * so "after a restart" is not a separate code path** — but it is worth asserting that
   * nothing about them is held in the process, because that is the property a cache would
   * break.
   *
   * The decisions below are made by two freshly built apps. If either half were memoised in
   * a module, the second app would answer from the first app's state.
   */
  it("answers from the database rather than from process state", async () => {
    await register("persistent");
    await setAccountNumber(idOf("persistent"), "10000019");
    await makeAdministrator(idOf("persistent"));

    expect((await callAdminSelf("persistent")).statusCode).toBe(200);

    // A second, independent app — nothing shared with the first but the database.
    const second = appWithAdminRoute();
    const viaSecond = await second.inject({
      method: "GET",
      url: "/api/v1/admin/self",
      headers: { cookie: cookieOf("persistent") },
    });
    expect(viaSecond.statusCode).toBe(200);

    // Change the database behind both, and both agree immediately.
    await revoke(idOf("persistent"));
    expect((await callAdminSelf("persistent")).statusCode).toBe(403);
    const viaSecondAfter = await second.inject({
      method: "GET",
      url: "/api/v1/admin/self",
      headers: { cookie: cookieOf("persistent") },
    });
    expect(viaSecondAfter.statusCode).toBe(403);
  });

  /**
   * ⚠️ **The migration's own claim, asserted.** The invitations that once conferred
   * administration must no longer say so — *"the database no longer claims these codes
   * promote anybody"* — while their reserved numbers stay exactly where they were.
   */
  it("keeps reservations available while the admin flag stays inert", async () => {
    const reserved = await prisma.registrationInvite.create({
      data: { code: "STILL-RESERVED", accountNumber: "10000099", grantsAdmin: true },
      select: { accountNumber: true, grantsAdmin: true },
    });
    expect(reserved.accountNumber).toBe("10000099");

    /**
     * Even with the flag set by hand, redeeming the code confers nothing — which is the
     * stronger statement than "the migration cleared the old rows": the *path* is closed,
     * not merely the data tidied.
     */
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        inviteCode: "STILL-RESERVED",
        username: "reservedstill",
        displayName: "预留",
        password: "reserved-password-2026",
      },
    });
    expect(response.statusCode, response.body).toBe(201);

    const row = await prisma.user.findUniqueOrThrow({
      where: { username: "reservedstill" },
      select: { id: true, isAdmin: true, accountNumber: true },
    });
    expect(row.accountNumber).toBe("10000099");
    expect(row.isAdmin).toBe(false);
    expect(await prisma.adminGrant.count({ where: { userId: row.id } })).toBe(0);
  });
});

describe("the admin surface exists in a normal build and is guarded", () => {
  /**
   * ⚠️ **Required by the brief: *"测试路由不能在正常生产构建中暴露"*.**
   *
   * Two separate assertions, because they fail in different ways:
   *
   *  1. **An app built without the option has no admin route at all** — not a route that
   *     refuses, a route that `404`s. The brief is explicit that no admin API should be
   *     exposed merely to prove the guard works, and *"it exists but is disabled"* is a weaker
   *     promise than *"it does not exist"*.
   *  2. **Nothing in the production entry point can turn it on** — `src/server.ts` is the only
   *     thing a deployment runs, and it must not pass the flag, and no environment variable
   *     may do it either. This is checked against the source rather than asserted in prose,
   *     because a later edit could add the flag with nothing to notice.
   */
  it("exists in a normal build and refuses unauthenticated callers with 401", async () => {
    const productionShaped = makeApp();

    const response = await productionShaped.inject({
      method: "GET",
      url: "/api/v1/admin/self",
    });

    // 401, not 404: the route exists and "who are you" is the first question it asks.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "not_authenticated" });
  });

  it("cannot be enabled from the production entry point or the environment", async () => {
    const serverSource = readFileSync(
      fileURLToPath(new URL("../src/server.ts", import.meta.url)),
      "utf8",
    );

    // ⚠️ The entry point must not name the option at all.
    expect(serverSource).not.toContain("enableTestAdminRoute");
    expect(serverSource).not.toContain("admin");

    // ⚠️ And no environment variable may reach it: `app.ts` reads it from the options object
    // only, so the string must not appear on the right-hand side of any `process.env` lookup.
    const appSource = readFileSync(
      fileURLToPath(new URL("../src/app.ts", import.meta.url)),
      "utf8",
    );
    expect(appSource).not.toMatch(/process\.env\[[^\]]*ADMIN[^\]]*\]/i);
  });
});

describe("a broken or missing allow-list configuration denies", () => {
  /**
   * ⚠️ **Required by the brief: *"缺失或损坏的允许名单配置必须默认拒绝"*.**
   *
   * With the list stored in a table rather than in configuration, "missing configuration" has
   * a concrete shape — **a row that is not there** — and "corrupt" has one too: **a row whose
   * account has been deleted, leaving a dangling reference**. The foreign key makes the second
   * impossible to create through the application, so the test checks the guard's behaviour
   * against the state directly: an entry naming a UUID that is not on the list is a refusal
   * rather than an error, and an account with no entry is refused even when everything else
   * about it is correct.
   */
  it("denies when the listing is absent, and does not throw", async () => {
    await register("noconfig");
    await setAccountNumber(idOf("noconfig"), "10000031");
    await grant(idOf("noconfig"));

    // No entry at all. Must be a refusal, not an exception.
    await expect(decideAdmin(prisma, idOf("noconfig"))).resolves.toMatchObject({ ok: false });
    expect((await callAdminSelf("noconfig")).statusCode).toBe(403);

    // An unknown UUID likewise: refused, never thrown.
    await expect(
      decideAdmin(prisma, "00000000-0000-4000-8000-000000000000"),
    ).resolves.toMatchObject({ ok: false });
  });

  /**
   * ⚠️ **A revoked listing is not a listing.** The row still exists — revocation is a
   * timestamp, not a delete — and the guard has to read the timestamp rather than the row's
   * presence. A guard that checked `!== null` on the record instead of on its `revokedAt`
   * would pass every other test and admit a removed account here.
   */
  it("denies when the listing exists but is revoked", async () => {
    await register("revokedconfig");
    await setAccountNumber(idOf("revokedconfig"), "10000032");
    await makeAdministrator(idOf("revokedconfig"));

    expect((await callAdminSelf("revokedconfig")).statusCode).toBe(200);

    await disallow(idOf("revokedconfig"));

    // The row is still there — it is a record of what happened, not a deletion.
    const row = await prisma.adminAllowEntry.findUniqueOrThrow({
      where: { userId: idOf("revokedconfig") },
    });
    expect(row.revokedAt).not.toBeNull();

    expect(await isOnAdminAllowList(prisma, idOf("revokedconfig"))).toBe(false);
    expect((await callAdminSelf("revokedconfig")).statusCode).toBe(403);
  });
});
