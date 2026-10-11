import { describe, expect, it } from "vitest";

import type { Transaction } from "@libellum/shared";

import { applyAnswers, mergeEntries, type MergeField } from "./merge.js";

/**
 * ⚠️ **The rule the owner set, and the promise attached to it.**
 *
 * "先自动合并：不冲突的字段自动合，只有冲突的字段才问" — and, in the same breath,
 * **"但'自动合了哪些'必须显示出来，否则用户不知道机器替他决定了什么."**
 *
 * **These tests are about the two ways this can go wrong, and both are silent**: a merge that overwrites a value
 * the user never touched loses somebody else's edit, and a merge that hides what it decided looks exactly like
 * the program losing an edit. **Neither raises an error; both are only visible to the person whose data it is.**
 */

function entry(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "entry-1",
    kind: "expense",
    amountCents: 1000,
    currency: "CNY",
    categoryId: "cat-food",
    categoryName: "餐饮",
    categoryIsSystem: false,
    paymentMethodId: null,
    paymentMethodName: null,
    occurredAt: "2026-10-11T12:00:00.000+08:00",
    occurredLocalDate: "2026-10-11",
    occurredTz: "Asia/Shanghai",
    note: null,
    tags: [],
    version: 1,
    ...overrides,
  };
}

describe("merging two copies of one entry", () => {
  it("takes my change when only I changed the field", () => {
    // The ordinary offline edit: I changed the amount, nobody else touched the entry.
    const base = entry();
    const mine = entry({ amountCents: 2500 });
    const theirs = entry();

    const result = mergeEntries(base, mine, theirs);

    expect(result.merged.amountCents).toBe(2500);
    expect(result.conflicts).toHaveLength(0);
    expect(result.automatic).toEqual([
      { field: "amountCents", label: "金额", from: "mine", value: 2500 },
    ]);
  });

  it("⚠️ takes their change when only they changed the field", () => {
    // Otherwise a sync quietly overwrites an edit somebody made on another device.
    const base = entry();
    const mine = entry();
    const theirs = entry({ amountCents: 9999 });

    const result = mergeEntries(base, mine, theirs);

    expect(result.merged.amountCents).toBe(9999);
    expect(result.conflicts).toHaveLength(0);
    expect(result.automatic).toEqual([
      { field: "amountCents", label: "金额", from: "theirs", value: 9999 },
    ]);
  });

  it("⚠️ reports both sides' changes rather than hiding them", () => {
    // "自动合了哪些必须显示出来" — the merge is not allowed to be silent.
    const base = entry();
    const mine = entry({ amountCents: 2500, note: "我改的备注" });
    const theirs = entry({ categoryId: "cat-fun", categoryName: "娱乐" });

    const result = mergeEntries(base, mine, theirs);

    expect(result.automatic.map((pick) => pick.field).sort()).toEqual(["amountCents", "categoryId", "note"]);
    expect(result.merged.amountCents).toBe(2500);
    expect(result.merged.note).toBe("我改的备注");
    expect(result.merged.categoryId).toBe("cat-fun");
  });

  it("⚠️ asks about a field both sides changed differently", () => {
    const base = entry();
    const mine = entry({ amountCents: 2500 });
    const theirs = entry({ amountCents: 9999 });

    const result = mergeEntries(base, mine, theirs);

    expect(result.conflicts).toEqual([
      {
        field: "amountCents",
        label: "金额",
        mine: 2500,
        theirs: 9999,
        base: 1000,
      },
    ]);
  });

  it("⚠️ keeps both changes when they touched different fields of the same entry", () => {
    // The case the whole round exists for: neither edit should be lost, and neither is a question.
    const base = entry();
    const mine = entry({ amountCents: 2500 });
    const theirs = entry({ note: "他们写的备注" });

    const result = mergeEntries(base, mine, theirs);

    expect(result.merged.amountCents).toBe(2500);
    expect(result.merged.note).toBe("他们写的备注");
    expect(result.conflicts).toHaveLength(0);
  });

  it("says nothing about a field nobody changed", () => {
    const result = mergeEntries(entry(), entry(), entry());

    expect(result.conflicts).toHaveLength(0);
    expect(result.automatic).toHaveLength(0);
    expect(result.merged.amountCents).toBe(1000);
  });

  it("⚠️ asks about every difference when the base is unknown", () => {
    /**
     * A conflict noticed after a reinstall, or a mark that outlived the entry's history. **Guessing here would
     * silently discard one side's work**, and the only thing worse than asking too much is deciding wrongly
     * without asking.
     */
    const mine = entry({ amountCents: 2500 });
    const theirs = entry({ amountCents: 9999 });

    const result = mergeEntries(null, mine, theirs);

    expect(result.conflicts.map((conflict) => conflict.field)).toEqual(["amountCents"]);
    expect(result.automatic).toHaveLength(0);
  });

  it("does not report a renamed category as a second conflict", () => {
    /**
     * ⚠️ `categoryName` follows `categoryId`, so comparing it as well would ask the user twice about one
     * decision — and the second question would be about a name they never chose.
     */
    const base = entry();
    const mine = entry({ categoryId: "cat-fun", categoryName: "娱乐" });
    const theirs = entry({ categoryName: "吃饭" });

    const result = mergeEntries(base, mine, theirs);

    expect(result.conflicts.map((conflict) => conflict.field)).toEqual([]);
    expect(result.merged.categoryName).toBe("娱乐");
  });

  it("⚠️ the category name follows the id that won", () => {
    // A merged entry showing the other side's category name would be lying about the field the user changed.
    const base = entry({ categoryId: "cat-food", categoryName: "餐饮" });
    const mine = entry({ categoryId: "cat-fun", categoryName: "娱乐" });
    const theirs = entry({ categoryId: "cat-travel", categoryName: "交通" });
    const answers = new Map([["categoryId" as MergeField, "mine" as const]]);

    const merged = mergeEntries(base, mine, theirs);
    const settled = applyAnswers(merged.merged, answers, mine, theirs);

    expect(settled.categoryId).toBe("cat-fun");
    expect(settled.categoryName).toBe("娱乐");
  });

  it("compares tags as a set, not as a sequence", () => {
    // Re-ordered tags are the same tags; reporting them as a conflict would be asking about nothing.
    const tag = (id: string) => ({ id, name: id, color: "#000000" });
    const base = entry({ tags: [tag("a")] });
    const mine = entry({ tags: [tag("a"), tag("b")] });
    const theirs = entry({ tags: [tag("b"), tag("a")] });

    const result = mergeEntries(base, mine, theirs);

    expect(result.conflicts).toHaveLength(0);
  });

  it("⚠️ applies nothing from an unanswered conflict but keeps the server's value", () => {
    // A screen that asked and then applied neither side would be worse than not asking at all.
    const base = entry();
    const mine = entry({ amountCents: 2500 });
    const theirs = entry({ amountCents: 9999 });

    const merged = mergeEntries(base, mine, theirs);
    const settled = applyAnswers(merged.merged, new Map(), mine, theirs);

    expect(settled.amountCents).toBe(9999);
  });

  it("applies the user's answer when it is given", () => {
    const base = entry();
    const mine = entry({ amountCents: 2500 });
    const theirs = entry({ amountCents: 9999 });

    const merged = mergeEntries(base, mine, theirs);
    const settled = applyAnswers(
      merged.merged,
      new Map([["amountCents" as MergeField, "mine" as const]]),
      mine,
      theirs,
    );

    expect(settled.amountCents).toBe(2500);
  });
});
