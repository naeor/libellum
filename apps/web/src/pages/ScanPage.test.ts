import type { OcrItemResult } from "@libellum/shared";
import { describe, expect, it } from "vitest";

import { toLocalDate } from "../lib/datetime.js";
import { draftOf, foldDrafts } from "./ScanPage.js";

/**
 * Turning a recognition result into a form.
 *
 * Pure functions, and the part of the screenshot flow most likely to be wrong
 * in a way nobody notices: an amount that quietly loses its decimals, a
 * currency read as the wrong one, a payment method invented from a channel
 * that only looked familiar. The screen itself needs a session and a real
 * file picker to exercise, but this is where the arithmetic lives.
 */
const CATEGORIES = [
  { id: "c-dining", name: "餐饮", kind: "expense", isArchived: false },
  { id: "c-salary", name: "工资", kind: "income", isArchived: false },
  { id: "c-old", name: "旧分类", kind: "expense", isArchived: true },
];

const METHODS = [
  { id: "m-wechat", name: "微信", isArchived: false },
  { id: "m-alipay", name: "支付宝", isArchived: false },
  { id: "m-card", name: "银行卡", isArchived: false },
];

function item(overrides: Partial<OcrItemResult["draft"]> = {}, ok = true): OcrItemResult {
  return {
    index: 0,
    ok,
    draft: {
      amount: "328.00",
      currency: "CNY",
      occurredLocalDate: "2026-09-21",
      occurredTime: "16:55",
      kind: "expense",
      channel: "WECHAT",
      counterparty: "Apple Distribution International",
      note: null,
      serial: null,
      isRefund: false,
      warnings: [],
      ...overrides,
    },
    error: null,
    message: null,
    lineCount: 30,
    averageConfidence: 0.98,
    seconds: 1.2,
  };
}

describe("draftOf", () => {
  it("takes the amount, date and time straight from the reading", () => {
    const draft = draftOf(item(), CATEGORIES, METHODS, null);

    expect(draft.amount).toBe("328.00");
    expect(draft.date).toBe("2026-09-21");
    expect(draft.time).toBe("16:55");
  });

  it("matches the channel to a payment method by name", () => {
    expect(draftOf(item({ channel: "ALIPAY" }), CATEGORIES, METHODS, null).paymentMethodId).toBe("m-alipay");
    expect(draftOf(item({ channel: "BANK" }), CATEGORIES, METHODS, null).paymentMethodId).toBe("m-card");
  });

  it("leaves the payment method empty rather than inventing one", () => {
    // A channel the account has no method for. An empty field gets chosen;
    // a wrong one gets confirmed.
    expect(draftOf(item({ channel: null }), CATEGORIES, METHODS, null).paymentMethodId).toBeNull();
  });

  it("falls back to today when the screenshot carried no date", () => {
    // The two "success" screenshots really do omit the time entirely. The
    // fallback is the *current* date, not the previous draft's: a screenshot
    // with no date says nothing about when the payment happened, and borrowing
    // the last entry's day would file it under a day it never belonged to.
    const draft = draftOf(item({ occurredLocalDate: null, occurredTime: null }), CATEGORIES, METHODS, null);

    expect(draft.date).toBe(toLocalDate(new Date()));
    expect(draft.time).toBe("");
  });

  it("keeps a currency it knows and refuses one it does not", () => {
    expect(draftOf(item({ currency: "JPY" }), CATEGORIES, METHODS, null).currency).toBe("JPY");
    expect(draftOf(item({ currency: "XYZ" }), CATEGORIES, METHODS, null).currency).toBe("CNY");
  });

  it("reads a refund as income", () => {
    // The recogniser already decided this; the form must not undo it.
    expect(draftOf(item({ kind: "income", isRefund: true }), CATEGORIES, METHODS, null).kind).toBe("income");
  });

  it("joins the counterparty and note into one remark", () => {
    const draft = draftOf(item({ note: "订阅" }), CATEGORIES, METHODS, null);

    expect(draft.note).toContain("Apple");
    expect(draft.note).toContain("订阅");
  });

  it("only defaults the category to one that exists and is usable", () => {
    expect(draftOf(item(), CATEGORIES, METHODS, "c-dining").categoryId).toBe("c-dining");
    // An archived category, or one belonging to another account.
    expect(draftOf(item(), CATEGORIES, METHODS, "c-old").categoryId).toBeNull();
    expect(draftOf(item(), CATEGORIES, METHODS, "nope").categoryId).toBeNull();
  });

  it("does not carry a category across a change of kind", () => {
    // The bug the owner hit, in one line. He photographed a bill, the reading
    // came back as income, and the form inherited the previous entry's expense
    // category — which the server refused, with a message about permissions that
    // had nothing to do with it. A category offered for one kind must never be
    // offered for the other.
    const asIncome = draftOf(item({ kind: "income" }), CATEGORIES, METHODS, "c-dining");

    expect(asIncome.kind).toBe("income");
    expect(asIncome.categoryId).toBeNull();
  });

  it("still carries a category when the kind matches", () => {
    const asIncome = draftOf(item({ kind: "income" }), CATEGORIES, METHODS, "c-salary");

    expect(asIncome.categoryId).toBe("c-salary");
  });

  it("never defaults to a system category, which the picker does not offer", () => {
    // 暂无分类 is a real row, but it is not something the user can choose, so
    // inheriting it would leave the picker showing one thing and the state
    // holding another.
    const withSystem = [
      ...CATEGORIES,
      { id: "c-none", name: "暂无分类", kind: "expense", isArchived: false, isSystem: true },
    ];

    expect(draftOf(item(), withSystem, METHODS, "c-none").categoryId).toBeNull();
  });
});

