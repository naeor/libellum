import { describe, expect, it } from "vitest";

import { cleanNote, isSpeechless, parseSpokenEntry } from "./speech.js";

/**
 * Turning a spoken sentence into fields.
 *
 * Tested with typed text rather than audio, which is the reason the module is
 * separate from recognition at all: the interesting cases here — a filler at the
 * front, a comma run where something was removed, an amount that appears twice —
 * are all cheap to write down and expensive to reproduce by talking into a phone.
 */
describe("parseSpokenEntry", () => {
  it("reads an amount and keeps the rest as the note", () => {
    const spoken = parseSpokenEntry("午饭 38 块");

    expect(spoken.amount).toBe("38");
    expect(spoken.note).toBe("午饭");
  });

  it("does not repeat the amount inside the note", () => {
    // The amount is a field, not part of the description. Leaving it in the note
    // means the number appears twice, and the copy in the note is the one that
    // goes stale when somebody corrects the amount.
    expect(parseSpokenEntry("打车 25.5 元").note).toBe("打车");
  });

  it("keeps a decimal amount intact", () => {
    expect(parseSpokenEntry("咖啡 18.80").amount).toBe("18.80");
  });

  it("reads an amount with no unit word", () => {
    expect(parseSpokenEntry("买菜 64").amount).toBe("64");
  });

  it("finds no amount when none was said", () => {
    // Nothing is invented. An empty field gets filled by the user; a wrong one
    // gets saved.
    const spoken = parseSpokenEntry("午饭吃的是拉面");

    expect(spoken.amount).toBeNull();
    expect(spoken.note).toBe("午饭吃的是拉面");
  });

  it("calls it income when the words say so", () => {
    expect(parseSpokenEntry("收到工资 12000").kind).toBe("income");
    expect(parseSpokenEntry("退款 38").kind).toBe("income");
  });

  it("calls it spending by default", () => {
    // Spending is the common case, and the kind control is one tap away.
    expect(parseSpokenEntry("午饭 38").kind).toBe("expense");
    expect(parseSpokenEntry("买了本书 45").kind).toBe("expense");
  });

  it("strips a filler from the front", () => {
    expect(parseSpokenEntry("嗯，午饭 38").note).toBe("午饭");
  });

  it("strips a filler from the end", () => {
    expect(parseSpokenEntry("午饭 38 啊").note).toBe("午饭");
  });

  it("strips several fillers in a row", () => {
    // One pass leaves "那个，午饭", which still reads as broken.
    expect(parseSpokenEntry("嗯，那个，午饭 38").note).toBe("午饭");
  });

  it("keeps a filler that is inside the sentence", () => {
    // 啊 in the middle is part of what somebody said; the same character at the
    // front is the sound of starting to talk.
    expect(parseSpokenEntry("买了啊那个牌子的 38").note).toContain("啊");
  });

  it("handles an empty recording", () => {
    const spoken = parseSpokenEntry("");

    expect(spoken.amount).toBeNull();
    expect(spoken.note).toBe("");
  });
});

describe("cleanNote", () => {
  it("collapses a run of separators into one", () => {
    expect(cleanNote("午饭，，， 和同事")).toBe("午饭，和同事");
  });

  it("removes a separator left at an edge", () => {
    expect(cleanNote("，午饭，")).toBe("午饭");
  });

  it("removes trailing sentence punctuation", () => {
    expect(cleanNote("午饭。")).toBe("午饭");
  });

  it("leaves an ordinary note alone", () => {
    expect(cleanNote("和同事吃午饭")).toBe("和同事吃午饭");
  });
});

describe("isSpeechless", () => {
  it("recognises silence", () => {
    expect(isSpeechless("")).toBe(true);
    expect(isSpeechless("   ")).toBe(true);
  });

  it("recognises whisper's own annotations", () => {
    // Whisper answers a non-speech sound with a bracketed marker. Offering to
    // file one as a note would be offering to save nonsense.
    expect(isSpeechless("[BLANK_AUDIO]")).toBe(true);
    expect(isSpeechless("(字幕:J Chong)")).toBe(true);
    expect(isSpeechless("【音乐】")).toBe(true);
  });

  it("does not mistake real speech for noise", () => {
    expect(isSpeechless("午饭 38")).toBe(false);
    expect(isSpeechless("嗯")).toBe(false);
  });
});
