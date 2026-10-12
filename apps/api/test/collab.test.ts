import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * The whole loop: look somebody up, ask them, they decide, and the relationship exists.
 *
 * ⚠️ **The two refusals are as important as the successes.** A collaborator relationship grants no
 * ledger permission — so sending an invitation into a ledger the sender cannot write in must fail,
 * and accepting somebody else's notification must fail. **Both are cases where the happy path is
 * easy and the guard is the thing that matters.**
 */
describe("collaborators and notifications", () => {
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

  function lookup(cookie: string, accountNumber: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/collaborators/lookup?accountNumber=${accountNumber}`,
      headers: { cookie },
    });
  }

  function ask(cookie: string, accountNumber: string, message?: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/collaborators/requests",
      headers: { cookie },
      payload: message === undefined ? { accountNumber } : { accountNumber, message },
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

  async function inbox(cookie: string) {
    const response = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      notifications: { id: string; kind: string; status: string; sender: { username: string } }[];
      pendingCount: number;
      unreadCount: number;
    };
  }

  it("finds an account by its full number, and refuses a partial one", async () => {
    const alice = await account("collab_alice");
    const bob = await account("collab_bob");

    const found = await lookup(alice.cookie, bob.accountNumber);
    expect(found.statusCode).toBe(200);
    expect((found.json() as { username: string }).username).toBe("collab_bob");

    /**
     * ⚠️ **A prefix is refused rather than searched.** Numbers are sequential, so a prefix search
     * would let anybody walk the user base one digit at a time. The shape check is what turns that
     * into "guess a specific person's number".
     */
    const partial = await lookup(alice.cookie, bob.accountNumber.slice(0, 4));
    expect(partial.statusCode).toBe(400);
    expect(partial.json().code).toBe("account_number_shape");
  });

  it("refuses to look up your own number", async () => {
    const alice = await account("collab_alice");

    const self = await lookup(alice.cookie, alice.accountNumber);
    expect(self.statusCode).toBe(400);
    expect(self.json().code).toBe("account_is_self");
  });

  it("creates a relationship only after the other person accepts", async () => {
    const alice = await account("collab_alice");
    const bob = await account("collab_bob");

    const sent = await ask(alice.cookie, bob.accountNumber, "一起记账吧");
    expect(sent.statusCode).toBe(201);

    /**
     * ⚠️ **Nothing exists yet, and that is the "双方同意" requirement.** A pending request lives in
     * the notification; there is no half-relationship row for the collaborator list to show.
     */
    expect(await prisma.collaborator.count()).toBe(0);

    const bobsInbox = await inbox(bob.cookie);
    expect(bobsInbox.pendingCount).toBe(1);
    expect(bobsInbox.notifications[0]?.sender.username).toBe("collab_alice");

    const accepted = await decide(bob.cookie, bobsInbox.notifications[0]!.id, "accepted");
    expect(accepted.statusCode).toBe(200);

    expect(await prisma.collaborator.count()).toBe(1);

    // ⚠️ And it shows up **on both sides** — one row, read from either direction.
    for (const view of [alice, bob]) {
      const list = await app.inject({ method: "GET", url: "/api/v1/collaborators", headers: { cookie: view.cookie } });
      expect(list.statusCode).toBe(200);
      const collaborators = (list.json() as { collaborators: { username: string }[] }).collaborators;
      expect(collaborators).toHaveLength(1);
    }
  });

  it("keeps a refused request visible instead of hiding it", async () => {
    const alice = await account("collab_alice");
    const bob = await account("collab_bob");

    await ask(alice.cookie, bob.accountNumber ?? "");
    const bobsInbox = await inbox(bob.cookie);

    await decide(bob.cookie, bobsInbox.notifications[0]!.id, "declined");

    /**
     * ⚠️ **The row stays, and the sender can see the answer.** The owner asked for exactly this —
     * *"看到被拒绝"* — and the daily quota is what makes it safe to be honest: the sender learns the
     * answer and the ceiling stops them asking again and again. **Hiding it would leave them
     * waiting on a decision that was already made.**
     */
    const after = await inbox(bob.cookie);
    expect(after.notifications[0]?.status).toBe("declined");
    expect(after.pendingCount).toBe(0);
    expect(await prisma.collaborator.count()).toBe(0);
  });

  it("refuses a decision on somebody else's notification", async () => {
    const alice = await account("collab_alice");
    const bob = await account("collab_bob");
    const carol = await account("collab_carol");

    await ask(alice.cookie, bob.accountNumber);
    const bobsInbox = await inbox(bob.cookie);

    /**
     * ⚠️ **Carol cannot accept on Bob's behalf.** This is the whole reason a request needs the
     * other person's consent, so it is worth one test even though the happy path never touches it.
     */
    const stolen = await decide(carol.cookie, bobsInbox.notifications[0]!.id, "accepted");
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json().code).toBe("notification_not_recipient");
    expect(await prisma.collaborator.count()).toBe(0);
  });

  it("counts pending notifications for the bell, and clears them when read", async () => {
    const alice = await account("collab_alice");
    const bob = await account("collab_bob");

    await ask(alice.cookie, bob.accountNumber);
    expect((await inbox(bob.cookie)).unreadCount).toBe(1);

    const read = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read-all",
      headers: { cookie: bob.cookie },
    });
    expect(read.statusCode).toBe(200);

    /**
     * ⚠️ **Reading clears the dot but not the decision.** The card stays until it is answered —
     * "我已看过" and "我已处理" are different states, and collapsing them loses the second one.
     */
    const after = await inbox(bob.cookie);
    expect(after.unreadCount).toBe(0);
    expect(after.pendingCount).toBe(1);
  });

  it("shows the current ledger's collaborators first", async () => {    const alice = await account("collab_alice");
    const bob = await account("collab_bob");
    const carol = await account("collab_carol");

    // Both become collaborators.
    for (const other of [bob, carol]) {
      await ask(alice.cookie, other.accountNumber);
      const inboxResponse = await inbox(other.cookie);
      await decide(other.cookie, inboxResponse.notifications[0]!.id, "accepted");
    }

    // Only Bob joins Alice's ledger.
    const alicesBook = await prisma.bookMember.findFirstOrThrow({
      where: { userId: alice.userId },
      select: { bookId: true },
    });
    await prisma.bookMember.create({
      data: { bookId: alicesBook.bookId, userId: bob.userId, role: "editor" },
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/collaborators",
      headers: { cookie: alice.cookie, "x-libellum-book": alicesBook.bookId },
    });

    const collaborators = (list.json() as { collaborators: { username: string; inCurrentBook: boolean }[] })
      .collaborators;

    /**
     * ⚠️ **The owner's own example**: A shares ledger 1 with B and ledger 2 with C, and both appear on
     * one account-level list — but the current ledger's people sit on top so the screen can highlight
     * them. This is what makes the list useful without making it ledger-scoped.
     */
    expect(collaborators).toHaveLength(2);
    expect(collaborators[0]?.username).toBe("collab_bob");
    expect(collaborators[0]?.inCurrentBook).toBe(true);
    expect(collaborators[1]?.inCurrentBook).toBe(false);
  });

  /** Make two accounts collaborators, the long way round, because that is the only way there is. */
  async function befriend(
    a: Awaited<ReturnType<typeof account>>,
    b: Awaited<ReturnType<typeof account>>,
  ): Promise<void> {
    await ask(a.cookie, b.accountNumber);
    const inboxResponse = await inbox(b.cookie);
    await decide(b.cookie, inboxResponse.notifications[0]!.id, "accepted");
  }

  it("invites a collaborator into the current ledger, and grants what was offered", async () => {    const alice = await account("collab_alice");
    const bob = await account("collab_bob");
    await befriend(alice, bob);

    const book = await prisma.bookMember.findFirstOrThrow({
      where: { userId: alice.userId },
      select: { bookId: true },
    });

    const invited = await app.inject({
      method: "POST",
      url: "/api/v1/books/invite",
      headers: { cookie: alice.cookie, "x-libellum-book": book.bookId },
      payload: { accountNumber: bob.accountNumber, role: "viewer" },
    });

    expect(invited.statusCode).toBe(201);
    expect((invited.json() as { role: string }).role).toBe("viewer");

    /**
     * ⚠️ **Nothing has happened yet.** The invitation is a message, so there is no membership row
     * until Bob accepts — which is the "邀请也需要对方同意" half of the owner's consent rule.
     */
    expect(await prisma.bookMember.count({ where: { bookId: book.bookId, userId: bob.userId } })).toBe(0);

    const bobsInbox = await inbox(bob.cookie);
    const inviteNotification = bobsInbox.notifications.find((n) => n.kind === "book_invite");
    expect(inviteNotification).toBeDefined();

    const joined = await decide(bob.cookie, inviteNotification!.id, "accepted");
    expect(joined.statusCode).toBe(200);
    expect((joined.json() as { joined: boolean }).joined).toBe(true);

    /**
     * ⚠️ **`viewer`, not the default.** This is the assertion that would have caught the version of
     * this feature that accepted a role parameter and then ignored it — an invitation advertised as
     * read-only silently arriving as read-write. **Both sides would have believed they agreed.**
     */
    const membership = await prisma.bookMember.findUniqueOrThrow({
      where: { bookId_userId: { bookId: book.bookId, userId: bob.userId } },
      select: { role: true },
    });
    expect(membership.role).toBe("viewer");
  });

  it("invites somebody who is NOT a collaborator yet", async () => {
    const alice = await account("collab_alice");
    const stranger = await account("collab_stranger");

    const book = await prisma.bookMember.findFirstOrThrow({
      where: { userId: alice.userId },
      select: { bookId: true },
    });

    /**
     * ⚠️ **This test says the opposite of what it said before 2026-10-12, and that is the change.**
     *
     * It used to assert `400 not_collaborators` under the old rule *"先加为协作者，再邀请他进某本账"*.
     * The owner changed his mind and said so explicitly:
     *
     * > *"我不希望用户必须先添加对方为好友，再另行邀请对方加入账本……理想流程是：
     * >  A 选择账本并邀请 B → B 收到邀请 → B 确认加入该账本。"*
     *
     * ⚠️ **Keeping the old test and deleting it are both wrong.** Deleting it would leave the new
     * rule untested — and worse, **nothing would fail if the old check came back**. Flipping it means
     * the suite now *documents* which rule is in force, and **the next person to reintroduce the
     * two-step flow breaks a test that explains why they should not.**
     */
    const invited = await app.inject({
      method: "POST",
      url: "/api/v1/books/invite",
      headers: { cookie: alice.cookie, "x-libellum-book": book.bookId },
      payload: { accountNumber: stranger.accountNumber, role: "editor" },
    });

    expect(invited.statusCode).toBe(201);

    // ⚠️ And no collaborator row was invented by the invitation — the two ideas stay separate.
    expect(await prisma.collaborator.count()).toBe(0);

    /**
     * ⚠️ **Consent still happens, just once instead of twice.** The invitee has to accept, and until
     * then they are not in the ledger — *"B 收到邀请 → B 确认加入该账本"*.
     */
    expect(
      await prisma.bookMember.count({ where: { bookId: book.bookId, userId: stranger.userId } }),
    ).toBe(0);

    const inboxResponse = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { cookie: stranger.cookie },
    });
    const invite = (inboxResponse.json() as { notifications: { kind: string }[] }).notifications.find(
      (notification) => notification.kind === "book_invite",
    );
    expect(invite).toBeDefined();
  });

  it("refuses to invite anyone into a ledger the caller cannot write in", async () => {
    const alice = await account("collab_alice");
    const bob = await account("collab_bob");
    const viewer = await account("collab_viewer");

    await befriend(alice, bob);
    await befriend(alice, viewer);

    const book = await prisma.bookMember.findFirstOrThrow({
      where: { userId: alice.userId },
      select: { bookId: true },
    });

    /**
     * ⚠️ **A viewer may not invite.** Inviting somebody changes who can see a ledger's entries, so
     * it is a write — and `requireBookForWrite` is what decides that, on the server, rather than the
     * absence of a button in the UI.
     */
    await prisma.bookMember.create({
      data: { bookId: book.bookId, userId: viewer.userId, role: "viewer" },
    });

    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/books/invite",
      headers: { cookie: viewer.cookie, "x-libellum-book": book.bookId },
      payload: { accountNumber: bob.accountNumber },
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("book_read_only");
  });
});
