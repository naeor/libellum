import type { Transaction } from "@libellum/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConflictScreen } from "./ConflictScreen.js";
import type { ConflictRecord } from "../lib/offline/localLedger.js";

/**
 * ⚠️ **What this screen has to prove, in the owner's own words**:
 *
 * "先自动合并：不冲突的字段自动合，只有冲突的字段才问" — and **"但'自动合了哪些'必须显示出来，否则用户不知道
 * 机器替他决定了什么."**
 *
 * **The second half is what these tests are for.** A screen that asks about the conflicting fields and says
 * nothing about the rest is indistinguishable, to the person reading it, from a program that guessed — **they
 * cannot tell "it merged four fields for me" from "it dropped three of my edits."** Both render as one question
 * and a Save button.
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

function render(conflict: ConflictRecord): string {
  return renderToStaticMarkup(
    <ConflictScreen conflict={conflict} onResolve={() => undefined} onLater={() => undefined} />,
  );
}

describe("the conflict screen", () => {
  it("⚠️ lists every field the program merged by itself", () => {
    // The requirement, stated as an assertion: the automatic decisions are on screen.
    const markup = render({
      mine: entry({ amountCents: 2500 }),
      theirs: entry({ note: "他们写的备注" }),
      base: entry(),
      at: 0,
    });

    expect(markup).toContain("已经自动合好的地方");
    expect(markup).toContain("金额");
    expect(markup).toContain("用你的");
    expect(markup).toContain("备注");
    expect(markup).toContain("用服务器上的");
  });

  it("⚠️ says which side each automatic value came from", () => {
    /**
     * "金额 → ¥25.00" on its own leaves the user unable to tell whether their edit survived — **and that question
     * is the entire reason the list exists.**
     */
    const markup = render({
      mine: entry({ amountCents: 2500 }),
      theirs: entry(),
      base: entry(),
      at: 0,
    });

    expect(markup).toContain("用你的");
  });

  it("asks about the field both sides changed", () => {
    const markup = render({
      mine: entry({ amountCents: 2500 }),
      theirs: entry({ amountCents: 9999 }),
      base: entry(),
      at: 0,
    });

    expect(markup).toContain("需要你选的地方");
    expect(markup).toContain("这台设备");
    expect(markup).toContain("服务器");
  });

  it("⚠️ says the server's value is the default rather than leaving it to be discovered", () => {
    const markup = render({
      mine: entry({ amountCents: 2500 }),
      theirs: entry({ amountCents: 9999 }),
      base: entry(),
      at: 0,
    });

    expect(markup).toContain("不选就先用服务器上的");
  });

  it("⚠️ refuses to save while a question is unanswered", () => {
    // Defaulting to "mine" would make tapping through quickly overwrite the other device — the exact outcome
    // this screen exists to prevent.
    const markup = render({
      mine: entry({ amountCents: 2500 }),
      theirs: entry({ amountCents: 9999 }),
      base: entry(),
      at: 0,
    });

    expect(markup).toContain("还有 1 处没选");
    expect(markup).toContain("disabled");
  });

  it("offers a way out that does not lose anything", () => {
    const markup = render({
      mine: entry({ amountCents: 2500 }),
      theirs: entry({ amountCents: 9999 }),
      base: entry(),
      at: 0,
    });

    expect(markup).toContain("稍后再处理");
    expect(markup).toContain("两份都留着");
  });

  it("says so when there is nothing to merge automatically", () => {
    // A blank section would read as "it did something and did not tell me" — the opposite of the point.
    const markup = render({
      mine: entry({ amountCents: 2500 }),
      theirs: entry({ amountCents: 9999 }),
      base: entry(),
      at: 0,
    });

    expect(markup).toContain("没有需要自动合并的字段");
  });
});
