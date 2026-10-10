import { describe, expect, it } from "vitest";

import {
  INVITE_REJECTION_CODE,
  INVITE_REJECTION_MESSAGE,
  INVITE_VALID_DAYS,
  INVITE_VALID_MS,
  rejectInvite,
} from "./invites.js";

/**
 * When a registration code stops working, and what to say about it.
 *
 * The owner asked for two things on 2026-10-10: ordinary codes live **seven
 * days**, and any code can be **revoked** before it is used. Both exist because a
 * code travels through a chat window — its useful life is days, and the sender
 * needs a way to take it back.
 *
 * The rule is a pure function with `now` as a parameter, which is what makes the
 * boundary testable. "Expires in seven days" is otherwise untestable without
 * either waiting a week or mocking the clock.
 */
const DAY = 24 * 60 * 60 * 1_000;
const NOW = new Date("2026-10-10T12:00:00.000Z");

/** A code that is live right now. */
function invite(overrides: Partial<Parameters<typeof rejectInvite>[0]> = {}) {
  return { usedAt: null, revokedAt: null, expiresAt: null, ...overrides };
}

describe("rejectInvite", () => {
  it("accepts a code that has no expiry and no revocation", () => {
    // The reserved batch: written down and handed out over months, so it has no
    // deadline at all.
    expect(rejectInvite(invite(), NOW)).toBeNull();
  });

  it("accepts a code that has not yet expired", () => {
    const expiresAt = new Date(NOW.getTime() + DAY);

    expect(rejectInvite(invite({ expiresAt }), NOW)).toBeNull();
  });

  it("rejects a code exactly at its expiry instant", () => {
    // `<=`, not `<`. A code whose deadline is *now* is over — the alternative
    // gives the last millisecond a grace period nobody asked for.
    const expiresAt = new Date(NOW.getTime());

    expect(rejectInvite(invite({ expiresAt }), NOW)).toBe("expired");
  });

  it("rejects a code whose expiry has passed", () => {
    const expiresAt = new Date(NOW.getTime() - 1);

    expect(rejectInvite(invite({ expiresAt }), NOW)).toBe("expired");
  });

  it("rejects a code that was revoked", () => {
    // Revocation is a timestamp, so a code withdrawn for a reason can explain
    // itself later.
    expect(rejectInvite(invite({ revokedAt: new Date(NOW.getTime() - DAY) }), NOW)).toBe("revoked");
  });

  it("reports 'used' ahead of every other reason", () => {
    // A code that was used and has since expired should say "used": that is the
    // fact that ends the story, and telling somebody their used code expired
    // sends them looking for a new one they do not need.
    const both = invite({
      usedAt: new Date(NOW.getTime() - 2 * DAY),
      revokedAt: new Date(NOW.getTime() - DAY),
      expiresAt: new Date(NOW.getTime() - DAY),
    });

    expect(rejectInvite(both, NOW)).toBe("used");
  });

  it("reports 'revoked' ahead of 'expired'", () => {
    // Same reasoning: the sender's deliberate act is more useful to know than
    // the clock running out.
    const both = invite({
      revokedAt: new Date(NOW.getTime() - DAY),
      expiresAt: new Date(NOW.getTime() - DAY),
    });

    expect(rejectInvite(both, NOW)).toBe("revoked");
  });
});

describe("the published rules", () => {
  it("give an ordinary code seven days", () => {
    expect(INVITE_VALID_DAYS).toBe(7);
    expect(INVITE_VALID_MS).toBe(7 * DAY);
  });

  it("have a message and a code for every way a code can fail", () => {
    // Both maps are keyed by the same union, so a new rejection reason cannot be
    // added without the interface and the API learning to say something about it.
    for (const reason of ["used", "revoked", "expired"] as const) {
      expect(INVITE_REJECTION_MESSAGE[reason]).toBeTruthy();
      expect(INVITE_REJECTION_CODE[reason]).toMatch(/^invite_/);
    }
  });

  it("never say 'invalid' without saying why", () => {
    // The owner's rule from the "暂无分类" incident: a message that describes the
    // wrong fault is worse than none, because it is believed. "邀请码无效" tells
    // somebody nothing they can act on.
    for (const message of Object.values(INVITE_REJECTION_MESSAGE)) {
      expect(message).not.toContain("无效");
    }
  });
});
