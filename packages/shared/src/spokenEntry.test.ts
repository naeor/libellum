import { describe, expect, it } from "vitest";

import { matchCategory, type CategoryCandidate } from "./categoryMatch.js";
import { parseSpokenEntry, parseSpokenEntryWithCategory } from "./speech.js";

/**
 * The whole "a sentence became an entry" path, on the sentences this project's
 * owner actually says.
 *
 * The units are tested separately; this file is about the join, because the join
 * is where the interesting mistakes live. `parseSpokenEntry` was already correct
 * about digits when the owner reported "他似乎对汉字大写的数字不太敏感" — the gap was
 * that Chinese numerals never reached it.
 */

/** The categories a real ledger has, in the order the API returns them. */
const LEDGER: readonly CategoryCandidate[] = [
  { id: "c-food", name: "餐饮", kind: "expense", isArchived: false },
  { id: "c-transport", name: "交通", kind: "expense", isArchived: false },
  { id: "c-shopping", name: "购物", kind: "expense", isArchived: false },
  { id: "c-home", name: "居住", kind: "expense", isArchived: false },
  { id: "c-uncat", name: "暂无分类", kind: "expense", isArchived: false },
  { id: "c-salary", name: "工资", kind: "income", isArchived: false },
];

describe("a spoken sentence, end to end", () => {
  it("reads digits, exactly as whisper usually writes them", () => {
    const entry = parseSpokenEntryWithCategory("午饭 38 块", LEDGER);

    expect(entry.amount).toBe("38");
    expect(entry.note).toBe("午饭");
    expect(entry.kind).toBe("expense");
    expect(entry.categoryId).toBe("c-food");
  });

  it("reads Chinese numerals, which whisper writes when it is unsure", () => {
    // ⚠️ The owner's report. Before this, 三十八 produced **no amount at all** —
    // a silent failure that looked like the recogniser's fault.
    const entry = parseSpokenEntryWithCategory("午饭三十八块", LEDGER);

    expect(entry.amount).toBe("38");
    expect(entry.categoryId).toBe("c-food");
  });

  it("reads the formal characters a bank would use", () => {
    const entry = parseSpokenEntryWithCategory("买菜叁佰捌拾元", LEDGER);

    expect(entry.amount).toBe("380");
    expect(entry.categoryId).toBe("c-food");
  });

  it("keeps a decimal amount exact", () => {
    expect(parseSpokenEntry("打车二十五点五").amount).toBe("25.5");
  });

  it("picks 交通 for travelling and 工资 for income", () => {
    expect(parseSpokenEntryWithCategory("打车二十五块", LEDGER).categoryId).toBe("c-transport");

    const salary = parseSpokenEntryWithCategory("收到工资一万二", LEDGER);
    expect(salary.kind).toBe("income");
    expect(salary.categoryId).toBe("c-salary");
  });

  it("prefers the price over another number in the same sentence", () => {
    // 三个人 is a number; 三百块 is the amount.
    const entry = parseSpokenEntryWithCategory("三个人吃饭三百块", LEDGER);

    expect(entry.amount).toBe("300");
    expect(entry.categoryId).toBe("c-food");
  });

  it("leaves the category empty rather than guessing", () => {
    // Nothing in the sentence points at a category, and an empty field gets filled
    // where a wrong guess gets saved.
    const entry = parseSpokenEntryWithCategory("给妈妈买了个保温杯", LEDGER);

    expect(entry.categoryId).toBeNull();
    expect(entry.categoryMatched).toEqual([]);
  });

  it("says which words it matched on", () => {
    expect(parseSpokenEntryWithCategory("午饭三十八", LEDGER).categoryMatched).toContain("午饭");
  });

  it("reads an amount with no currency word at all", () => {
    expect(parseSpokenEntry("买菜六十四").amount).toBe("64");
    expect(parseSpokenEntry("买菜六十四").note).toBe("买菜");
  });

  it("still handles a sentence with no amount", () => {
    const entry = parseSpokenEntryWithCategory("午饭吃的是拉面", LEDGER);

    expect(entry.amount).toBeNull();
    expect(entry.note).toBe("午饭吃的是拉面");
    // The category is still worth guessing when the amount is missing: the user
    // can type the amount and keep the category.
    expect(entry.categoryId).toBe("c-food");
  });

  it("does not fire on an empty recording", () => {
    const entry = parseSpokenEntryWithCategory("", LEDGER);

    expect(entry.amount).toBeNull();
    expect(entry.note).toBe("");
    expect(entry.categoryId).toBeNull();
  });

  it("never returns a category from another ledger", () => {
    // The list arrives from the server, and matching against it is the whole
    // safeguard: nothing may be created that the ledger does not already have.
    const own = [{ id: "c-mine", name: "吃饭", kind: "expense", isArchived: false }];
    const entry = parseSpokenEntryWithCategory("午饭三十八", own);

    expect(entry.categoryId).toBe("c-mine");
  });
});
