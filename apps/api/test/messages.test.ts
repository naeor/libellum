import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * 账本内的公共留言。
 *
 * ⚠️ **The owner's boundary is narrow and this file tests the boundary, not a chat app**:
 * *"它只属于当前账本……**不提供私人聊天**；不需要复杂的**好友聊天体系**"* and
 * *"**查看者原则上也可以参与文字留言**，因为**交流并不等于修改账目**."*
 *
 * ⚠️ **The viewer case is the one worth having.** Every other assertion here would pass just as well
 * if the routes had used the write guard — **and a viewer silently unable to ask "昨天的菜记了吗"
 * is exactly the bug that guard would cause.**
 */
describe("ledger messages", () => {
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
    const user = await prisma.user.findUniqueOrThrow({ where: { username }, select: { id: true } });
    const membership = await prisma.bookMember.findFirstOrThrow({
      where: { userId: user.id },
      select: { bookId: true },
    });
    return { cookie, userId: user.id, bookId: membership.bookId };
  }

  async function join(userId: string, bookId: string, role: "editor" | "viewer") {
    await prisma.bookMember.upsert({
      where: { bookId_userId: { bookId, userId } },
      create: { bookId, userId, role },
      update: { role, leftAt: null },
    });
  }

  function read(cookie: string, bookId: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/books/messages",
      headers: { cookie, "x-libellum-book": bookId },
    });
  }

  function say(cookie: string, bookId: string, body: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/books/messages",
      headers: { cookie, "x-libellum-book": bookId },
      payload: { body },
    });
  }

  it("refuses a ledger the caller is not a member of", async () => {
    const owner = await account("msg_owner");
    const outsider = await account("msg_outsider");

    expect((await read(outsider.cookie, owner.bookId)).statusCode).toBe(403);
    expect((await say(outsider.cookie, owner.bookId, "你好")).statusCode).toBe(403);
    expect(await prisma.bookMessage.count()).toBe(0);
  });

  it("lets a viewer read and write — talking is not editing", async () => {
    const owner = await account("msg_owner");
    const viewer = await account("msg_viewer");
    await join(viewer.userId, owner.bookId, "viewer");

    /**
     * ⚠️ **This is the owner's sentence, asserted**: *"查看者原则上也可以参与文字留言，
     * 因为交流并不等于修改账目."* A route that had used `requireBookForWrite` would pass every other
     * test in this file and **fail only here** — which is why this one is not optional.
     */
    const posted = await say(viewer.cookie, owner.bookId, "昨天买菜的 86 元是不是还没有记？");
    expect(posted.statusCode).toBe(201);

    const listed = await read(viewer.cookie, owner.bookId);
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { messages: unknown[] }).messages).toHaveLength(1);

    // ⚠️ And the write permission did NOT widen: a viewer still cannot touch entries.
    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: { cookie: viewer.cookie, "x-libellum-book": owner.bookId },
      payload: {},
    });
    /**
     * ⚠️ **403, not 400 — and the difference is the point.** My first version expected the request to
     * fail *validation* (an empty payload), but **the guard runs first**, so a viewer is turned away
     * before anything looks at the body. Asserting 400 would have been asserting the wrong refusal:
     * **"your payload is bad" and "you may not write here" are different sentences.**
     */
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("book_read_only");
  });

  it("keeps two ledgers' boards apart", async () => {
    const owner = await account("msg_owner");
    await say(owner.cookie, owner.bookId, "第一本的话");

    const second = (
      await app.inject({
        method: "POST",
        url: "/api/v1/books",
        headers: { cookie: owner.cookie },
        payload: { name: "第二本" },
      })
    ).json() as { id: string };

    /**
     * ⚠️ **A message belongs to a ledger, not to the account that wrote it.** This is the assertion
     * that keeps *"它只属于当前账本"* a property: **the same person's words do not appear on the other
     * board.**
     */
    const first = await read(owner.cookie, owner.bookId);
    const other = await read(owner.cookie, second.id);

    expect((first.json() as { messages: { body: string }[] }).messages.map((m) => m.body)).toEqual([
      "第一本的话",
    ]);
    expect((other.json() as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("stores the sender's name as it was, not as it is now", async () => {
    const owner = await account("msg_owner");
    await say(owner.cookie, owner.bookId, "这笔房租我已经付过了。");

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: owner.userId },
      select: { displayName: true },
    });
    await prisma.user.update({ where: { id: owner.userId }, data: { displayName: "改了名字" } });

    const listed = await read(owner.cookie, owner.bookId);
    const message = (listed.json() as { messages: { senderName: string }[] }).messages[0];

    /**
     * ⚠️ **The signature does not move when the person is renamed.** A join on read would show "改了名字"
     * against a sentence written months earlier — **renaming yourself would silently rewrite everything
     * you ever said**, which is the same failure `TransactionEvent.actorName` exists to prevent.
     */
    expect(message?.senderName).toBe(user.displayName);
    expect(message?.senderName).not.toBe("改了名字");
  });

  it("refuses an empty or oversized message", async () => {
    const owner = await account("msg_owner");

    /** ⚠️ Whitespace is not a message — the database CHECK says the same thing, one layer down. */
    expect((await say(owner.cookie, owner.bookId, "   ")).statusCode).toBe(400);
    expect((await say(owner.cookie, owner.bookId, "x".repeat(501))).statusCode).toBe(400);
    expect((await say(owner.cookie, owner.bookId, "好")).statusCode).toBe(201);
  });
});
