import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ⚠️ **These tests are about one specific, real failure.**
 *
 * The owner signed in as a second account on the same device and **saw his own ledger number on
 * screen** — `40000000`, the book belonging to the account he had just left.
 *
 * The server was not at fault, and this is worth stating because it is the reason the bug was
 * survivable: permission is decided by `book_members`, so every request carrying the stale book id
 * was refused with 403 and **nothing leaked**. What leaked was the *label* — the cached ledger
 * metadata was still on screen, so the next account read as the previous one's ledger.
 *
 * The cause was here: the module remembers which ledger this device is in, in memory **and** on
 * disk, and only `logout()` ever cleared it. A session that ended any other way — expiry, or a
 * `401` on the periodic revalidation — sent the user to the login screen with the previous
 * account's book id still in place. See `forgetCurrentBook` for the fix.
 *
 * The storage layer is mocked because what is being tested is **the lifetime of the value**, not
 * IndexedDB; a test needing a real database to check "is this string null" would be testing the
 * browser.
 */
const store = new Map<string, unknown>();
const snapshot = new Map<string, unknown>();

vi.mock("./offline/storage.js", () => ({
  readValue: async (key: string) => store.get(key) ?? null,
  writeValue: async (key: string, value: unknown) => {
    store.set(key, value);
    return true;
  },
  readSnapshot: <T,>(key: string): T | null => (snapshot.get(key) as T | undefined) ?? null,
}));

const { currentBookId, forgetCurrentBook, setCurrentBook, restoreCurrentBook, subscribeCurrentBook } =
  await import("./currentBook.js");

describe("the remembered ledger", () => {
  beforeEach(() => {
    store.clear();
    snapshot.clear();
    forgetCurrentBook();
    store.clear();
  });

  it("is cleared on sign-out, in memory and on the device", async () => {
    setCurrentBook("book-40000000");
    expect(currentBookId()).toBe("book-40000000");
    expect(store.get("current-book")).toBe("book-40000000");

    forgetCurrentBook();

    /**
     * ⚠️ **Both halves matter, and they fail differently.**
     *
     * Leaving the in-memory copy set is what sends the *next* request to the wrong book — the
     * header is read from this module. Leaving the stored copy set is what makes the bug come
     * back after a reload, which is how it looked intermittent.
     */
    expect(currentBookId()).toBeNull();
    expect(store.get("current-book")).toBeNull();
  });

  it("notifies subscribers on sign-out, so the screen cannot keep showing the old ledger", () => {
    setCurrentBook("book-40000000");

    let notified = 0;
    const unsubscribe = subscribeCurrentBook(() => {
      notified += 1;
    });

    forgetCurrentBook();

    expect(notified).toBeGreaterThan(0);
    unsubscribe();
  });

  it("does not resurrect a cleared ledger from storage", async () => {
    /**
     * ⚠️ **The startup path is the other half of the bug.** `restoreCurrentBook` reads the value
     * back before any request goes out, so a value that was written and then cleared must not
     * come back — otherwise the fix would only hold until the next reload.
     */
    setCurrentBook("book-40000000");
    forgetCurrentBook();

    expect(await restoreCurrentBook()).toBeNull();
    expect(currentBookId()).toBeNull();
  });

  it("still restores a ledger that was remembered for the account in use", async () => {
    // The guard against over-correcting: a normal reload must keep working.
    store.set("current-book", "book-40000001");
    snapshot.set("current-book", "book-40000001");

    expect(await restoreCurrentBook()).toBe("book-40000001");
    expect(currentBookId()).toBe("book-40000001");
  });

  it("ignores an empty stored value rather than adopting it", async () => {
    /**
     * A cleared key can come back as `""` depending on how it was written, and an empty string is
     * not a ledger id. Adopting it would leave the header set to nothing, which reads as "the
     * client declared no ledger" — a different code path from "the client has not chosen yet".
     */
    store.set("current-book", "");
    snapshot.set("current-book", "");

    expect(await restoreCurrentBook()).toBeNull();
    expect(currentBookId()).toBeNull();
  });

  it("resolves once the new ledger is on the device, so a reload cannot read the old one", async () => {
    /**
     * ⚠️ **This is the second real bug, and it is why `setCurrentBook` returns a promise at all.**
     *
     * The owner made a second ledger and **could not enter it** — `enterLedger` ends in
     * `window.location.assign("/")`, and the new document reads this key straight back out of the
     * device. `storage.ts` only mirrors a value to memory *after* the IndexedDB put resolves, so a
     * write that nobody awaited was a real race with the navigation: lose it, and the reload
     * restores the ledger that was just left — which then re-pins itself, and the loop repeats.
     *
     * The assertion is deliberately about **the write having completed**, not about the return
     * type: `store` is only filled by the mocked `writeValue`, and the real one only calls
     * `rememberSnapshot` after its `put` resolves.
     */
    const switchingTo = "book-40000003";
    await setCurrentBook(switchingTo);

    expect(store.get("current-book")).toBe(switchingTo);

    // And the state a fresh document would see.
    snapshot.clear();
    snapshot.set("current-book", store.get("current-book"));
    expect(await restoreCurrentBook()).toBe(switchingTo);
  });

  it("lets the caller switch away from a ledger it is already in", async () => {
    /**
     * The bug's shape in one line: whatever the device last saw wins, so **what was written last
     * has to be what the next reload restores** — not the first value it ever held.
     */
    await setCurrentBook("book-40000001");
    expect(currentBookId()).toBe("book-40000001");

    await setCurrentBook("book-40000003");
    expect(currentBookId()).toBe("book-40000003");
    expect(store.get("current-book")).toBe("book-40000003");
  });
});
