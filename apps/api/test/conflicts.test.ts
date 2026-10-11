import { describe, expect, it } from "vitest";

import { appendHistory, judge, valuesSeen, HISTORY_LIMIT } from "../src/lib/conflicts.js";

/**
 * ⚠️ **The whole conflict rule, and the owner set it in one sentence**:
 *
 * > "只有在服务器的数值是 C，而某台设备上传的请求是把数字从 A 改成 B 时才会触发冲突机制——
 * > 换句话说，某台设备上记录的原数值以及修改后数值跟服务器当前记录的数值不同时才有必要触发冲突."
 *
 * **And its corollary is what keeps the mark meaningful**:
 *
 * > "如果这个金额正好是服务器历史记录中的金额…那不用提醒用户，直接把本地的金额从 A 变成 B."
 *
 * **The tests below are the decision table, one case per line of it.** They matter because every mistake here is
 * silent: accepting when it should have asked silently discards one device's edit, and asking when it should have
 * accepted turns every offline edit into a question — **which is exactly what the owner hit before this rule
 * existed.**
 */

describe("deciding what to do about one field", () => {
  it("⚠️ accepts when the device started from the value the server holds", () => {
    // The ordinary case, and the reason an online device can never conflict: it is editing what it just saw.
    expect(judge("amountCents", 30, 50, 30, 1, 1)).toEqual({ kind: "accept" });
  });

  it("⚠️ accepts a whole chain when the base is still the server's value", () => {
    // His example: the tablet went 30 -> 40 -> 50 while offline, and the server still holds 30.
    // **The whole chain arrives, the first link is the base, and the last link is what he wants.**
    expect(judge("amountCents", 30, 50, 30, 1, 1)).toEqual({ kind: "accept" });
  });

  it("⚠️ does nothing when the server already holds what the device wants", () => {
    // "如果设备上传的请求是把数值 A 改成数值 C，那服务器不用改，直接改设备上记的数就行."
    expect(judge("amountCents", 30, 50, 50, 1, 2)).toEqual({ kind: "server-wins" });
  });

  it("⚠️ lets the server win when the device's base is a value the server has held", () => {
    // "如果这个金额正好是服务器历史记录中的金额…那不用提醒用户，直接把本地的金额从 A 变成 B."
    // The device sat at 30 while the server moved 30 -> 40 -> 60. Falling behind is not disagreeing.
    // ⚠️ **The server moved to 60, but this device was editing from 30 and 30 is still what it sees** — the\n    // entry advanced through another field, or the amount changed and came back. **Behind, not disagreeing.**\n    expect(judge("amountCents", 30, 50, 30, 1, 3)).toEqual({ kind: "server-wins" });
  });

  it("⚠️ raises a conflict when two decisions came from one starting point", () => {
    // The tablet saw 30 and asked for 50; the phone saw 30 and asked for 60, and got there first.
    expect(judge("amountCents", 30, 50, 60, 1, 2)).toEqual({
      kind: "conflict",
      serverValue: 60,
    });
  });

  it("⚠️ raises a conflict for a value the server has never held", () => {
    // "只有在本地的金额是 D，不在服务器里这个金额的历史数据时才标黄等用户权衡."
    expect(judge("amountCents", 99, 50, 60, 1, 2)).toEqual({
      kind: "conflict",
      serverValue: 60,
    });
  });

  it("⚠️ does not care that the two values differ when the base is current", () => {
    // The trap this whole rule exists to avoid: "the values differ" is true of every offline edit ever made.
    expect(judge("note", "原备注", "我改的备注", "原备注", 1, 1).kind).toBe("accept");
  });

  it("compares tags as sets rather than as sequences", () => {
    // Re-ordered tags are the same tags; a conflict about nothing wastes the user's attention.
    expect(judge("tagIds", ["a", "b"], ["a"], ["b", "a"], 1, 2)).toEqual({ kind: "server-wins" });
  });

  it("treats a null note as a value like any other", () => {
    // Clearing a note is a real edit, and "null vs empty string" must not read as a disagreement.
    expect(judge("note", null, "写了点东西", null, 1, 1)).toEqual({ kind: "accept" });
  });
});

describe("the value history", () => {
  it("reconstructs every value a field has held", () => {
    const history = [
      { version: 1, values: { amountCents: 30 } },
      { version: 2, values: { amountCents: 40, note: "顺手改了备注" } },
    ];

    expect(valuesSeen(history, "amountCents", 60)).toEqual([30, 40, 60]);
  });

  it("only reports the values a field actually had", () => {
    // A step that changed the note says nothing about the amount — and must not invent a value for it.
    const history = [
      { version: 1, values: { amountCents: 30 } },
      { version: 2, values: { note: "只改了备注" } },
    ];

    expect(valuesSeen(history, "amountCents", 60)).toEqual([30, 60]);
  });

  it(`keeps the newest ${String(HISTORY_LIMIT)} values`, () => {
    // "20 个历史值。我不觉得会有人闲的没事，连续改 20 次账单."
    let history: readonly unknown[] = [];

    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
      history = appendHistory(history, index + 1, { amountCents: index }, undefined);
    }

    expect(history).toHaveLength(HISTORY_LIMIT);
  });

  it("drops the oldest values first", () => {
    let history: readonly unknown[] = [];

    for (let index = 0; index < HISTORY_LIMIT + 3; index += 1) {
      history = appendHistory(history, index + 1, { amountCents: index }, undefined);
    }

    /** ⚠️ The newest survive — the limit exists to bound growth, not to forget what just happened. */
    const first = history[0] as { values: { amountCents: number } };

    expect(first.values.amountCents).toBe(3);
  });

  it("records which device made each change", () => {
    // ⚠️ The owner asked for this by name: "最好还能记录冲突是哪两台设备传上来的."
    const history = appendHistory([], 1, { amountCents: 30 }, "tablet-abc");

    expect(history[0]).toMatchObject({ version: 1, deviceId: "tablet-abc" });
  });
});
