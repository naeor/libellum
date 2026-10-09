import type { CurrencySummary, Transaction } from "@libellum/shared";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useNavigate } from "react-router";

import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { TabPage } from "../components/Layouts.js";
import { errorMessage } from "../lib/api.js";
import { currencyName, formatMoney } from "../lib/format.js";
import { currentMonth, formatDayLabel, formatMonthLabel, formatTimeInZone, shiftMonth } from "../lib/datetime.js";
import { useLedger, useSummary, useTransactions } from "../lib/queries.js";
import { EntryIsland } from "../components/EntryIsland.js";

/** At most two currencies get their own block; the rest fold into one row. */
const VISIBLE_CURRENCIES = 2;

function MonthSwitcher({
  month,
  onChange,
}: {
  readonly month: string;
  readonly onChange: (month: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <button
        type="button"
        aria-label="上一个月"
        onClick={() => {
          onChange(shiftMonth(month, -1));
        }}
        className="px-2 py-1 text-lg text-white/80 transition hover:text-white"
      >
        ‹
      </button>
      <span className="text-sm font-medium text-white">{formatMonthLabel(month)}</span>
      <button
        type="button"
        aria-label="下一个月"
        onClick={() => {
          onChange(shiftMonth(month, 1));
        }}
        className="px-2 py-1 text-lg text-white/80 transition hover:text-white"
      >
        ›
      </button>
    </div>
  );
}

function CurrencyBlock({ summary }: { readonly summary: CurrencySummary }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-white/70">{currencyName(summary.currency)}</span>
      <div className="flex items-baseline gap-4">
        <span className="text-lg font-semibold">
          {formatMoney(summary.expenseCents, summary.currency)}
        </span>
        <span className="text-xs text-white/80">
          入账 {formatMoney(summary.incomeCents, summary.currency)}
        </span>
      </div>
      <span className="text-xs text-white/80">
        结余 {formatMoney(summary.balanceCents, summary.currency)}
      </span>
    </div>
  );
}

