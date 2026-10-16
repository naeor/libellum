import { describe, expect, it } from "vitest";
import { entryBookId, entryPath } from "./accountEntry.js";

describe("account entry", () => {
  const books = [{ id: "oldest" }, { id: "family" }];
  it("restores the account preference, not the first ledger or local device choice", () => {
    expect(entryBookId("family", books)).toBe("family");
  });
  it.each([null, "deleted", "disposed", "forbidden"])("falls back safely from %s using accessible ledgers only", (last) => {
    expect(entryBookId(last, books)).toBe("oldest");
  });
  it("does not invent a ledger for an account without memberships", () => {
    expect(entryBookId("family", [])).toBeNull();
    expect(entryPath({ pathname: "/", completed: true, bookId: null })).toBe("/start");
  });
  it("opens a new account's presentation until completion", () => {
    expect(entryPath({ pathname: "/", completed: false, bookId: "oldest" })).toBe("/start");
  });
  it.each(["/", "/stats", "/me", "/ledger"])("reopens details rather than the last page %s", (pathname) => {
    expect(entryPath({ pathname, completed: true, bookId: "family" })).toBe("/");
  });
  it.each(["/start", "/start/book/family", "/join/token"])("preserves an explicit destination %s", (pathname) => {
    expect(entryPath({ pathname, completed: true, bookId: "family" })).toBe(pathname);
  });
});
