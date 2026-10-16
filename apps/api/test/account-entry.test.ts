import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cookieFrom, makeApp, prisma, resetDatabase, signUp } from "./support.js";

describe("account entry preferences", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = makeApp(); await resetDatabase(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  const me = async (cookie: string) => {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return response.json().user;
  };

  it("registers new accounts as unfinished without marking authentication as completion", async () => {
    const cookie = await signUp(app, "entry_new");
    expect((await me(cookie)).hasCompletedIntro).toBe(false);
    expect((await me(cookie)).hasCompletedIntro).toBe(false);
  });
  it("persists completion across sessions and keeps it separate from the last ledger", async () => {
    const cookie = await signUp(app, "entry_cross_device");
    const created = await app.inject({ method: "POST", url: "/api/v1/books", headers: { cookie }, payload: { name: "家庭账本" } });
    const book = created.json().id;
    expect((await me(cookie)).hasCompletedIntro).toBe(false);
    for (let i = 0; i < 2; i++) {
      const complete = await app.inject({ method: "POST", url: "/api/v1/auth/presentation/complete", headers: { cookie } });
      expect(complete.statusCode).toBe(200);
      expect(complete.json().user.lastBookId).toBe(book);
    }
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "entry_cross_device", password: "correct-horse-battery" } });
    const second = await me(cookieFrom(login.headers));
    expect(second.hasCompletedIntro).toBe(true);
    expect(second.lastBookId).toBe(book);
  });
  it("does not let another account complete the target user's intro", async () => {
    const first = await signUp(app, "entry_first");
    const second = await signUp(app, "entry_second");
    await app.inject({ method: "POST", url: "/api/v1/auth/presentation/complete", headers: { cookie: second }, payload: { userId: (await me(first)).id } });
    expect((await me(first)).hasCompletedIntro).toBe(false);
    expect((await me(second)).hasCompletedIntro).toBe(true);
  });
  it("rejects unauthenticated completion", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/presentation/complete" })).statusCode).toBe(401);
  });
  it("returns only accessible active books when the preferred one is disposed or membership ended", async () => {
    const cookie = await signUp(app, "entry_fallback");
    const user = await me(cookie);
    const created = await app.inject({ method: "POST", url: "/api/v1/books", headers: { cookie }, payload: { name: "失效账本" } });
    const bookId = created.json().id;
    await prisma.book.update({ where: { id: bookId }, data: { disposedAt: new Date() } });
    let list = await app.inject({ method: "GET", url: "/api/v1/books", headers: { cookie } });
    expect(list.json().books.some((book: { id: string }) => book.id === bookId)).toBe(false);
    await prisma.book.update({ where: { id: bookId }, data: { disposedAt: null } });
    await prisma.bookMember.update({ where: { bookId_userId: { bookId, userId: user.id } }, data: { leftAt: new Date() } });
    list = await app.inject({ method: "GET", url: "/api/v1/books", headers: { cookie } });
    expect(list.json().books.some((book: { id: string }) => book.id === bookId)).toBe(false);
    expect(list.json().books).toHaveLength(1);
  });
});
