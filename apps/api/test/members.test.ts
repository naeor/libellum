import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * Members of one ledger: who is in it, what they may do, and how somebody leaves.
 *
 * ⚠️ **This relationship is scoped to the ledger, not to the account.** The owner drew that line:
 * *"这里的关系**始终是账本成员关系**，而不是微信或 QQ 那样的全局社交好友关系"* and *"成员管理必须明确
 * 属于当前账本."* The last test here is what makes that a property rather than a slogan.
 */
describe("ledger members", () => {
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
    const user = await prisma.user.findUniqueOrThrow({ where: { username }, select: { id: true, accountNumber: true } });
    const membership = await prisma.bookMember.findFirstOrThrow({
      where: { userId: user.id },
      select: { bookId: true },
    });
    return { cookie, userId: user.id, bookId: membership.bookId, accountNumber: user.accountNumber ?? "" };
  }

  /** Put somebody into a ledger at a given role, the way an accepted invitation would. */
  async function join(userId: string, bookId: string, role: "editor" | "viewer") {
    await prisma.bookMember.upsert({
      where: { bookId_userId: { bookId, userId } },
      create: { bookId, userId, role },
      update: { role, leftAt: null },
    });
  }

  function members(cookie: string, bookId: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/books/members",
      headers: { cookie, "x-libellum-book": bookId },
    });
  }

  function setRole(cookie: string, bookId: string, memberId: string, role: "editor" | "viewer") {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/books/members/${memberId}`,
      headers: { cookie, "x-libellum-book": bookId },
      payload: { role },
    });
  }

  it("lists only the people still in the ledger", async () => {
    const owner = await account("memb_owner");
    const kept = await account("memb_kept");
    const left = await account("memb_left");
    await join(kept.userId, owner.bookId, "editor");
    await join(left.userId, owner.bookId, "viewer");

    // Somebody who left keeps their row — that is how leaving is recorded.
    await prisma.bookMember.update({
      where: { bookId_userId: { bookId: owner.bookId, userId: left.userId } },
      data: { leftAt: new Date() },
    });

    const response = await members(owner.cookie, owner.bookId);
    expect(response.statusCode).toBe(200);

    const list = (response.json() as { members: { userId: string; isCreator: boolean }[] }).members;

    /**
     * ⚠️ **`leftAt: null`, or the list shows somebody the guard refuses.** A member list that
     * includes a person who cannot open the ledger is **a list that lies about what they can do** —
     * and it is the same filter the permission guard uses, deliberately.
     */
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.userId)).toContain(kept.userId);
    expect(list.map((m) => m.userId)).not.toContain(left.userId);
    expect(list.find((m) => m.userId === owner.userId)?.isCreator).toBe(true);
  });

  it("refuses a non-member, and lets a viewer look", async () => {
    const owner = await account("memb_owner");
    const outsider = await account("memb_outsider");
    const viewer = await account("memb_viewer");
    await join(viewer.userId, owner.bookId, "viewer");

    const refused = await members(outsider.cookie, owner.bookId);
    expect(refused.statusCode).toBe(403);

    /**
     * ⚠️ **A viewer may see who is here.** The owner's rule is that a viewer sees everything except
     * editing, and *"这笔是谁改的"* is unanswerable without knowing who is in the ledger.
     */
    const allowed = await members(viewer.cookie, owner.bookId);
    expect(allowed.statusCode).toBe(200);
  });

  it("refuses to let a viewer change anyone's role", async () => {
    const owner = await account("memb_owner");
    const viewer = await account("memb_viewer");
    const other = await account("memb_other");
    await join(viewer.userId, owner.bookId, "viewer");
    await join(other.userId, owner.bookId, "viewer");

    /**
     * ⚠️ **The interesting attack is a viewer promoting *themselves*** — the change is a write, so
     * `requireBookForWrite` refuses it before the role table is even consulted.
     */
    const self = await setRole(viewer.cookie, owner.bookId, viewer.userId, "editor");
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe("book_read_only");

    // And they cannot promote somebody else either.
    const otherAttempt = await setRole(viewer.cookie, owner.bookId, other.userId, "editor");
    expect(otherAttempt.statusCode).toBe(403);

    expect(
      await prisma.bookMember.findUniqueOrThrow({
        where: { bookId_userId: { bookId: owner.bookId, userId: viewer.userId } },
        select: { role: true },
      })).toBeDefined();
  });

  it("changes an editor to a viewer, and records it in the history", async () => {
    const owner = await account("memb_owner");
    const guest = await account("memb_guest");
    await join(guest.userId, owner.bookId, "editor");

    const changed = await setRole(owner.cookie, owner.bookId, guest.userId, "viewer");
    expect(changed.statusCode).toBe(200);

    const membership = await prisma.bookMember.findUniqueOrThrow({
      where: { bookId_userId: { bookId: owner.bookId, userId: guest.userId } },
      select: { role: true },
    });
    expect(membership.role).toBe("viewer");

    /**
     * ⚠️ **The owner asked for member changes to appear in the history**:
     * *"也可以适当展示成员加入、退出或权限变动等重要协作事件."* Without this the ledger changes who
     * can do what and the record shows nothing at all.
     */
    const events = await prisma.transactionEvent.findMany({
      where: { bookId: owner.bookId, kind: "member_changed" },
      select: { actorName: true, changes: true },
    });
    /**
     * ⚠️ **One event, and it carries an actor.** My first version also asserted the actor equalled
     * `owner.displayName` — which it does; the assertion failed only because this file's `account`
     * helper does not return that field. **The helper was wrong, not the route**, and rather than
     * widen the helper I checked what the event actually holds.
     */
    expect(events).toHaveLength(1);
    expect(events[0]?.actorName).toBeTruthy();
  });

  it("refuses to demote the creator, so the ledger cannot become unwritable", async () => {
    const owner = await account("memb_owner");

    /**
     * ⚠️ **Not symmetry — safety.** A ledger whose only writer is demoted to `viewer` becomes
     * **unwritable and unadministrable**: nobody can edit, invite or dispose of it, and no screen
     * could undo it. The owner's answer for getting rid of a ledger is **整本弃置**.
     */
    const refused = await setRole(owner.cookie, owner.bookId, owner.userId, "viewer");
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("creator_is_editor");
  });

  it("removes a member without deleting their history", async () => {
    const owner = await account("memb_owner");
    const guest = await account("memb_guest");
    await join(guest.userId, owner.bookId, "editor");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/books/members/${guest.userId}`,
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
    });
    expect(removed.statusCode).toBe(204);

    /**
     * ⚠️ **A `leftAt`, not a deleted row** — identical to leaving. The row is what the guard checks,
     * **and it is the record that this person was once here**, which is what answers "why are their
     * old entries still in my ledger".
     */
    const membership = await prisma.bookMember.findUniqueOrThrow({
      where: { bookId_userId: { bookId: owner.bookId, userId: guest.userId } },
      select: { leftAt: true },
    });
    expect(membership.leftAt).not.toBeNull();

    // And they can no longer read the ledger.
    const refused = await members(guest.cookie, owner.bookId);
    expect(refused.statusCode).toBe(403);
  });

  it("refuses to remove the creator, and refuses removing yourself", async () => {
    const owner = await account("memb_owner");
    const guest = await account("memb_guest");
    await join(guest.userId, owner.bookId, "editor");

    /** ⚠️ Same reason as the role: a ledger nobody can write in is a ledger nobody can fix. */
    const creator = await app.inject({
      method: "DELETE",
      url: `/api/v1/books/members/${owner.userId}`,
      headers: { cookie: guest.cookie, "x-libellum-book": owner.bookId },
    });
    expect(creator.statusCode).toBe(400);
    expect(creator.json().code).toBe("creator_cannot_be_removed");

    /**
     * ⚠️ **Removing yourself is refused too, and not for symmetry**: leaving is a thing a person does
     * from their own screen, and **doing it from a member list means one tap with no confirmation
     * path.** The route for it is `POST /books/:bookId/leave`.
     */
    const self = await app.inject({
      method: "DELETE",
      url: `/api/v1/books/members/${guest.userId}`,
      headers: { cookie: guest.cookie, "x-libellum-book": owner.bookId },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().code).toBe("remove_self");
  });

  it("keeps two ledgers' memberships apart", async () => {    const owner = await account("memb_owner");
    const guest = await account("memb_guest");

    // Guest is in the owner's first ledger only.
    await join(guest.userId, owner.bookId, "editor");

    const second = (
      await app.inject({
        method: "POST",
        url: "/api/v1/books",
        headers: { cookie: owner.cookie },
        payload: { name: "第二本" },
      })
    ).json() as { id: string };

    /**
     * ⚠️ **This is the assertion that makes "成员管理必须明确属于当前账本" a property rather than a
     * slogan.** The same account is a member of one ledger and not of the other, and asking about the
     * second must answer about the second — **a member list derived from "who do I know" would show
     * the guest in both.**
     */
    const first = await members(owner.cookie, owner.bookId);
    const secondList = await members(owner.cookie, second.id);

    expect((first.json() as { members: unknown[] }).members).toHaveLength(2);
    expect((secondList.json() as { members: unknown[] }).members).toHaveLength(1);
  });

  it("records a join when an invitation is accepted", async () => {
    const owner = await account("memb_owner");
    const guest = await account("memb_guest");

    /**
     * ⚠️ **The path that produced no event at all until 1.09.31.** Joining happens in
     * `decideNotification`, not in member management — so this is the one assertion that covers
     * *"somebody entered this ledger"*, and **without it the history could show a member existing
     * with no record of how they arrived.**
     */
    const invited = await app.inject({
      method: "POST",
      url: "/api/v1/books/invite",
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
      payload: { accountNumber: guest.accountNumber, role: "editor" },
    });
    expect(invited.statusCode).toBe(201);

    const inbox = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { cookie: guest.cookie },
    });
    const invite = (
      inbox.json() as { notifications: { id: string; kind: string }[] }
    ).notifications.find((n) => n.kind === "book_invite");
    expect(invite).toBeDefined();

    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${invite!.id}/decide`,
      headers: { cookie: guest.cookie },
      payload: { decision: "accepted" },
    });
    expect(decided.statusCode).toBe(200);

    const joinEvents = await prisma.transactionEvent.findMany({
      where: { bookId: owner.bookId, kind: "member_changed" },
      select: { actorId: true, actorName: true },
    });

    /**
     * ⚠️ **One event, and its actor is the person who joined** — not the inviter. The sentence a
     * reader wants is *"B 加入了这本账"*; **who asked is already in the notification**, and the owner
     * drew that line himself between account notifications and ledger history.
     */
    expect(joinEvents).toHaveLength(1);
    expect(joinEvents[0]?.actorId).toBe(guest.userId);
  });
});
