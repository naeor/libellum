import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ⚠️ **The scope is what stops one account's offline copy being read as another's**, so these
 * tests are about the failure the owner named: *"同一台设备上还可能切换不同账号。如果只有
 * bookId，缓存读取、退出登录和身份失效时仍可能出现数据暴露或混用风险."*
 *
 * The storage layer is mocked because what is being tested is **which key** a value is filed
 * under, not IndexedDB itself. A test that needed a real database to check a string prefix would
 * be testing the browser.
 */
const store = new Map<string, unknown>();

vi.mock("./storage.js", () => ({
  readValue: async (key: string) => store.get(key) ?? null,
  writeValue: async (key: string, value: unknown) => {
    store.set(key, value);
    return true;
  },
}));

const { clearOfflineScope, migrateUnscopedKeys, offlineScope, scopedKey, setOfflineAccount, setOfflineBook, setOfflineScope } =
  await import("./scope.js");

describe("offline scope", () => {
  beforeEach(() => {
    store.clear();
    clearOfflineScope();
  });

  it("files nothing under a scope until both halves are known", () => {
    /**
     * ⚠️ **This is the test that matters most.** A scope built from a ledger alone would look
     * perfectly valid — `:book-1`, say — and isolate nothing: the key would be stable across
     * accounts, so **somebody signing in as a different person would read the previous person's
     * copy**. Half a scope is worse than none, because none is visible in the key.
     */
    setOfflineBook("book-1");
    expect(offlineScope()).toBe("");
    expect(scopedKey("ledger-months")).toBe("ledger-months");

    setOfflineAccount("user-1");
    expect(offlineScope()).toBe("user-1:book-1");
    expect(scopedKey("ledger-months")).toBe("ledger-months:user-1:book-1");
  });

  it("keeps two accounts on one device apart", () => {
    setOfflineScope("user-a", "book-1");
    const forA = scopedKey("ledger-months");

    setOfflineScope("user-b", "book-1");
    const forB = scopedKey("ledger-months");

    expect(forA).not.toBe(forB);
    expect(forA).toContain("user-a");
    expect(forB).toContain("user-b");
  });

  it("keeps two ledgers of one account apart", () => {
    setOfflineScope("user-a", "book-1");
    const first = scopedKey("ledger-marks");

    setOfflineScope("user-a", "book-2");
    const second = scopedKey("ledger-marks");

    expect(first).not.toBe(second);
  });

  it("collapses the scope on sign-out", () => {
    setOfflineScope("user-a", "book-1");
    clearOfflineScope();

    /**
     * ⚠️ Back to the unscoped key rather than to a key belonging to nobody. The unscoped key is
     * where pre-scope data lives, so this also keeps the migration's source reachable.
     */
    expect(offlineScope()).toBe("");
    expect(scopedKey("ledger-months")).toBe("ledger-months");
  });

  it("moves the pre-scope copy into the scope, and does not delete the old one", async () => {
    store.set("ledger-months", { "2026-10": ["an entry"] });
    setOfflineScope("user-1", "book-1");

    expect(await migrateUnscopedKeys(["ledger-months"])).toBe(1);

    expect(store.get("ledger-months:user-1:book-1")).toEqual({ "2026-10": ["an entry"] });
    /**
     * ⚠️ **The old key stays.** If this ever runs with the wrong scope — a first request that
     * arrives before the ledger is known — the data is still there to be moved again. **A
     * "cleanup" that removes the fallback is a cleanup that can lose the only copy.**
     */
    expect(store.get("ledger-months")).toEqual({ "2026-10": ["an entry"] });
  });

  it("does not overwrite a scoped copy that already exists", async () => {
    store.set("ledger-months", { "2026-10": ["old"] });
    store.set("ledger-months:user-1:book-1", { "2026-10": ["current"] });
    setOfflineScope("user-1", "book-1");

    expect(await migrateUnscopedKeys(["ledger-months"])).toBe(0);
    expect(store.get("ledger-months:user-1:book-1")).toEqual({ "2026-10": ["current"] });
  });

  it("moves nothing when no scope is set", async () => {
    store.set("ledger-months", { "2026-10": [] });

    /**
     * ⚠️ Without this guard the migration would copy the legacy value onto **the same key**,
     * which is harmless but pointless — and worse, it would report having migrated something when
     * nothing had a destination yet.
     */
    expect(await migrateUnscopedKeys(["ledger-months"])).toBe(0);
  });
});
