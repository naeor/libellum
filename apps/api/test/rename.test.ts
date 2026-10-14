import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * **Renaming a ledger, and the two things that make it safe.**
 *
 * ⚠️ **This route did not exist until 1.10.08.** The owner asked for it as part of the start page's
 * per-ledger management panel, and attached a condition in the same message:
 *
 * > *"仅对现有权限模型允许修改账本名称的用户开放……不允许无权限用户绕过前端限制修改账本."*
 * > *"如果项目目前没有正式的重命名能力，不要擅自设计未经确认的后端权限规则。先核实现有模型，说明缺失部分."*
 *
 * So the rule is `requireBookForWrite` — **the model that already exists** — and these tests are here
 * because *"the front end hides it"* is not a permission check.
 *
 * ⚠️ **The second thing is specific to this route and is why it has its own file**: it is the one
 * endpoint where **the ledger in the path and the ledger in the header can disagree**, and the whole
 * point of the management panel is that tapping a gear must act on *that* ledger. A mismatch has to
 * change nothing at all.
 */
describe("renaming a ledger", () => {
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
      select: { id: true },
    });
    return { cookie, userId: user.id };
  }

  async function ownBook(cookie: string): Promise<string> {
    const response = await app.inject({ method: "GET", url: "/api/v1/ledger", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return (response.json() as { book: { id: string } }).book.id;
  }

  function rename(cookie: string, pathBookId: string, headerBookId: string, name: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/books/${pathBookId}`,
      headers: { cookie, "x-libellum-book": headerBookId },
      payload: { name },
    });
  }

  it("renames a ledger the caller may write in", async () => {
    const alice = await account("ren_alice");
    const bookId = await ownBook(alice.cookie);

    const response = await rename(alice.cookie, bookId, bookId, "家庭账本");
    expect(response.statusCode).toBe(200);
    expect((response.json() as { book: { name: string } }).book.name).toBe("家庭账本");

    const stored = await prisma.book.findUniqueOrThrow({ where: { id: bookId }, select: { name: true } });
    expect(stored.name).toBe("家庭账本");
  });

  it("trims the name, and refuses one that is empty or too long", async () => {
    const alice = await account("ren_alice");
    const bookId = await ownBook(alice.cookie);

    const trimmed = await rename(alice.cookie, bookId, bookId, "  共享账本  ");
    expect((trimmed.json() as { book: { name: string } }).book.name).toBe("共享账本");

    /**
     * ⚠️ **The bounds are creation's bounds, deliberately.** A name that is legal to create and
     * illegal to rename is a rule that reads as a bug. Creation is `trim().min(1).max(40)`.
     */
    const empty = await rename(alice.cookie, bookId, bookId, "   ");
    expect(empty.statusCode).toBe(400);

    const tooLong = await rename(alice.cookie, bookId, bookId, "账".repeat(41));
    expect(tooLong.statusCode).toBe(400);

    const atLimit = await rename(alice.cookie, bookId, bookId, "账".repeat(40));
    expect(atLimit.statusCode).toBe(200);
  });

  it("refuses a viewer, and says so from the server", async () => {
    /**
     * ⚠️ **Renaming changes what everybody in the ledger sees, so it is a write.** A viewer is
     * refused by the server — *"不允许无权限用户绕过前端限制修改账本"* — and the name is untouched.
     */
    const alice = await account("ren_alice");
    const bob = await account("ren_bob");
    const bookId = await ownBook(alice.cookie);

    const invited = await app.inject({
      method: "POST",
      url: "/api/v1/books/invite",
      headers: { cookie: alice.cookie, "x-libellum-book": bookId },
      payload: { username: "ren_bob", role: "viewer" },
    });
    const notificationId = (invited.json() as { notificationId: string }).notificationId;

    await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${notificationId}/decide`,
      headers: { cookie: bob.cookie },
      payload: { decision: "accepted" },
    });

    const attempt = await rename(bob.cookie, bookId, bookId, "我改的");
    expect(attempt.statusCode).toBe(403);

    const stored = await prisma.book.findUniqueOrThrow({ where: { id: bookId }, select: { name: true } });
    expect(stored.name).not.toBe("我改的");
  });

  it("lets an editor rename, because that is the existing model", async () => {
    /**
     * ⚠️ **Not creator-only, and this asserts the decision rather than leaving it implicit.**
     * Disposing is creator-only because it affects everybody and cannot be undone from inside; a
     * name is cosmetic, reversible, and recorded in the ledger's own history. **Tying it to the
     * creator would strand a ledger whose creator has gone quiet.**
     */
    const alice = await account("ren_alice");
    const bob = await account("ren_bob");
    const bookId = await ownBook(alice.cookie);

    const invited = await app.inject({
      method: "POST",
      url: "/api/v1/books/invite",
      headers: { cookie: alice.cookie, "x-libellum-book": bookId },
      payload: { username: "ren_bob", role: "editor" },
    });
    const notificationId = (invited.json() as { notificationId: string }).notificationId;

    await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${notificationId}/decide`,
      headers: { cookie: bob.cookie },
      payload: { decision: "accepted" },
    });

    expect((await rename(bob.cookie, bookId, bookId, "一起记")).statusCode).toBe(200);
  });

  it("refuses when the path and the header name different ledgers, and changes nothing", async () => {
    /**
     * ⚠️ **⚠️ The rule that makes the gear panel safe.**
     *
     * The panel acts on the ledger whose gear was tapped, which is **not** necessarily the current
     * one. This route takes its ledger from the path and its permission from the header, so the two
     * can disagree — and if they do, **the only safe outcome is that nothing happens.** Otherwise a
     * client able to write in A could rename B by naming B in the path, or rename A while appearing
     * to act on B.
     */
    const alice = await account("ren_alice");
    const bookA = await ownBook(alice.cookie);

    // A second ledger, so there are two the caller may write in.
    // ⚠️ `POST /books` returns the book itself, not a wrapper — and it also *enters* the new ledger,
    // which is why the header below has to stay on the first one explicitly.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/books",
      headers: { cookie: alice.cookie },
      payload: { name: "第二本" },
    });
    expect(created.statusCode).toBe(201);
    const bookB = (created.json() as { id: string }).id;
    expect(bookB).not.toBe(bookA);

    const mismatched = await rename(alice.cookie, bookB, bookA, "改名试试");
    expect(mismatched.statusCode).toBe(400);
    expect((mismatched.json() as { code: string }).code).toBe("book_mismatch");

    /** ⚠️ **Neither ledger moved** — the refusal is not a partial success. */
    const [a, b] = await Promise.all([
      prisma.book.findUniqueOrThrow({ where: { id: bookA }, select: { name: true } }),
      prisma.book.findUniqueOrThrow({ where: { id: bookB }, select: { name: true } }),
    ]);
    expect(a.name).toBe("我的账本");
    expect(b.name).toBe("第二本");
  });

  it("refuses a ledger the caller is not a member of at all", async () => {
    const alice = await account("ren_alice");
    const mallory = await account("ren_mallory");
    const bookId = await ownBook(alice.cookie);

    /** Mallory names Alice's ledger in the header too — so the refusal is membership, not mismatch. */
    const attempt = await rename(mallory.cookie, bookId, bookId, "我的了");
    expect(attempt.statusCode).toBe(403);

    const stored = await prisma.book.findUniqueOrThrow({ where: { id: bookId }, select: { name: true } });
    expect(stored.name).toBe("我的账本");
  });

  it("records the rename in the ledger's own history, naming both ends", async () => {
    /**
     * ⚠️ **The history sentence has to make sense for a ledger-level event.** Every event before this
     * one was about an entry, so the subject line fell back to *"一笔账目"* — which reads as
     * *"naeor 变更了这本账 一笔账目"*. The route writes `book_changed` and `history.ts` names the
     * ledger instead.
     */
    const alice = await account("ren_alice");
    const bookId = await ownBook(alice.cookie);

    await rename(alice.cookie, bookId, bookId, "家庭账本");

    const history = await app.inject({
      method: "GET",
      url: "/api/v1/ledger/history?limit=5",
      headers: { cookie: alice.cookie, "x-libellum-book": bookId },
    });
    expect(history.statusCode).toBe(200);

    const entries = (history.json() as {
      entries: { kind: string; summary: string; changes: { label: string; from: string; to: string }[] }[];
    }).entries;

    const renamed = entries.find((entry) => entry.kind === "book_changed");
    expect(renamed).toBeDefined();
    /**
     * ⚠️ **The sentence is asserted in full, and that is the repair.** The first version of this test
     * checked "contains 这本账" and "does not contain 一笔账目" — both of which passed while the real
     * output was **"naeor 变更了这本账 这本账"**, with the noun twice. **A substring check on a sentence
     * tests the words you thought of, not the sentence.** The live smoke test read it out and caught it.
     */
    expect(renamed?.summary).toBe("ren_alice 改了 这本账");
    expect(renamed?.changes).toEqual([{ label: "名称", from: "我的账本", to: "家庭账本" }]);
  });
});
