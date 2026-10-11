import { describe, expect, it } from "vitest";

import type { OutboxOp, OutboxRow } from "./outbox.js";

/**
 * ⚠️ **The rules that keep the queue about *intent* rather than about history.**
 *
 * The owner may edit the same entry three times on a train. A log of operations would replay all three
 * and ask the server to perform three writes; what he wants is the last version. So one row per entry,
 * holding its intended final state — and the three rules below are what make that correct rather than
 * merely shorter.
 *
 * These test the decision function, extracted so the reasoning can be checked without a browser: the
 * rule is about which verb the server sees, and getting it wrong produces a queue that retries for
 * ever or an edit that silently disappears.
 */

/** The verb a queue row should carry, given what was already queued for that entry. */
function opFor(existing: OutboxOp | undefined, incoming: OutboxOp): OutboxOp {
  /**
   * ⚠️ **A create stays a create through later edits.**
   *
   * The server has never seen that id, so an `update` would 404 for ever. The first interaction with
   * the server decides the verb.
   */
  return existing === "create" ? "create" : incoming;
}

/** Whether an incoming change cancels the queued one entirely. */
function cancels(existing: OutboxOp | undefined, incoming: OutboxOp): boolean {
  /**
   * ⚠️ **A create that is then deleted never happened.**
   *
   * The server has never heard of the id, so `DELETE /transactions/:id` would 404 — a permanent
   * failure sitting at the head of the queue, retried until the retry limit.
   */
  return existing === "create" && incoming === "delete";
}

/** Which `baseVersion` a merged row keeps. */
function baseVersionFor(
  existing: Pick<OutboxRow, "op" | "baseVersion"> | undefined,
  incoming: number | null,
): number | null {
  if (existing === undefined) return incoming;
  if (existing.op === "create") return null;

  /**
   * ⚠️ **The earlier value wins.**
   *
   * The optimistic lock is about what this device *started from*, not about the most recent edit. If a
   * second edit replaced it with the version the device now holds — which it produced itself — the
   * server would be asked to accept a change based on a version nobody else ever confirmed, and **two
   * edits would collapse into one silent overwrite.**
   */
  return existing.baseVersion;
}

describe("what the queue stores", () => {
  it("keeps a create as a create when the entry is edited afterwards", () => {
    // Otherwise the server is asked to update an id it has never seen, and 404s for ever.
    expect(opFor("create", "update")).toBe("create");
  });

  it("lets a later delete of a synced entry be a delete", () => {
    expect(opFor("update", "delete")).toBe("delete");
    expect(opFor(undefined, "delete")).toBe("delete");
  });

  it("turns a create-then-delete into nothing at all", () => {
    // The entry never reached the server, so there is nothing to delete and a delete would 404.
    expect(cancels("create", "delete")).toBe(true);
  });

  it("does not cancel a delete of something the server already has", () => {
    expect(cancels("update", "delete")).toBe(false);
    expect(cancels(undefined, "delete")).toBe(false);
  });

  it("keeps the version the device started from, not the one it just made", () => {
    // v5 is what the device saw when it went offline. A first edit sends v5; a second edit must still
    // send v5, even though the device's own copy now says v6.
    const first = baseVersionFor(undefined, 5);

    expect(first).toBe(5);
    expect(baseVersionFor({ op: "update", baseVersion: 5 }, 6)).toBe(5);
  });

  it("sends no version for a create, which has none", () => {
    expect(baseVersionFor({ op: "create", baseVersion: null }, null)).toBeNull();
  });
});