export function DetailPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * Filters can arrive in the address.
   *
   * The analysis screen links here with a category and a month already chosen,
   * so a slice of the ring is one tap away from the entries behind it — a
   * number on its own is never what the user wanted to see. Reading the
   * initial value from the query string, rather than mirroring state into it,
   * keeps the URL meaningful without turning every month tap into a history
   * entry.
   */
  const [month, setMonth] = useState(() => searchParams.get("month") ?? currentMonth());
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [showAllCurrencies, setShowAllCurrencies] = useState(false);

  const categoryId = searchParams.get("categoryId");

  const clearCategoryFilter = (): void => {
    const next = new URLSearchParams(searchParams);
    next.delete("categoryId");
    setSearchParams(next, { replace: true });
  };

  const summary = useSummary(month);
  const ledger = useLedger();
  const list = useTransactions({ month, kind, categoryId: categoryId ?? undefined });

  const filteredCategory =
    categoryId === null
      ? undefined
      : ledger.data?.categories.find((category) => category.id === categoryId);

  const currencies = summary.data?.currencies ?? [];
  const visible = showAllCurrencies ? currencies : currencies.slice(0, VISIBLE_CURRENCIES);
  const hiddenCount = Math.max(currencies.length - visible.length, 0);

  const entries = useMemo(
    () => (list.data?.pages ?? []).flatMap((page) => page.items),
    [list.data],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, Transaction[]>();
    for (const entry of entries) {
      const bucket = groups.get(entry.occurredLocalDate) ?? [];
      bucket.push(entry);
      groups.set(entry.occurredLocalDate, bucket);
    }
    return [...groups.entries()];
  }, [entries]);

  const isEmptyMonth = list.isSuccess && entries.length === 0;

  return (
    <TabPage active="/" onNavigate={(to) => void navigate(to)}>
      {/* Floats over the list. The list below carries extra bottom padding so
          the last row can never end up underneath it. */}
      <EntryIsland />

      <header className="flex flex-col gap-4 bg-brand px-6 pt-8 pb-6 text-white">
        <MonthSwitcher month={month} onChange={setMonth} />

        {/*
          The filter is visible and removable. Arriving from a chart with a
          category already applied and no way to see or clear it would look
          like the ledger had lost most of its entries.
        */}
        {categoryId === null ? null : (
          <div className="flex items-center gap-2 self-start rounded-full bg-white/15 px-3 py-1.5 text-xs text-white">
            <span>
              已筛选分类：{filteredCategory?.name ?? "载入中…"}
            </span>
            <button
              type="button"
              onClick={clearCategoryFilter}
              aria-label="清除分类筛选"
              className="rounded-full px-1.5 text-white/80 transition hover:text-white"
            >
              ✕
            </button>
          </div>
        )}

        {summary.isPending ? (
          <div className="h-20 animate-pulse rounded-field bg-white/15" />
        ) : currencies.length === 0 ? (
          <p className="py-2 text-sm text-white/85">本月还没有记账</p>
        ) : (
          <div className="flex flex-col gap-4">
            {visible.map((item) => (
              <CurrencyBlock key={item.currency} summary={item} />
            ))}

            {hiddenCount > 0 || currencies.length > VISIBLE_CURRENCIES ? (
              <button
                type="button"
                onClick={() => {
                  setShowAllCurrencies((current) => !current);
                }}
                className="flex items-center justify-between rounded-field bg-black/15 px-3 py-2 text-xs text-white/90 transition hover:bg-black/25"
              >
                <span>
                  {showAllCurrencies
                    ? "收起其它币种"
                    : `其它币种（${String(currencies.length - VISIBLE_CURRENCIES)}）`}
                </span>
                <span aria-hidden="true">{showAllCurrencies ? "⌃" : "⋯"}</span>
              </button>
            ) : null}
          </div>
        )}
      </header>

      {/* A segmented control, not two loose buttons: the track behind them is
          what says "pick one of these two" rather than "here are two actions". */}
      <div className="px-6 pt-5">
        <div className="flex gap-1 rounded-field bg-line/70 p-1">
          {(["expense", "income"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              onClick={() => {
                setKind(option);
              }}
              className={`flex-1 rounded-[0.7rem] py-2 text-sm font-medium transition ${
                kind === option ? "bg-surface text-brand-dark shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {option === "expense" ? "支出" : "收入"}
            </button>
          ))}
        </div>
      </div>

      {list.isPending ? <SkeletonRows /> : null}

      {list.isError ? (
        <ErrorState
          message={errorMessage(list.error)}
          onRetry={() => {
            void list.refetch();
          }}
        />
      ) : null}

      {isEmptyMonth ? (
        <EmptyState
          title={kind === "expense" ? "这个月还没有支出" : "这个月还没有收入"}
          description="点击下方中间的记账按钮，记下第一笔。"
          actionLabel="记一笔"
          onAction={() => void navigate("/add")}
        />
      ) : null}

      <div className="flex flex-col px-6 pt-4">
        {grouped.map(([day, dayEntries]) => (
          <section key={day}>
            <h2 className="py-2 text-xs text-muted">{formatDayLabel(day)}</h2>
            <ul className="overflow-hidden rounded-card bg-surface">
              {dayEntries.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => void navigate(`/transactions/${entry.id}`)}
                    className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left transition last:border-b-0 hover:bg-canvas"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-canvas text-xs text-muted">
                      {(entry.categoryIsSystem ? "—" : entry.categoryName.slice(0, 1))}
                    </span>

                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-ink">
                        {entry.categoryIsSystem ? "暂无分类" : entry.categoryName}
                        {entry.note ? <span className="text-muted"> · {entry.note}</span> : null}
                      </span>
                      <span className="text-xs text-muted">
                        {formatTimeInZone(entry.occurredAt, entry.occurredTz)}
                        {entry.paymentMethodName ? ` · ${entry.paymentMethodName}` : ""}
                      </span>
                    </span>

                    <span
                      className={`shrink-0 text-sm font-medium ${
                        entry.kind === "expense" ? "text-ink" : "text-brand-dark"
                      }`}
                    >
                      {entry.kind === "expense" ? "-" : "+"}
                      {formatMoney(entry.amountCents, entry.currency)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {list.hasNextPage ? (
        <div className="px-6 py-4">
          <button
            type="button"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
            className="w-full rounded-field bg-surface py-3 text-sm text-muted transition hover:text-ink disabled:opacity-50"
          >
            {list.isFetchingNextPage ? "加载中…" : "加载更早的记录"}
          </button>
        </div>
      ) : null}
    </TabPage>
  );
}
