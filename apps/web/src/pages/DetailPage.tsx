import { CURRENCIES, type CurrencySummary, type Transaction, type TransactionKind } from "@libellum/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useAuth } from "../auth/AuthProvider.js";
import { BottomNav } from "../components/BottomNav.js";
import { MonthPicker } from "../components/MonthPicker.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { SyncBanner } from "../components/SyncBanner.js";
import { errorMessage } from "../lib/api.js";
import { currentMonth, formatDayLabel, formatTimeInZone } from "../lib/datetime.js";
import { readSession, useDetailTransition, writeSession } from "../lib/detailTransition.js";
import { currencyName, formatMoney } from "../lib/format.js";
import { useLedger, useSummary, useTransactions } from "../lib/queries.js";

/**
 * The ledger screen, in one of two shapes.
 *
 * It is a single page and a single tree. Nothing is added, removed or swapped
 * as the reader moves between the two ends — every element that exists in the
 * display state also exists in the list state, at a different size or in a
 * different place, and `--p` interpolates between them. That is what makes the
 * change read as one thing contracting rather than two screens trading places,
 * and it is why the month never disappears and reappears somewhere else.
 *
 * The owner asked for the whole move to feel like a finger's: it follows the
 * touch, then settles with a slight spring. The mechanism is in
 * `lib/detailTransition.ts`; the geometry is in `detail-motion.css`.
 */
