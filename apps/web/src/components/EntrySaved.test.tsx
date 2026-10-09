import type { Transaction } from "@libellum/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EntrySaved } from "./EntrySaved.js";

/**
 * The screen that replaced "a line of green text above a still-filled form".
 *
 * What is worth asserting is exactly what people were unsure about before: that
 * the entry was recorded, and *what* was recorded.
 */
function entry(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "01920000-0000-7000-8000-000000000000",
    kind: "expense",
    amountCents: 2000,
    currency: "CNY",
    categoryId: "c1",
    categoryName: "餐饮",
    categoryIsSystem: false,
    paymentMethodId: "p1",
    paymentMethodName: "微信",
    occurredAt: "2026-10-09T04:00:00.000Z",
    occurredLocalDate: "2026-10-09",
    occurredTz: "Asia/Shanghai",
    note: null,
    tags: [],
    version: 1,
    ...overrides,
  } as Transaction;
}

function render(props: Partial<Parameters<typeof EntrySaved>[0]> = {}): string {
  return renderToStaticMarkup(
    <EntrySaved
      entry={entry()}
      categoryName="餐饮"
      paymentName="微信"
      onHome={() => undefined}
      onAgain={() => undefined}
      {...props}
    />,
  );
}

describe("EntrySaved", () => {
  it("says the entry was recorded", () => {
    expect(render()).toContain("已记账");
  });

  it("shows the amount, not just that something happened", () => {
    // A confirmation is only reassuring if it says what was confirmed.
    expect(render()).toContain("20.00");
  });

  it("shows what it was filed under", () => {
    const html = render();

    expect(html).toContain("餐饮");
    expect(html).toContain("微信");
  });

  it("offers both ways onward", () => {
    const html = render();

    expect(html).toContain("再记一笔");
    expect(html).toContain("返回主页");
  });

  it("puts the repeat action before the exit", () => {
    // This screen appears after every save, and recording a day's spending
    // means several in a row.
    const html = render();

    expect(html.indexOf("再记一笔")).toBeLessThan(html.indexOf("返回主页"));
  });

  it("announces itself to a screen reader", () => {
    // Otherwise the interface silently becomes a different screen.
    expect(render()).toContain('role="status"');
  });

  it("copes with an entry that has no category or payment method", () => {
    const html = render({ categoryName: "", paymentName: null });

    expect(html).toContain("已记账");
    expect(html).not.toContain(" · ");
  });

  it("formats a currency without decimals correctly", () => {
    const html = render({ entry: entry({ amountCents: 1000, currency: "JPY" }) });

    // ¥1000, not ¥10.00 — the per-currency precision rule reaches the
    // confirmation screen too.
    expect(html).toContain("1,000");
    expect(html).not.toContain("10.00");
  });
});
