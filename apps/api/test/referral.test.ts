import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * Referral codes — the owner's "次级邀请码".
 *
 * ⚠️ **The two tests that matter are the refusals, not the happy path.** A referral code is the one
 * thing in this stage that *creates accounts*, so the interesting questions are **who may mint one**
 * and **what it does not do** — a code that quietly granted ledger access, or that could be chained
 * into a tree of accounts, would pass a happy-path test and be a serious hole.
 */
describe("referral codes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function account(username: string) {
    const cookie = await signUp(app, username);
    const user = await prisma.user.findUniqueOrThrow({
      where: { username },
      select: { id: true, accountNumber: true },
    });
    return { cookie, userId: user.id, accountNumber: user.accountNumber ?? "" };
  }

  function mint(cookie: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/referral-codes",
      headers: { cookie },
      payload: {},
    });
  }

  /** Register with a raw code — `signUp` mints its own plain invitation, so this is written out. */
  async function registerWith(code: string, username: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { inviteCode: code, username, displayName: username, password: "correct-horse-battery" },
    });
  }

  /**
   * ⚠️ **Signing in rather than signing up**, because these tests need an account that came in
   * *through a referral code* — and `signUp` would mint a plain invitation and create a second
   * account with the same name. **A helper that quietly registered a different account would make
   * every assertion below about the wrong person**, which is the kind of test that passes while
   * proving nothing.
   */
  async function signInAs(username: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "correct-horse-battery" },
    });

    if (response.statusCode !== 200) {
      throw new Error(`login failed: ${String(response.statusCode)} ${response.body}`);
    }

    const raw = response.headers["set-cookie"];
    const cookie = Array.isArray(raw) ? raw[0] : raw;
    if (typeof cookie !== "string") throw new Error("login did not set a cookie");
    return cookie.split(";")[0] ?? "";
  }

  it("records who invited the newcomer, and gives them a reminder they can act on", async () => {
    const inviter = await account("ref_inviter");
    const minted = await mint(inviter.cookie);
    expect(minted.statusCode).toBe(201);

    const { code } = minted.json() as { code: string };

    const registered = await registerWith(code, "ref_newcomer");
    expect(registered.statusCode).toBe(201);

    const newcomer = await prisma.user.findUniqueOrThrow({
      where: { username: "ref_newcomer" },
      select: { id: true, referredByUserId: true },
    });

    /**
     * ⚠️ **"Who invited me" is a fact about the account**, so it is stored on the account — not
     * derived by searching the code table every time the account screen opens.
     */
    expect(newcomer.referredByUserId).toBe(inviter.userId);

    const inbox = await prisma.notification.findMany({
      where: { recipientId: newcomer.id, kind: "referral_reminder" },
      select: { senderId: true, status: true, expiresAt: true },
    });

    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.senderId).toBe(inviter.userId);
    expect(inbox[0]?.status).toBe("pending");

    /**
     * ⚠️ **Seven days from the moment of registration** — the owner's *"从注册当天起 7 天"*. Checked
     * as a range rather than an exact value, because the exact instant is the registration's and the
     * assertion would otherwise be about clock precision rather than about the rule.
     */
    const days = (inbox[0]!.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("writes the reminder, and its wording no longer promises a collaborator", async () => {
    /**
     * ⚠️ **This test used to assert the opposite** — that no reminder was written when the generator
     * had not opted in. **That flag is gone (1.10.05)**, because the thing it controlled
     * ("add them as a collaborator") was the account-level system the owner removed. There is no
     * longer a choice to make, so the reminder is always written.
     *
     * ⚠️ **And its wording had to change with the model.** It used to promise *"确认之后，他会成为你的
     * 协作者"* — an account-level relationship that no longer exists, so **the card would have offered
     * something the server cannot do**. A reminder that promises nothing actionable is worse than no
     * reminder (`教训.md` §3.1), so it now points at the action that does exist.
     */
    const inviter = await account("ref_inviter");
    const { code } = (await mint(inviter.cookie)).json() as { code: string };

    await registerWith(code, "ref_newcomer");

    const newcomer = await prisma.user.findUniqueOrThrow({
      where: { username: "ref_newcomer" },
      select: { id: true, referredByUserId: true },
    });

    expect(newcomer.referredByUserId).toBe(inviter.userId);

    const reminder = await prisma.notification.findFirstOrThrow({
      where: { recipientId: newcomer.id, kind: "referral_reminder" },
      select: { message: true },
    });

    expect(reminder.message).not.toBeNull();
    expect(reminder.message).not.toContain("协作者");
    expect(reminder.message).toContain("账本");
  });

  it("does not spend the inviter's notification quota — twice the invites must not silence them", async () => {
    const inviter = await account("ref_inviter");
    const { code: first } = (await mint(inviter.cookie)).json() as { code: string };
    const { code: second } = (await mint(inviter.cookie)).json() as { code: string };

    await registerWith(first, "ref_one");
    await registerWith(second, "ref_two");

    /**
     * ⚠️ **The reminder costs no quota, and this is the assertion that says so.** The inviter
     * already spent their intention when they minted the code; charging the notification ceiling as
     * well would mean **a person could be silenced by their own invitations** — and nothing on
     * screen would explain why the sixth newcomer got no reminder.
     */
    expect(await prisma.notification.count({ where: { kind: "referral_reminder" } })).toBe(2);
    expect(await prisma.notificationQuota.count()).toBe(0);
  });

  it("refuses to let a referral-registered account mint another code", async () => {
    const inviter = await account("ref_inviter");
    const { code } = (await mint(inviter.cookie)).json() as { code: string };

    await registerWith(code, "ref_newcomer");
    const newcomerCookie = await signInAs("ref_newcomer");

    /**
     * ⚠️ **The owner's "1. 不能生成次级邀请码"**, and the reason is not tidiness: chaining would let
     * one person manufacture an **unbounded tree of accounts**, each of which looks independently
     * invited from a different parent. **A chain of referrals is a way of turning one invitation
     * into a hundred.**
     */
    const refused = await mint(newcomerCookie);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("referral_not_allowed");

    const newcomer = await prisma.user.findUniqueOrThrow({
      where: { username: "ref_newcomer" },
      select: { id: true },
    });
    expect(await prisma.registrationInvite.count({ where: { createdByUserId: newcomer.id } })).toBe(0);
  });

  it("refuses to let the demo account mint a code", async () => {
    const demo = await account("ref_demo");
    await prisma.user.update({ where: { id: demo.userId }, data: { isDemo: true } });

    /**
     * ⚠️ **The demo account is publicly reachable, so it must not be able to create accounts.** It
     * exists so that nobody needs an account of their own to look around — handing out registration
     * codes from it would turn "look around" into "create accounts from outside".
     */
    const refused = await mint(demo.cookie);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("referral_not_allowed");
  });

  it("grants no ledger access by itself", async () => {
    const inviter = await account("ref_inviter");
    const { code } = (await mint(inviter.cookie)).json() as { code: string };

    await registerWith(code, "ref_newcomer");
    const newcomerCookie = await signInAs("ref_newcomer");
    const newcomer = await prisma.user.findUniqueOrThrow({
      where: { username: "ref_newcomer" },
      select: { id: true },
    });

    /**
     * ⚠️ **This is the sentence the whole feature rests on**: the code *"不与任何账本绑定"* and grants
     * nothing. The newcomer has their own ledger and **no access to the inviter's** — so a referral
     * code can never be a back door into somebody's books, whatever else it does.
     */
    const inviterBook = await prisma.bookMember.findFirstOrThrow({
      where: { userId: inviter.userId },
      select: { bookId: true },
    });

    const refused = await app.inject({
      method: "GET",
      url: "/api/v1/stats?from=2026-10-01&to=2026-10-31&currency=CNY",
      headers: { cookie: newcomerCookie, "x-libellum-book": inviterBook.bookId },
    });

    expect(refused.statusCode).toBe(403);

    // And the reminder does not create a relationship either — the inviter must still accept.
    /**
     * ⚠️ **Registering with a referral code creates no ledger membership.** The account-level
     * "collaborator" relationship this used to assert about is gone (1.10.05), and the property that
     * matters is stronger and simpler: **a code makes an account, and grants access to nothing.**
     */
    expect(await prisma.bookMember.count({ where: { userId: newcomer.id } })).toBe(1);

    /**
     * ⚠️ **And the reminder is not an access grant either.** The inviter gets a notification saying
     * who arrived; **nothing about it puts the newcomer into the inviter's ledger**, and nothing puts
     * the inviter into the newcomer's. The only way either happens is an explicit ledger invitation
     * that the other side accepts.
     */
    expect(
      await prisma.bookMember.count({ where: { bookId: inviterBook.bookId, userId: newcomer.id } }),
    ).toBe(0);
  });

  it("allows exactly three codes in a lifetime, and does not refill", async () => {
    const inviter = await account("ref_inviter");

    /**
     * ⚠️ **The owner's *"次级邀请码（终身 3 个）"*.** I had implemented "unlimited, but no chaining"
     * and written it up as a correction to his specification — **which was me overruling a decision
     * that was his to make.** This test exists so it cannot happen quietly again.
     */
    for (let i = 0; i < 3; i += 1) {
      const minted = await mint(inviter.cookie);
      expect(minted.statusCode).toBe(201);
    }

    const fourth = await mint(inviter.cookie);
    expect(fourth.statusCode).toBe(400);
    expect(fourth.json().code).toBe("referral_limit_reached");
    expect(await prisma.registrationInvite.count({ where: { createdByUserId: inviter.userId } })).toBe(3);

    /**
     * ⚠️ **Revoking or expiring one must NOT give a slot back.** "终身 3 个" is a total, not "three
     * at a time" — if a lapsed code freed a slot, somebody could mint endlessly by letting each one
     * expire. **A limit you can refill is not a limit.**
     */
    await prisma.registrationInvite.updateMany({
      where: { createdByUserId: inviter.userId },
      data: { revokedAt: new Date() },
    });

    const afterRevoking = await mint(inviter.cookie);
    expect(afterRevoking.statusCode).toBe(400);
    expect(afterRevoking.json().code).toBe("referral_limit_reached");
  });
});