export function DetailPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();

  // Read once, on the first render. The session outlives a tab switch but not
  // a reload, which is exactly what the owner asked for: leaving the ledger and
  // coming back finds it as it was, quitting the app starts fresh.
  const saved = useRef(readSession()).current;

  const [month, setMonth] = useState(
    () => searchParams.get("month") ?? saved.month ?? currentMonth(),
  );
  const [kind, setKind] = useState<TransactionKind>(() => saved.kind ?? "expense");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showAllCurrencies, setShowAllCurrencies] = useState(false);

  const categoryId = searchParams.get("categoryId");
  const { rootRef, scrollRef, atList, goTo } = useDetailTransition(saved.progress);

  useEffect(() => {
    writeSession({ month, kind });
  }, [month, kind]);

  // Put the reader back where they were, but only if they were reading the
  // list — somebody returning to the display state should see it from the top.
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null && saved.progress >= 1 && saved.scrollTop > 0) {
      element.scrollTop = saved.scrollTop;
    }
  }, [saved.progress, saved.scrollTop, scrollRef]);

  const summary = useSummary(month);
  const ledger = useLedger();
  const list = useTransactions({ month, kind, categoryId: categoryId ?? undefined });

  const clearCategoryFilter = (): void => {
    const next = new URLSearchParams(searchParams);
    next.delete("categoryId");
    setSearchParams(next, { replace: true });
  };

  const filteredCategory =
    categoryId === null ? undefined : ledger.data?.categories.find((item) => item.id === categoryId);

  /**
   * The main card is the account's own currency, always — even in a month with
   * nothing in it.
   *
   * The owner was explicit: a card that quietly showed a different currency
   * whenever the usual one had no entries would be worse than an empty one.
   * People learn where to look, and moving it is what confuses them.
   */
  const mainCode = user?.defaultCurrency ?? "CNY";
  const currencies = summary.data?.currencies ?? [];
  const main = currencies.find((item) => item.currency === mainCode) ?? null;
  const others = useMemo(
    () => currencies.filter((item) => item.currency !== mainCode),
    [currencies, mainCode],
  );

  const entries = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.items), [list.data]);

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
  const year = month.slice(0, 4);
  const monthNumber = Number(month.slice(5, 7));

  return (
    <div ref={rootRef} className="detail-root flex h-dvh flex-col overflow-hidden">
      <SyncBanner />

      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-md flex-col pb-24">
          {/*
            The green area. Its height is the one place a layout size animates,
            and it is contained so the reflow stops here instead of reaching
            the list on every frame.
          */}
          <header className="detail-hero relative bg-brand px-6 pt-6 text-white">
            <div className="flex items-start justify-between">
              <h1 className="detail-title text-2xl font-semibold tracking-tight">Libellum</h1>

              <div className="detail-tools flex gap-2">
                <ToolButton label="导出" hint="在 S6 阶段实现" />
                <ToolButton label="更多" hint="即将开放" />
              </div>
            </div>

            {/*
              The month travels from the left edge to the centre. Two transforms
              do it with no measurement: the wrapper moves half the container,
              and the month moves back half of itself. The arrows sit outside
              the travelling wrapper so they stay against the page edges.
            */}
            <div className="relative mt-2 h-9">
              <div className="detail-month-track">
                <button
                  type="button"
                  onClick={() => {
                    setPickerOpen(true);
                  }}
                  className="detail-month inline-flex items-center text-base text-white/95"
                >
                  {year} 年 {monthNumber} 月
                  {/* The caret is the display state's hint that this opens
                      something; the arrows say the same thing in the list
                      state, and the two trade places as it travels. */}
                  <span className="detail-caret ml-1 text-[10px] text-white/75" aria-hidden="true">
                    ▼
                  </span>
                </button>
              </div>

              <div
                className="detail-arrows absolute inset-x-0 top-0 flex items-center justify-between"
                data-active={atList}
              >
                <ArrowButton
                  direction="left"
                  tabbable={atList}
                  onClick={() => {
                    setMonth(shiftMonth(month, -1));
                  }}
                />
                <ArrowButton
                  direction="right"
                  tabbable={atList}
                  onClick={() => {
                    setMonth(shiftMonth(month, 1));
                  }}
                />
              </div>
            </div>

            {summary.isPending ? (
              <div className="mt-4 h-28 animate-pulse rounded-card bg-white/15" />
            ) : (
              <>
                <MainCard className="detail-main-card mt-4" summary={main} currency={mainCode} />

                {others.length === 0 ? null : (
                  <div className="detail-secondary-card mt-3 flex gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none] [scroll-snap-type:x_proximity]">
                    {others.map((item) => (
                      <SecondaryCard key={item.currency} summary={item} />
                    ))}

                    <button
                      type="button"
                      onClick={() => {
                        setShowAllCurrencies(true);
                      }}
                      className="flex shrink-0 snap-start flex-col justify-center rounded-card bg-white/12 px-4 text-left text-xs text-white/90"
                      style={{ width: "32%" }}
                    >
                      更多币种
                    </button>
                  </div>
                )}
              </>
            )}
          </header>

          {/*
            The expense/income control. It keeps its size and its place — it is
            the seam between the two halves, and a control that moved while the
            things above it collapsed would make the whole change look loose.
          */}
          <div className="detail-toggle-bar px-6 pt-4">
            <div className="flex gap-1 rounded-full bg-line/70 p-1">
              {(["expense", "income"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={kind === option}
                  onClick={() => {
                    setKind(option);
                  }}
                  className={`flex-1 rounded-full py-2 text-sm font-medium transition ${
                    kind === option
                      ? "bg-surface text-brand-dark shadow-sm"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  {option === "expense" ? "支出" : "收入"}
                </button>
              ))}
            </div>
          </div>

          {categoryId === null ? null : (
            <div className="px-6 pt-3">
              <span className="inline-flex items-center gap-2 rounded-full bg-brand-soft px-3 py-1.5 text-xs text-brand-dark">
                已筛选分类：{filteredCategory?.name ?? "载入中…"}
                <button
                  type="button"
                  onClick={clearCategoryFilter}
                  aria-label="清除分类筛选"
                  className="px-1 text-brand-dark/70 transition hover:text-brand-dark"
                >
                  ✕
                </button>
              </span>
            </div>
          )}

          <div className="detail-body flex flex-col px-6">
            {/*
              The heading belongs to the display state. It collapses rather than
              staying and pushing the list down, so nothing below it moves.
            */}
            <div className="detail-recent-heading flex items-end justify-between pt-4">
              <h2 className="text-xs text-muted">最近记录</h2>
              <button
                type="button"
                onClick={() => {
                  goTo(1);
                }}
                className="pb-1 text-xs text-brand-dark"
              >
                查看全部
              </button>
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

            {grouped.map(([day, dayEntries]) => (
              <section key={day}>
                <h2 className="py-2 text-xs text-muted">{formatDayLabel(day)}</h2>
                <ul className="overflow-hidden rounded-card bg-surface">
                  {dayEntries.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => void navigate(`/transactions/${entry.id}`)}
                        className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left transition last:border-b-0 hover:bg-canvas"
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-canvas text-xs text-muted">
                          {entry.categoryIsSystem ? "—" : entry.categoryName.slice(0, 1)}
                        </span>

                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm text-ink">
                            {entry.categoryIsSystem ? "暂无分类" : entry.categoryName}
                            {entry.note ? <span className="text-muted"> · {entry.note}</span> : null}
                          </span>
                          <span className="truncate text-xs text-muted">
                            {formatTimeInZone(entry.occurredAt, entry.occurredTz)}
                            {entry.paymentMethodName ? ` · ${entry.paymentMethodName}` : ""}
                          </span>
                        </span>

                        <span
                          className={`shrink-0 text-sm font-medium tabular-nums ${
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

            {list.hasNextPage ? (
              <button
                type="button"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                className="my-4 w-full rounded-field bg-surface py-3 text-sm text-muted transition hover:text-ink disabled:opacity-50"
              >
                {list.isFetchingNextPage ? "加载中…" : "加载更早的记录"}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <LedgerNav onNavigate={(to) => void navigate(to)} />

      <MonthPicker
        open={pickerOpen}
        month={month}
        maxMonth={currentMonth()}
        onSelect={setMonth}
        onClose={() => {
          setPickerOpen(false);
        }}
      />

      {showAllCurrencies ? (
        <AllCurrenciesSheet
          currencies={currencies}
          mainCode={mainCode}
          onClose={() => {
            setShowAllCurrencies(false);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The bottom bar, plus the space the recording cards need when they are out.
 *
 * The ledger builds its own frame rather than using `TabPage` because it owns
 * its scrolling region — the transition needs to know where the list is — and
 * because the bar's expansion has to reserve real space in this page's column.
 */
function LedgerNav({ onNavigate }: { readonly onNavigate: (to: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(true);

  return (
    <>
      <div
        aria-hidden="true"
        className={`shrink-0 transition-[height] duration-200 ease-out ${open ? "h-[100px]" : "h-0"}`}
      />
      <BottomNav
        active="/"
        onNavigate={onNavigate}
        expanded={open}
        onToggle={() => {
          setOpen((value) => !value);
        }}
      />
    </>
  );
}

/**
 * A tool in the top corner.
 *
 * Both are disabled and say why. The owner's rule holds here as everywhere
 * else: something that looks ready and does nothing is worse than something
 * that admits it is not, and the export button becomes real in S6.
 */
function ToolButton({ label, hint }: { readonly label: string; readonly hint: string }): React.JSX.Element {
  return (
    <button
      type="button"
      disabled
      title={`${label}——${hint}`}
      aria-label={`${label}，${hint}`}
      className="flex size-9 items-center justify-center rounded-full bg-white/15 text-[11px] text-white/60"
    >
      {label}
    </button>
  );
}

function ArrowButton({
  direction,
  tabbable,
  onClick,
}: {
  readonly direction: "left" | "right";
  readonly tabbable: boolean;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      tabIndex={tabbable ? 0 : -1}
      aria-hidden={!tabbable}
      aria-label={direction === "left" ? "上一个月" : "下一个月"}
      className="rounded-full p-1.5 text-white/85 transition hover:bg-white/15"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-5">
        <path
          d={direction === "left" ? "M15 5 8 12l7 7" : "M9 5l7 7-7 7"}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * The account's own currency, given the most room on the screen.
 *
 * With nothing in it for the month it says so, and it stays the same currency.
 * The owner was clear that swapping in whichever currency happened to have
 * entries would cost people the one thing a home screen is for, which is
 * knowing where to look.
 */
function MainCard({
  summary,
  currency,
  className = "",
}: {
  readonly summary: CurrencySummary | null;
  readonly currency: string;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <section className={`${className} flex flex-col justify-center rounded-card bg-white/12 px-5`}>
      <span className="text-xs text-white/75">{currencyName(currency)}</span>

      {summary === null ? (
        <span className="mt-1 text-sm text-white/80">本月暂无数据</span>
      ) : (
        <>
          <span className="text-3xl font-semibold tabular-nums">
            {formatMoney(summary.expenseCents, summary.currency)}
          </span>

          <span className="detail-main-detail mt-1 flex gap-4 text-xs text-white/80 tabular-nums">
            <span>入账 {formatMoney(summary.incomeCents, summary.currency)}</span>
            <span>结余 {formatMoney(summary.balanceCents, summary.currency)}</span>
          </span>
        </>
      )}
    </section>
  );
}

/**
 * A currency other than the primary one.
 *
 * Sized to about a third of the screen so the next card is always partly
 * visible. The owner asked for that specifically, because a row that fits
 * exactly looks like it has nothing more to show, and because a page of
 * currencies should not all have to fit on one screen.
 */
function SecondaryCard({ summary }: { readonly summary: CurrencySummary }): React.JSX.Element {
  return (
    <div
      className="flex shrink-0 snap-start flex-col justify-center rounded-card bg-white/12 px-4"
      style={{ width: "34%" }}
    >
      <span className="text-[11px] text-white/70">{currencyName(summary.currency)}</span>
      <span className="text-base font-medium tabular-nums">
        {formatMoney(summary.expenseCents, summary.currency)}
      </span>
      <span className="text-[11px] text-white/70 tabular-nums">
        结余 {formatMoney(summary.balanceCents, summary.currency)}
      </span>
    </div>
  );
}

/** Every currency the account can use, including the ones with nothing in them. */
function AllCurrenciesSheet({
  currencies,
  mainCode,
  onClose,
}: {
  readonly currencies: readonly CurrencySummary[];
  readonly mainCode: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button type="button" aria-label="关闭" onClick={onClose} className="absolute inset-0 bg-ink/35" />

      <div
        role="dialog"
        aria-label="全部币种"
        className="relative w-full max-w-md rounded-t-card bg-surface px-6 pt-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
      >
        <h2 className="mb-4 text-base font-medium text-ink">全部币种</h2>

        <ul className="flex flex-col gap-2">
          {CURRENCIES.map((code) => {
            const row = currencies.find((item) => item.currency === code);

            return (
              <li key={code} className="flex items-center justify-between rounded-field bg-canvas px-4 py-3">
                <span className="text-sm text-ink">
                  {currencyName(code)}
                  {code === mainCode ? <span className="ml-2 text-xs text-muted">主币种</span> : null}
                </span>

                {row === undefined ? (
                  <span className="text-xs text-muted">本月无记录</span>
                ) : (
                  <span className="text-sm tabular-nums text-ink">
                    {formatMoney(row.expenseCents, row.currency)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-field bg-brand-soft py-3 text-sm font-medium text-brand-dark"
        >
          关闭
        </button>
      </div>
    </div>
  );
}

/** Move a `YYYY-MM` string by whole months. */
function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + delta;
  const nextYear = year + Math.floor(index / 12);
  const nextIndex = ((index % 12) + 12) % 12;
  return `${String(nextYear)}-${String(nextIndex + 1).padStart(2, "0")}`;
}
