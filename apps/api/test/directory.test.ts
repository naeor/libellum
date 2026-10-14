import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * **Finding somebody, and inviting them into a ledger.**
 *
 * ⚠️ **This replaced `collab.test.ts` in 1.10.05**, when the account-level collaborator system was
 * removed on the owner's instruction:
 *
 * > *"不再要求用户先发送「添加协作者申请」、等待对方同意，然后才能发送账本邀请。"*
 * > *"这次应当真正消除旧的双重确认流程，而不只是把旧协作者系统隐藏起来。"*
 *
 * ⚠️ **The refusals are as important as the successes**, and they now guard a *different* thing:
 * not "are these two collaborators", but **"may this person put that person into this ledger"**.
 * The whole point of the simplification is that it removes a *step*, not a *check* — so these tests
 * exist to show that the checks that remain still hold.
 */
describe("directory lookup and ledger invitations", () => {
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

  function lookupByNumber(cookie: string, accountNumber: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/directory/lookup?accountNumber=${accountNumber}`,
      headers: { cookie },
    });
  }

  function lookupByUsername(cookie: string, username: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/directory/lookup?username=${encodeURIComponent(username)}`,
      headers: { cookie },
    });
  }

  /** Invite somebody into the ledger named by `bookId`, the way the screen does. */
  function invite(
    cookie: string,
    bookId: string,
    target: { accountNumber?: string; username?: string },
    role?: "editor" | "viewer",
  ) {
    return app.inject({
      method: "POST",
      url: "/api/v1/books/invite",
      headers: { cookie, "x-libellum-book": bookId },
      payload: role === undefined ? target : { ...target, role },
    });
  }

  function decide(cookie: string, id: string, decision: "accepted" | "declined") {
    return app.inject({
      method: "POST",
      url: `/api/v1/notifications/${id}/decide`,
      headers: { cookie },
      payload: { decision },
    });
  }

  async function currentBookId(cookie: string): Promise<string> {
    const response = await app.inject({ method: "GET", url: "/api/v1/ledger", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return (response.json() as { book: { id: string } }).book.id;
  }

  async function inbox(cookie: string) {
    const response = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      notifications: {
        id: string;
        kind: string;
        status: string;
        sender: { username: string };
        book: { name: string } | null;
      }[];
      pendingCount: number;
      unreadCount: number;
    };
  }

  // ---------------------------------------------------------------------------
  // Looking somebody up
  // ---------------------------------------------------------------------------

  it("finds an account by its full number, and refuses a partial one", async () => {
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");

    const found = await lookupByNumber(alice.cookie, bob.accountNumber);
    expect(found.statusCode).toBe(200);
    expect((found.json() as { account: { username: string } }).account.username).toBe("dir_bob");

    /**
     * ⚠️ **A prefix is refused rather than searched.** Numbers are sequential, so a prefix search
     * would let anybody walk the user base one digit at a time. The shape check is what turns that
     * into "guess a specific person's number".
     */
    const partial = await lookupByNumber(alice.cookie, bob.accountNumber.slice(0, 6));
    expect(partial.statusCode).toBe(400);
    expect((partial.json() as { code: string }).code).toBe("account_number_shape");
  });

  it("finds an account by an exact username, and refuses a partial one", async () => {
    /**
     * ⚠️ **The owner allowed username lookup on 2026-10-13** — *"算了也允许用户名精准匹配好了"* — and
     * weighed the privacy point himself. **Exact match only**: a partial match on a name is the same
     * enumeration primitive a partial number would be, so the second half of this test is the
     * security property, not a nicety.
     */
    const alice = await account("dir_alice");
    await account("dir_bob");

    const exact = await lookupByUsername(alice.cookie, "dir_bob");
    expect(exact.statusCode).toBe(200);
    expect((exact.json() as { account: { accountNumber: string } }).account.accountNumber).not.toBe("");

    const partial = await lookupByUsername(alice.cookie, "dir_bo");
    expect(partial.statusCode).toBe(404);
    expect((partial.json() as { code: string }).code).toBe("account_not_found");
  });

  it("refuses to look up yourself, by either identifier", async () => {
    /**
     * ⚠️ **Refused, not returned flagged.** Somebody searching their own identifier is either
     * confused or testing, and the useful answer is to say so — the alternative is a card offering
     * to invite yourself into your own ledger.
     */
    const alice = await account("dir_alice");

    for (const response of [
      await lookupByNumber(alice.cookie, alice.accountNumber),
      await lookupByUsername(alice.cookie, "dir_alice"),
    ]) {
      expect(response.statusCode).toBe(400);
      expect((response.json() as { code: string }).code).toBe("account_is_self");
    }
  });

  it("says whether the person found is already in the ledger being viewed", async () => {
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const bookId = await currentBookId(alice.cookie);

    const before = await app.inject({
      method: "GET",
      url: `/api/v1/directory/lookup?accountNumber=${bob.accountNumber}`,
      headers: { cookie: alice.cookie, "x-libellum-book": bookId },
    });
    expect((before.json() as { account: { alreadyMember: boolean } }).account.alreadyMember).toBe(false);

    const sent = await invite(alice.cookie, bookId, { accountNumber: bob.accountNumber });
    await decide(bob.cookie, (sent.json() as { notificationId: string }).notificationId, "accepted");

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/directory/lookup?accountNumber=${bob.accountNumber}`,
      headers: { cookie: alice.cookie, "x-libellum-book": bookId },
    });
    expect((after.json() as { account: { alreadyMember: boolean } }).account.alreadyMember).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Inviting — the one-step flow
  // ---------------------------------------------------------------------------

  it("invites somebody who was never a collaborator, and grants the role only on acceptance", async () => {
    /**
     * ⚠️ **This test used to assert the opposite refusal.** Under the old rule, inviting somebody
     * who was not already a collaborator answered `400 not_collaborators`, and the flow was
     * *"先加为协作者，再邀请他进某本账"*. That requirement is gone, and **this is the test that says
     * so** — otherwise the removal would be indistinguishable from a bug that stopped enforcing it.
     */
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const bookId = await currentBookId(alice.cookie);

    const sent = await invite(alice.cookie, bookId, { accountNumber: bob.accountNumber });
    expect(sent.statusCode).toBe(201);
    expect((sent.json() as { role: string }).role).toBe("editor");

    /**
     * ⚠️ **Sending an invitation must not grant anything.** The whole consent model is that the
     * invitee decides — so before they answer, there is no membership row at all.
     */
    expect(
      await prisma.bookMember.count({ where: { bookId, userId: bob.userId } }),
    ).toBe(0);

    // And the invitation really is waiting for them, in their own inbox.
    const waiting = await inbox(bob.cookie);
    expect(waiting.notifications).toHaveLength(1);
    expect(waiting.notifications[0]?.kind).toBe("book_invite");
    expect(waiting.notifications[0]?.book?.name).not.toBeNull();

    const id = (sent.json() as { notificationId: string }).notificationId;
    expect((await decide(bob.cookie, id, "accepted")).statusCode).toBe(200);

    const membership = await prisma.bookMember.findUniqueOrThrow({
      where: { bookId_userId: { bookId, userId: bob.userId } },
      select: { role: true, leftAt: true },
    });
    expect(membership.role).toBe("editor");
    expect(membership.leftAt).toBeNull();
  });

  it("invites by username as well as by account number", async () => {
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const bookId = await currentBookId(alice.cookie);

    const sent = await invite(alice.cookie, bookId, { username: "dir_bob" }, "viewer");
    expect(sent.statusCode).toBe(201);

    await decide(bob.cookie, (sent.json() as { notificationId: string }).notificationId, "accepted");

    const membership = await prisma.bookMember.findUniqueOrThrow({
      where: { bookId_userId: { bookId, userId: bob.userId } },
      select: { role: true },
    });
    expect(membership.role).toBe("viewer");
  });

  it("refuses an invitation that names neither identifier, or both", async () => {
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const bookId = await currentBookId(alice.cookie);

    expect((await invite(alice.cookie, bookId, {})).statusCode).toBe(400);

    const both = await app.inject({
      method: "POST",
      url: "/api/v1/books/invite",
      headers: { cookie: alice.cookie, "x-libellum-book": bookId },
      payload: { accountNumber: bob.accountNumber, username: "dir_bob" },
    });
    expect(both.statusCode).toBe(400);
  });

  it("keeps a refused invitation visible instead of hiding it", async () => {
    /**
     * ⚠️ **The owner asked to see refusals** — *"看到被拒绝"* — so the row stays and the sender
     * learns the answer. A refusal that vanished would look exactly like one that was never sent.
     *
     * ⚠️ **The sender learns it from the lookup, not from their inbox.** `GET /notifications`
     * returns what was *received*; an invitation is *sent*, so it belongs to the recipient's inbox
     * and never the sender's. The moment the sender needs the answer is the moment they are about
     * to invite again — so the lookup for that person reports the outstanding invitation and what
     * happened to it. (A test asserting it appeared in the *sender's* inbox was looking in the wrong
     * place, and would have passed only if sent invitations leaked into it.)
     */
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const bookId = await currentBookId(alice.cookie);

    const sent = await invite(alice.cookie, bookId, { accountNumber: bob.accountNumber });
    const id = (sent.json() as { notificationId: string }).notificationId;

    const pending = await app.inject({
      method: "GET",
      url: `/api/v1/directory/lookup?accountNumber=${bob.accountNumber}`,
      headers: { cookie: alice.cookie, "x-libellum-book": bookId },
    });
    expect((pending.json() as { invitation: { status: string } }).invitation.status).toBe("pending");

    expect((await decide(bob.cookie, id, "declined")).statusCode).toBe(200);

    const refused = await app.inject({
      method: "GET",
      url: `/api/v1/directory/lookup?accountNumber=${bob.accountNumber}`,
      headers: { cookie: alice.cookie, "x-libellum-book": bookId },
    });
    expect((refused.json() as { invitation: { status: string } }).invitation.status).toBe("declined");

    /** And the recipient sees the answer in their own inbox, which is where it belongs. */
    const bobInbox = await inbox(bob.cookie);
    expect(bobInbox.notifications).toHaveLength(1);
    expect(bobInbox.notifications[0]?.status).toBe("declined");
    expect(bobInbox.pendingCount).toBe(0);

    // And no membership was created by the refusal.
    expect(await prisma.bookMember.count({ where: { bookId, userId: bob.userId } })).toBe(0);
  });

  it("refuses a decision on somebody else's notification", async () => {
    /**
     * ⚠️ **The notification belongs to one account and only that account may answer it.** This is
     * the isolation property that matters most here: an invitation is a question addressed to a
     * person, and a third party answering it on their behalf would put them into a ledger they never
     * agreed to.
     */
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const carol = await account("dir_carol");
    const bookId = await currentBookId(alice.cookie);

    const sent = await invite(alice.cookie, bookId, { accountNumber: bob.accountNumber });
    const id = (sent.json() as { notificationId: string }).notificationId;

    const stolen = await decide(carol.cookie, id, "accepted");
    expect(stolen.statusCode).toBe(403);
    expect((stolen.json() as { code: string }).code).toBe("notification_not_recipient");

    expect(await prisma.bookMember.count({ where: { bookId, userId: bob.userId } })).toBe(0);
    expect(await prisma.bookMember.count({ where: { bookId, userId: carol.userId } })).toBe(0);
  });

  it("refuses to invite anyone into a ledger the caller cannot write in", async () => {
    /**
     * ⚠️ **Inviting somebody changes who can see the ledger, so it is a write.** A viewer must not
     * be able to do it, and the refusal has to come from the server — **a hidden button is not a
     * permission check**.
     */
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const carol = await account("dir_carol");
    const bookId = await currentBookId(alice.cookie);

    const sent = await invite(alice.cookie, bookId, { accountNumber: bob.accountNumber }, "viewer");
    await decide(bob.cookie, (sent.json() as { notificationId: string }).notificationId, "accepted");

    const attempt = await invite(bob.cookie, bookId, { accountNumber: carol.accountNumber });
    expect(attempt.statusCode).toBe(403);

    expect(await prisma.bookMember.count({ where: { bookId, userId: carol.userId } })).toBe(0);
  });

  it("refuses to invite somebody who is already in the ledger", async () => {
    /**
     * ⚠️ **Refused before a notification is sent**, so the sender does not spend quota learning
     * something the lookup could have told them — and so the recipient does not get a card that,
     * when accepted, would silently rewrite their existing role.
     */
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const bookId = await currentBookId(alice.cookie);

    const first = await invite(alice.cookie, bookId, { accountNumber: bob.accountNumber }, "viewer");
    await decide(bob.cookie, (first.json() as { notificationId: string }).notificationId, "accepted");

    const again = await invite(alice.cookie, bookId, { accountNumber: bob.accountNumber }, "editor");
    expect(again.statusCode).toBe(400);
    expect((again.json() as { code: string }).code).toBe("already_member");

    // The role is untouched — the second invitation did not go through as an upgrade.
    const membership = await prisma.bookMember.findUniqueOrThrow({
      where: { bookId_userId: { bookId, userId: bob.userId } },
      select: { role: true },
    });
    expect(membership.role).toBe("viewer");
  });

  it("lets a viewer read the ledger's metadata but not change the ledger", async () => {
    /**
     * ⚠️ **This was a real defect, found while building the start page's gear panel (1.10.08).**
     *
     * `/ledger` was registered with the **write** guard, so **a viewer got `403` on 账本信息** — the
     * owner's own rule is *"查看者不应获得编辑或邀请权限"*, and reading a ledger's name and entry count
     * is not editing it. The gear panel links every member to that screen, so it had to be right.
     *
     * ⚠️ **The fix narrowed `/ledger` to the read guard and nothing else**, and this test holds both
     * halves: **the read that must now work, and the write that must still not.**
     */
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const bookId = await currentBookId(alice.cookie);

    const sent = await invite(alice.cookie, bookId, { accountNumber: bob.accountNumber }, "viewer");
    await decide(bob.cookie, (sent.json() as { notificationId: string }).notificationId, "accepted");

    /** Reading: allowed. This used to be a 403. */
    const meta = await app.inject({
      method: "GET",
      url: "/api/v1/ledger",
      headers: { cookie: bob.cookie, "x-libellum-book": bookId },
    });
    expect(meta.statusCode).toBe(200);
    expect((meta.json() as { book: { id: string } }).book.id).toBe(bookId);

    /** Writing: still refused, from the server. */
    const rename = await app.inject({
      method: "PATCH",
      url: `/api/v1/books/${bookId}`,
      headers: { cookie: bob.cookie, "x-libellum-book": bookId },
      payload: { name: "我改的" },
    });
    expect(rename.statusCode).toBe(403);

    const inviteAttempt = await invite(bob.cookie, bookId, { username: "dir_carol" });
    expect(inviteAttempt.statusCode).toBe(403);
  });

  it("still refuses the metadata to somebody outside the ledger", async () => {
    /**
     * ⚠️ **Narrowing the guard must not have opened it.** "A member may read" and "anybody may read"
     * are one word apart in the code and nothing alike in effect.
     */
    const alice = await account("dir_alice");
    const mallory = await account("dir_mallory");
    const bookId = await currentBookId(alice.cookie);

    const attempt = await app.inject({
      method: "GET",
      url: "/api/v1/ledger",
      headers: { cookie: mallory.cookie, "x-libellum-book": bookId },
    });
    expect(attempt.statusCode).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // Membership isolation across ledgers
  // ---------------------------------------------------------------------------

  it("keeps membership per ledger: joining one does not open another", async () => {
    /**
     * ⚠️ **This is the group-chat property, stated as a test.** A ledger is its own group: being in
     * one says nothing about any other, and an account's own ledgers stay private.
     */
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");

    const aliceBook = await currentBookId(alice.cookie);
    const bobBook = await currentBookId(bob.cookie);
    expect(aliceBook).not.toBe(bobBook);

    // Bob joins Alice's ledger.
    const sent = await invite(alice.cookie, aliceBook, { accountNumber: bob.accountNumber });
    await decide(bob.cookie, (sent.json() as { notificationId: string }).notificationId, "accepted");

    // He is in hers, and hers only.
    expect(await prisma.bookMember.count({ where: { bookId: aliceBook, userId: bob.userId } })).toBe(1);
    expect(await prisma.bookMember.count({ where: { bookId: bobBook, userId: alice.userId } })).toBe(0);

    /**
     * ⚠️ **And Alice still cannot read Bob's own ledger** — the invitation went one way, and being
     * a member of somebody's ledger is not a mutual relationship.
     */
    const intrusion = await app.inject({
      method: "GET",
      url: "/api/v1/ledger",
      headers: { cookie: alice.cookie, "x-libellum-book": bobBook },
    });
    expect(intrusion.statusCode).toBe(403);
  });

  it("lets a member leave one ledger without touching their others", async () => {
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const aliceBook = await currentBookId(alice.cookie);
    const bobBook = await currentBookId(bob.cookie);

    const sent = await invite(alice.cookie, aliceBook, { accountNumber: bob.accountNumber });
    await decide(bob.cookie, (sent.json() as { notificationId: string }).notificationId, "accepted");

    const left = await app.inject({
      method: "POST",
      url: `/api/v1/books/${aliceBook}/leave`,
      headers: { cookie: bob.cookie },
    });
    expect(left.statusCode).toBe(200);

    // Gone from hers…
    const inAlice = await prisma.bookMember.findUnique({
      where: { bookId_userId: { bookId: aliceBook, userId: bob.userId } },
      select: { leftAt: true },
    });
    expect(inAlice?.leftAt).not.toBeNull();

    // …and untouched in his own.
    const inBob = await prisma.bookMember.findUnique({
      where: { bookId_userId: { bookId: bobBook, userId: bob.userId } },
      select: { leftAt: true },
    });
    expect(inBob).not.toBeNull();
    expect(inBob?.leftAt).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // The inbox
  // ---------------------------------------------------------------------------

  it("counts pending notifications for the bell, and clears them when read", async () => {
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const bookId = await currentBookId(alice.cookie);

    await invite(alice.cookie, bookId, { accountNumber: bob.accountNumber });

    const before = await inbox(bob.cookie);
    expect(before.pendingCount).toBe(1);
    expect(before.unreadCount).toBe(1);

    const readAll = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read-all",
      headers: { cookie: bob.cookie },
    });
    expect(readAll.statusCode).toBe(200);

    const after = await inbox(bob.cookie);
    /** ⚠️ Read clears the dot; it does **not** answer the question. */
    expect(after.unreadCount).toBe(0);
    expect(after.pendingCount).toBe(1);
  });

  it("shows only my own notifications", async () => {
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");
    const carol = await account("dir_carol");
    const bookId = await currentBookId(alice.cookie);

    await invite(alice.cookie, bookId, { accountNumber: bob.accountNumber });

    expect((await inbox(bob.cookie)).notifications).toHaveLength(1);
    expect((await inbox(carol.cookie)).notifications).toHaveLength(0);
  });

  it("never returns a retired notification kind", async () => {
    /**
     * ⚠️ **⚠️ This is a regression test for a real break, and the reason the inbox query filters
     * `kind` explicitly.**
     *
     * The owner's development database still held **decided, unexpired** `collaborator_request`
     * rows. Once the view schema stopped accepting that kind, those rows threw during parsing —
     * **which takes down the entire inbox, not just those two cards.** The migration removes the
     * pending ones; the decided ones stay as history, so the read path has to be the thing that
     * knows they are no longer renderable.
     */
    const alice = await account("dir_alice");
    const bob = await account("dir_bob");

    await prisma.notification.create({
      data: {
        senderId: alice.userId,
        recipientId: bob.userId,
        kind: "collaborator_request",
        status: "accepted",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        decidedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { cookie: bob.cookie },
    });

    /** The row exists, it is unexpired, and it must not break the screen. */
    expect(await prisma.notification.count({ where: { recipientId: bob.userId } })).toBe(1);
    expect(response.statusCode).toBe(200);
    expect((response.json() as { notifications: unknown[] }).notifications).toHaveLength(0);
  });
});