describe("foldDrafts", () => {
  it("handles a single screenshot, which is now the common case", () => {
    // The mode question is only asked when there is more than one screenshot,
    // so one screenshot goes down this path with the default mode. It must
    // come out unchanged.
    const folded = foldDrafts([item({ amount: "328.00" })], CATEGORIES, METHODS, null);

    expect(folded.amount).toBe("328.00");
    expect(folded.currency).toBe("CNY");
  });

  it("handles a single yen screenshot without inventing decimals", () => {
    const folded = foldDrafts([item({ amount: "1250", currency: "JPY" })], CATEGORIES, METHODS, null);

    expect(folded.amount).toBe("1250");
  });

  it("adds up several proofs of one purchase", () => {
    const folded = foldDrafts(
      [item({ amount: "0.10" }), item({ amount: "0.20" }), item({ amount: "30.00" })],
      CATEGORIES,
      METHODS,
      null,
    );

    expect(folded.amount).toBe("30.30");
  });

  it("keeps the currency's precision when adding", () => {
    // Yen has no decimals; adding as if it did would multiply the total by a
    // hundred.
    const folded = foldDrafts(
      [item({ amount: "1000", currency: "JPY" }), item({ amount: "250", currency: "JPY" })],
      CATEGORIES,
      METHODS,
      null,
    );

    expect(folded.amount).toBe("1250");
    expect(folded.currency).toBe("JPY");
  });

  it("refuses to add different currencies together", () => {
    // Adding yuan to yen is meaningless, so the amount is left for the user
    // rather than guessed at.
    const folded = foldDrafts(
      [item({ amount: "100", currency: "CNY" }), item({ amount: "1000", currency: "JPY" })],
      CATEGORIES,
      METHODS,
      null,
    );

    expect(folded.amount).toBe("");
  });

  it("totals only what could be read", () => {
    // The unreadable one contributes nothing rather than aborting the total,
    // and the result still carries the currency's two decimals.
    const folded = foldDrafts(
      [item({ amount: "10.00" }), item({ amount: null })],
      CATEGORIES,
      METHODS,
      null,
    );

    expect(folded.amount).toBe("10.00");
  });

  it("leaves the amount empty when nothing could be read", () => {
    const folded = foldDrafts([item({ amount: null })], CATEGORIES, METHODS, null);

    expect(folded.amount).toBe("");
  });

  it("survives an empty batch", () => {
    expect(foldDrafts([], CATEGORIES, METHODS, null).amount).toBe("");
  });
});
