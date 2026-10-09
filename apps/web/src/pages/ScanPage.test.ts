import type { OcrItemResult } from "@libellum/shared";
import { describe, expect, it } from "vitest";

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
    // The two "success" screenshots really do omit the time entirely.
    const draft = draftOf(item({ occurredLocalDate: null, occurredTime: null }), CATEGORIES, METHODS, null);

    expect(draft.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
});

describe("foldDrafts", () => {
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
