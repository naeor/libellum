import { describe, expect, it } from "vitest";

import { matchCategory, type CategoryCandidate } from "./categoryMatch.js";

/**
 * Choosing a category from what was said.
 *
 * The owner's request: "比如说检测到对话食物的时候。如果分类里有餐饮，就选餐饮等等."
 *
 * The two rules worth testing are the ones about *restraint*: it must never
 * invent a category, and it must report what it matched on so the interface can
 * show its reasoning. A guess that looks plausible and is wrong is the failure
 * mode this whole area is designed against.
 */
function category(id: string, name: string, kind = "expense"): CategoryCandidate {
  return { id, name, kind, isArchived: false };
}

/** The shape a real ledger's categories have. */
const LEDGER: readonly CategoryCandidate[] = [
  category("c-food", "餐饮"),
  category("c-transport", "交通"),
  category("c-shopping", "购物"),
  category("c-home", "居住"),
  category("c-fun", "娱乐"),
  category("c-uncat", "暂无分类"),
  category("c-salary", "工资", "income"),
  category("c-transfer", "转账", "income"),
];

describe("matchCategory", () => {
  it("picks 餐饮 when food was mentioned", () => {
    // The owner's own example.
    expect(matchCategory("午饭三十八块", LEDGER, "expense")?.id).toBe("c-food");
  });

  it("recognises food by many different words", () => {
    for (const spoken of ["点了外卖", "在食堂吃饭", "买了点水果", "喝了杯奶茶", "晚上吃火锅"]) {
      expect(matchCategory(spoken, LEDGER, "expense")?.id, spoken).toBe("c-food");
    }
  });

  it("picks 交通 when travelling was mentioned", () => {
    expect(matchCategory("打车回家", LEDGER, "expense")?.id).toBe("c-transport");
    expect(matchCategory("地铁两块", LEDGER, "expense")?.id).toBe("c-transport");
  });

  it("picks 居住 for utilities", () => {
    expect(matchCategory("交电费一百二", LEDGER, "expense")?.id).toBe("c-home");
  });

  it("says what it matched on", () => {
    // So the interface can show "听到「午饭」，已选：餐饮" rather than filling a
    // field with no explanation.
    const match = matchCategory("午饭三十八块", LEDGER, "expense");

    expect(match?.matched).toContain("午饭");
  });

  it("returns null rather than guessing when nothing fits", () => {
    // The category field is one tap away, and an empty field gets filled where a
    // wrong guess gets saved.
    expect(matchCategory("给妈妈买了个保温杯", LEDGER, "expense")).toBeNull();
    expect(matchCategory("", LEDGER, "expense")).toBeNull();
  });

  it("never returns a category that was not offered", () => {
    // The whole point of matching against the list: a ledger whose owner calls it
    // 吃饭 must not have 餐饮 created in it.
    const own = [category("c-mine", "吃饭")];
    const match = matchCategory("昨天吃饭花了三十", own, "expense");

    expect(match?.id).toBe("c-mine");
    expect(match?.id).not.toBe("c-food");
  });

  it("matches the words a category's own name belongs to, not just its own name", () => {
    // 吃饭 is in the food vocabulary, so a category named after the phrase is found
    // by every word in that vocabulary — 午饭 included, since 吃饭 and 午饭 are the
    // same subject.
    expect(matchCategory("午饭三十八", [category("c-mine", "吃饭")], "expense")?.id).toBe("c-mine");
  });

  it("finds a category named with the vocabulary word inside it", () => {
    // 餐饮美食 is about 餐饮; a name that does not match exactly must still count.
    expect(matchCategory("午饭三十八", [category("c1", "餐饮美食")], "expense")?.id).toBe("c1");
  });

  it("finds a category called by the phrase people say", () => {
    // 吃饭 is in the food vocabulary, so a category named after the phrase works
    // even though no list has "吃饭" as a heading.
    expect(matchCategory("昨天吃饭花了三十", [category("c1", "吃饭")], "expense")?.id).toBe("c1");
  });

  it("matches a category whose name was said out loud", () => {
    expect(matchCategory("餐饮三十八", LEDGER, "expense")?.id).toBe("c-food");
  });

  it("counts the evidence when two categories could both fit", () => {
    // "打车去吃饭" contains one word from each; 吃饭打车 has two from transport.
    const both = [category("c-food", "餐饮"), category("c-transport", "交通")];

    expect(matchCategory("打车去吃饭", both, "expense")?.id).toBe("c-food");
    expect(matchCategory("打车去吃饭，打车回来的", both, "expense")?.id).toBe("c-transport");
  });

  it("⚠️ never returns a category of the other kind", () => {
    // The API refuses a category whose kind disagrees — "「转账」属于收入分类，和这笔记
    // 账的收支类型不一致" — so offering one would produce a rejection the user
    // cannot explain.
    const match = matchCategory("退了三十块", LEDGER, "expense");

    expect(match?.id).not.toBe("c-transfer");
    expect(match?.id).not.toBe("c-salary");
  });

  it("matches income words against income categories", () => {
    expect(matchCategory("收到工资一万二", LEDGER, "income")?.id).toBe("c-salary");
  });

  it("ignores an archived category", () => {
    const archived: CategoryCandidate = { id: "c-old", name: "餐饮", kind: "expense", isArchived: true };

    expect(matchCategory("午饭三十八", [archived], "expense")).toBeNull();
  });

  it("ignores a category with a blank name", () => {
    // 暂无分类 arrives with an empty name in some ledgers, and an empty name is a
    // substring of everything.
    expect(matchCategory("午饭三十八", [category("c-blank", "")], "expense")).toBeNull();
  });

  it("returns null when there are no categories at all", () => {
    expect(matchCategory("午饭三十八", [], "expense")).toBeNull();
  });

  it("⚠️ does not match 暂无分类 against everything", () => {
    // Included in the default ledger, and "分类" alone must not vote for anything.
    expect(matchCategory("午饭三十八", [category("c-uncat", "暂无分类")], "expense")).toBeNull();
  });
});
