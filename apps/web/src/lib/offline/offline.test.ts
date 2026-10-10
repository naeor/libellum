import { describe, expect, it } from "vitest";

import { decideAuthOutcome } from "../../auth/AuthProvider.js";
import { shouldPersistQuery } from "./cache.js";
import { canRegisterWorker } from "./worker.js";

/**
 * The two decisions in the offline layer that a wrong answer makes the program
 * useless rather than merely wrong.
 *
 * Both are pure functions of one value, which is why they were pulled out of the
 * components that use them: the DOM is not needed to check a rule about status
 * codes, and testing them through a render would test the renderer as much as the
 * rule.
 */
describe("decideAuthOutcome", () => {
  it("keeps the user when the server could not be reached", () => {
    // ⚠️ The bug this rule was written for. Opening the app offline failed
    // `GET /auth/me`, and any failure used to mean "signed out" — so the user lost
    // their cached ledger and could not log back in either, because logging in
    // needs a network.
    expect(decideAuthOutcome(null)).toBe("remembered");
  });

  it("keeps the user when the status is not an answer about the session", () => {
    // 500: the server is unwell, which says nothing about who is signed in.
    expect(decideAuthOutcome(500)).toBe("remembered");
    // 0: `apiFetch` uses this for "offline" and for "timed out".
    expect(decideAuthOutcome(0)).toBe("remembered");
    // 403: this app uses it for "you may not touch that book", not for a dead
    // session, and signing somebody out over one would be a different bug.
    expect(decideAuthOutcome(403)).toBe("remembered");
  });

  it("signs the user out only when the server says the session is gone", () => {
    // 401 is the server answering, and its answer is "not you, not any more".
    expect(decideAuthOutcome(401)).toBe("signed-out");
  });
});

describe("shouldPersistQuery", () => {
  /** The slice of a `Query` this rule looks at. */
  function query(meta?: Record<string, unknown>): Parameters<typeof shouldPersistQuery>[0] {
    return { meta } as unknown as Parameters<typeof shouldPersistQuery>[0];
  }

  it("keeps an ordinary query", () => {
    expect(shouldPersistQuery(query())).toBe(true);
    expect(shouldPersistQuery(query({}))).toBe(true);
    expect(shouldPersistQuery(query({ somethingElse: 1 }))).toBe(true);
  });

  it("drops a query marked volatile", () => {
    // A question asked once, about fields the user is still editing. Answering it
    // from yesterday's cache would be answering a different question.
    expect(shouldPersistQuery(query({ volatile: true }))).toBe(false);
  });

  it("treats `volatile: false` as ordinary", () => {
    // Written out rather than omitted: somebody who says `false` means it.
    expect(shouldPersistQuery(query({ volatile: false }))).toBe(true);
  });
});

describe("canRegisterWorker", () => {
  it("says no when this browser has no service worker support", () => {
    // The node test environment has neither `navigator.serviceWorker` nor a
    // secure context, which is the honest answer for it: no worker.
    expect(canRegisterWorker()).toBe(false);
  });
});
