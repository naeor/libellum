import { describe, expect, it } from "vitest";

import { appendHistory, judge, valuesSeen, HISTORY_LIMIT } from "../src/lib/conflicts.js";

/**
 * ⚠️ **The whole conflict rule, and the owner set it in one sentence**:
 *
 * > "只有在服务器的数值是 C，而某台设备上传的请求是把数字从 A 改成 B 时才会触发冲突机制."
 *
 * **Four rules, and each test below is one line of the table.** They matter because every mistake here is silent:
 * accepting when it should have asked **discards one device's edit**, and asking when it should have accepted
 * **turns every offline edit into a question.**
 *
 * ⚠️ **There is deliberately no version number anywhere in these tests.** An earlier implementation opened with
 * `baseVersion >= serverVersion → accept`, an idea the owner had already rejected — **and it survived inside the code
 * and disabled the feature**, because a device's version is its own entry's, incremented locally, and it frequently
 * lands on the same number as the server's.
 */

describe("deciding what to do about one field", () => {
  it("rule 1 — accepts when the device started from the value the server holds", () => {
    // The ordinary case, and the reason an online device can never conflict: **it is editing what it just saw.**
    expect(judge("amountCents", 30, 50, 30)).toEqual({ kind: "accept" });
  });

  it("rule 1 — accepts a whole offline chain when the base is still the server's value", () => {
    // His example: the tablet went 30 → 40 → 50 while offline and the server still holds 30.
    // **The whole chain arrives; the first link is the base and the last is what he wants.**
    expect(judge("amountCents", 30, 50, 30)).toEqual({ kind: "accept" });
  });

  it("rule 1 — does not care that the two values differ when the base is current", () => {
    // The trap this rule exists to avoid: "the values differ" is true of **every** offline edit ever made.
    expect(judge("note", "原备注", "我改的备注", "原备注").kind).toBe("accept");
  });

  it("rule 1 — treats a null note as a value like any other", () => {
    // Clearing a note is a real edit, and "null vs empty" must not read as a disagreement.
    expect(judge("note", null, "写了点东西", null)).toEqual({ kind: "accept" });
  });

  it("rule 2 — ⚠️ will not ask about 60 against 60", () => {
    /**
     * ⚠️ **His own example, and the reason this rule is checked before the history**:
     *
     * > "假如服务器上记录的数据是从 40 改到 60，而设备上记录的数据是从 30 改到 60，那么他们的目的一样，当然不能算
     * > ——我想没有哪个程序会弹出一个弹窗让人选择数字是 60 还是 60."
     */
    expect(
      judge("amountCents", 30, 60, 60, [40, 60]),
    ).toEqual({ kind: "server-wins" });
  });

  it("rule 2 — does nothing when the server already holds what the device wants", () => {
    // "如果设备上传的请求是把数值 A 改成数值 C，那服务器不用改，直接改设备上记的数就行."
    expect(judge("amountCents", 30, 50, 50, [30, 50])).toEqual({ kind: "server-wins" });
  });

  it("rule 3 — ⚠️ a device heading for a value the server has held is behind, not opposing", () => {
    /**
     * ⚠️ **His answer for a device that is behind, and his words name the test exactly**:
     *
     * > "如果服务器里记录的是从 30 变成 50 再变成 70，那么 30 和 50 就是历史值——如果本地的数据恰好是 30 或者 50，
     * > 那么在同步时不用判断冲突，直接改为 70."
     *
     * **It is finishing a journey that was already under way**, so the server's value is simply taken.
     */
    expect(judge("amountCents", 30, 50, 70, [30, 50, 70])).toEqual({ kind: "server-wins" });
    expect(judge("amountCents", 50, 30, 70, [30, 50, 70])).toEqual({ kind: "server-wins" });
  });

  it("rule 4 — ⚠️ raises a conflict for a destination the server has never been to", () => {
    /**
     * ⚠️ **His reason, asked directly about a device sitting at 30 that wants 65 while the server is at 70**:
     *
     * > "判冲突，因为设备是想把 30 改成 65，而不是把 30 改成 70；同时 65（最终值）并不在 30，50 这些服务器历史值里，
     * > 所以不能说设备改的 65 是已有的路径（也就是只改了一半）."
     */
    expect(judge("amountCents", 30, 65, 70, [30, 50, 70])).toEqual({
      kind: "conflict",
      serverValue: 70,
    });
  });

  it("rule 4 — raises a conflict when two decisions came from one starting point", () => {
    // The tablet saw 30 and asked for 50; the phone saw 30 and asked for 60, and got there first.
    expect(judge("amountCents", 30, 50, 60, [30, 60])).toEqual({
      kind: "conflict",
      serverValue: 60,
    });
  });

  it("rule 4 — raises a conflict for a base the server has never held", () => {
    // A value chain that drifted away from the server: the device is comparing against a state that never existed.
    expect(judge("amountCents", 99, 50, 60, [30, 60])).toEqual({
      kind: "conflict",
      serverValue: 60,
    });
  });

  it("rule 4 — ⚠️ decides by value, never by a version coincidence", () => {
    /**
     * ⚠️ **The bug that removed conflict detection entirely**: "冲突检测彻底没了…他会默认使用其中一项，一般来说是断网的
     * 修改的数据."
     *
     * Two devices both edited from 30 and reached 50 and 60. **It must be a question, whatever any version says** —
     * and the signature of `judge` no longer has a place to put a version.
     */
    expect(judge("amountCents", 30, 50, 60, [30, 60])).toEqual({
      kind: "conflict",
      serverValue: 60,
    });
  });

  it("compares tags as sets rather than as sequences", () => {
    // Re-ordered tags are the same tags, so the device is editing from exactly what the server holds.
    expect(judge("tagIds", ["a", "b"], ["a"], ["b", "a"])).toEqual({ kind: "accept" });
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

  it("⚠️ includes the value held now, so rule 3 can name the destination", () => {
    /**
     * ⚠️ **Rule 3 asks whether the destination is a value the server has held** — so the list has to contain the one
     * it holds at this moment, or **a device heading for the current value would be asked about it.**
     */
    expect(valuesSeen([{ version: 1, values: { amountCents: 30 } }], "amountCents", 70)).toEqual([30, 70]);
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
