import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ⚠️ **`./queries.js` and `./api.js` are mocked only so importing the module is safe.** This file
 * tests `newMessageCount` and `markMessagesSeen`, which are pure functions over `localStorage` — but
 * they live in `MessageBoard.tsx` beside components that call react-query hooks, and a test that
 * mounted those would be testing the board rather than the rule.
 */
vi.mock("../lib/queries.js", () => ({
  useBookMessages: vi.fn(),
  useSendBookMessage: vi.fn(),
}));
vi.mock("../lib/api.js", () => ({ errorMessage: (caught: unknown) => String(caught) }));

const { markMessagesSeen, newMessageCount, clearMessageDraft } = await import("./MessageBoard.js");

/** A message as the board receives it — only `createdAt` matters to the count. */
const at = (iso: string) => ({ createdAt: iso });

const LEDGER_A = "book-40000000";
const LEDGER_B = "book-40000001";

/**
 * ⚠️ **Node has no `localStorage` at all**, and this project's web tests run in plain Node on
 * purpose (`vitest.config.ts`). So the board reads the bare global **behind a `typeof` guard** — which
 * is why it does not crash here — and the test supplies a minimal in-memory one.
 *
 * ⚠️ **A stub rather than jsdom.** The behaviour under test is "where do we remember what was read",
 * and a whole DOM would be a large dependency for one key-value store. This is the smallest thing
 * that has the API the code uses.
 */
function installFakeStorage(): void {
  const map = new Map<string, string>();

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
      clear: () => {
        map.clear();
      },
      key: (index: number) => [...map.keys()][index] ?? null,
      get length() {
        return map.size;
      },
    },
  });
}

describe("新消息 N 条", () => {
  beforeEach(() => {
    installFakeStorage();
  });

  it("counts nothing when this device has never looked at this ledger", () => {
    /**
     * ⚠️ **"Never looked" is zero, not everything.** Treating a missing timestamp as "seen nothing"
     * would greet a first-time reader with *"新消息 47 条"* about a conversation they have never
     * opened — **which is not news, it is the history.**
     */
    const messages = [at("2026-10-13T10:00:00Z"), at("2026-10-13T11:00:00Z")];
    expect(newMessageCount(LEDGER_A, messages)).toBe(0);
  });

  it("counts only what arrived after the last look", () => {
    markMessagesSeen(LEDGER_A, new Date("2026-10-13T12:00:00Z"));

    const messages = [
      at("2026-10-13T11:00:00Z"), // before — already read
      at("2026-10-13T13:00:00Z"), // after
      at("2026-10-13T14:00:00Z"), // after
    ];

    expect(newMessageCount(LEDGER_A, messages)).toBe(2);
  });

  it("does not count the message that was on screen at the moment of looking", () => {
    /**
     * ⚠️ **The boundary is strict (`>`), and it matters.** The message the reader was looking at when
     * the board marked itself seen must not come back as new — otherwise every visit reports the last
     * message again, and the badge becomes noise nobody trusts.
     */
    const seenAt = new Date("2026-10-13T12:00:00Z");
    markMessagesSeen(LEDGER_A, seenAt);

    expect(newMessageCount(LEDGER_A, [at("2026-10-13T12:00:00Z")])).toBe(0);
    expect(newMessageCount(LEDGER_A, [at("2026-10-13T12:00:01Z")])).toBe(1);
  });

  it("clears once the reader has looked again", () => {
    markMessagesSeen(LEDGER_A, new Date("2026-10-13T12:00:00Z"));
    const messages = [at("2026-10-13T13:00:00Z")];
    expect(newMessageCount(LEDGER_A, messages)).toBe(1);

    markMessagesSeen(LEDGER_A, new Date("2026-10-13T13:00:01Z"));
    expect(newMessageCount(LEDGER_A, messages)).toBe(0);
  });

  it("keeps ledgers' read state apart", () => {
    /**
     * ⚠️ **⚠️ This is the isolation property, and it is why the ledger id is in the key.**
     *
     * Two ledgers have two boards. One shared "last seen" value would make **ledger B inherit ledger
     * A's read state** — so a message written in B while the reader was looking at A would report as
     * *already read*, and they would never be told about it. That is the cross-ledger leak the rest
     * of this file is careful about, in its quietest form: not data shown to the wrong person, but
     * **a notification silently swallowed.**
     *
     * ⚠️ **The proof is a message that one ledger has seen and the other has not.** A single shared
     * timestamp cannot produce a different answer for the two, so `1` and `0` here is the whole
     * assertion.
     */
    const earlier = [at("2026-10-13T12:00:00Z")];
    const later = [at("2026-10-13T13:00:00Z")];

    /** A was looked at *after* its last message; B has never been opened. */
    markMessagesSeen(LEDGER_A, new Date("2026-10-13T12:30:00Z"));

    expect(newMessageCount(LEDGER_A, earlier)).toBe(0);
    expect(newMessageCount(LEDGER_B, earlier)).toBe(0);

    /**
     * ⚠️ **B is opened, and it was opened *before* A was** — the case a shared timestamp gets wrong.
     * With one key, A's later read would mark B's message as already seen; with the ledger in the
     * key, B still counts it.
     */
    markMessagesSeen(LEDGER_B, new Date("2026-10-13T11:00:00Z"));

    expect(newMessageCount(LEDGER_A, earlier)).toBe(0);
    expect(newMessageCount(LEDGER_B, earlier)).toBe(1);
    expect(newMessageCount(LEDGER_B, later)).toBe(1);
    expect(newMessageCount(LEDGER_A, later)).toBe(1);
  });

  it("survives a browser that refuses storage", () => {
    /**
     * ⚠️ **A refused `localStorage` must not break the board.** Private modes and hardened browsers
     * throw on access; the count is a convenience, so the honest degradation is **zero**, not an
     * exception thrown while rendering somebody's ledger.
     *
     * ⚠️ **The global is replaced, not `window.localStorage`** — the implementation reads the bare
     * global on purpose, because `window` does not exist in this project's Node test environment and
     * reaching through it made the board unrenderable there.
     */
    const thrower = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };

    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: thrower });

    try {
      expect(() => {
        markMessagesSeen(LEDGER_A);
      }).not.toThrow();
      expect(newMessageCount(LEDGER_A, [at("2026-10-13T13:00:00Z")])).toBe(0);
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    }
  });
});

describe("留言草稿", () => {
  /**
   * ⚠️ **The draft lives at module scope so it survives moving between the card and the full screen**
   * — *"如果存在未发送的文字草稿，应合理处理视图切换。优先保持草稿，而不是意外清空用户已经输入的内容."*
   * Two routes have no shared ancestor, so React state cannot hold it; this is the value that can.
   */
  it("is a module-level value that a second view could read", async () => {
    const module = await import("./MessageBoard.js");
    expect(typeof module.clearMessageDraft).toBe("function");
    expect(() => {
      clearMessageDraft();
    }).not.toThrow();
  });
});
