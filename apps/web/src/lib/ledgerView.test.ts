import type { Transaction, TransactionListResponse } from "@libellum/shared";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { mergeLedgerEntries, updateTransactionViews } from "./ledgerView.js";

function row(id: string, kind: "income" | "expense", changes: Partial<Transaction> = {}): Transaction {
  return { id, kind, amountCents: 2000, currency: "CNY", categoryId: "cat", categoryName: "分类",
    categoryIsSystem: false, paymentMethodId: null, paymentMethodName: null, occurredAt: "2026-10-11T08:00:00Z",
    occurredLocalDate: "2026-10-11", occurredTz: "Asia/Shanghai", note: null, tags: [], version: 1, ...changes };
}
const expense = row("expense", "expense");
const income = row("income", "income");
describe("ledger view isolation", () => {
  it.each(["income", "expense"] as const)("filters stale mixed query pages for %s", kind => {
    const rows = mergeLedgerEntries([], [expense, income], new Set(), { month: "2026-10", kind });
    expect(rows.map(entry => entry.id)).toEqual([kind]);
  });
  it("retains a pending local edit while removing rows of the other kind", () => {
    const pending = { ...expense, amountCents: 8000 };
    expect(mergeLedgerEntries([pending], [expense, income], new Set([expense.id]), { kind: "expense" })).toEqual([pending]);
  });
  it("updates both query caches using all their original filters after a local write", () => {
    const client = new QueryClient();
    const views = [
      { month: "2026-10", kind: "expense" },
      { month: "2026-10", kind: "income" },
      { month: "2026-10", kind: "expense", categoryId: "other" },
      { month: "2026-10", kind: "expense", currency: "USD" },
    ];
    for (const filters of views) client.setQueryData(["transactions", filters], { pages: [], pageParams: [] });
    updateTransactionViews(client, [expense, income, row("usd", "expense", { currency: "USD", categoryId: "other" })]);
    const ids = views.map(filters => client.getQueryData<{ pages: TransactionListResponse[] }>(["transactions", filters])!.pages[0]!.items.map(entry => entry.id));
    expect(ids).toEqual([["expense", "usd"], ["income"], ["usd"], ["usd"]]);
    client.clear();
  });
});
