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
  const { rootRef, scrollRef, stripRef, atList, goTo } = useDetailTransition(saved.progress);

  /**
   * The recording cards fold away when the list state arrives.
   *
   * The owner asked for this: the summary has just collapsed to give the
   * entries more room, and leaving three cards open underneath would spend
   * that room again on a menu. They are one press away whenever they are
   * wanted, and the transition itself is the signal that they have closed.
   */
  const [entryOpen, setEntryOpen] = useState(() => saved.progress < 1);

  useEffect(() => {
    if (atList) setEntryOpen(false);
  }, [atList]);

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
          <header
            className="detail-hero relative bg-brand px-6 pt-6 pb-7 text-white"
            data-pinned={atList}
          >
            <div className="flex h-9 items-center justify-between">
              <h1 className="detail-title text-2xl font-semibold tracking-tight">Libellum</h1>

              <div className="detail-tools flex gap-2">
                <ToolButton icon={<ShareIcon />} label="导出" hint="导出功能在 S6 阶段实现" />
                <ToolButton icon={<MoreIcon />} label="更多" hint="更多操作即将开放" />
              </div>
            </div>

            {/*
              The month. It starts on its own line under the wordmark and rises
              onto the wordmark's line as the list state arrives — the wordmark
              fades over the same stretch, so the month is moving into space
              being vacated rather than crossing anything. Left-aligned in both
              states: centred, it took horizontal room the currency cards need.
            */}
            <div className="detail-month-row relative mt-2 h-8">
              <div className="flex items-center gap-1">
                <span className="detail-arrow-slot">
                  <ArrowButton
                    direction="left"
                    tabbable={atList}
                    onClick={() => {
                      setMonth(shiftMonth(month, -1));
                    }}
                  />
                </span>

                <button
                  type="button"
                  onClick={() => {
                    setPickerOpen(true);
                  }}
                  className="detail-month inline-flex items-center text-base text-white/95"
                >
                  {year} 年 {monthNumber} 月
                  <span className="detail-caret ml-1 text-[10px] text-white/75" aria-hidden="true">
                    ▼
                  </span>
                </button>

                <span className="detail-arrow-slot">
                  <ArrowButton
                    direction="right"
                    tabbable={atList}
                    onClick={() => {
                      setMonth(shiftMonth(month, 1));
                    }}
                  />
                </span>
              </div>
            </div>

            {summary.isPending ? (
              <div className="mt-4 h-28 animate-pulse rounded-card bg-white/15" />
            ) : (
              /*
               * One strip holding every currency, primary first.
               *
               * It used to be two rows with the primary card above and the rest
               * beside, and the owner worked out why that kept misbehaving: the
               * primary card was not in the strip, so it did not scroll with the
               * others and its width never matched theirs. It is the first child
               * now, and the only thing that changes is its share of the line —
               * a full line while the screen is a home page, and a third of one
               * once it is a list.
               */
              <div
                ref={stripRef}
                data-h-scroll
                className="mt-4 flex flex-wrap gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none] [scroll-snap-type:x_proximity]"
              >
                <MainCard className="detail-main-card" summary={main} currency={mainCode} />

                {others.map((item) => (
                  <SecondaryCard key={item.currency} summary={item} />
                ))}

                <button
                  type="button"
                  onClick={() => {
                    setShowAllCurrencies(true);
                  }}
                  className="detail-currency-card w-30 shrink-0 snap-start px-4 text-left text-xs text-white/90"
                >
                  更多币种
                </button>
              </div>
            )}
          </header>

          {/*
            The expense/income control. It keeps its size and its place — it is
            the seam between the two halves, and a control that moved while the
            things above it collapsed would make the whole change look loose.
          */}
          <div className={`detail-toggle-bar px-6 pt-4 ${atList ? "detail-toggle-sticky" : ""}`}>
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

      <LedgerNav
        open={entryOpen}
        onToggle={() => {
          setEntryOpen((value) => !value);
        }}
        onNavigate={(to) => void navigate(to)}
      />

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
function LedgerNav({
  open,
  onToggle,
  onNavigate,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onNavigate: (to: string) => void;
}): React.JSX.Element {
  return (
    <>
      <div
        aria-hidden="true"
        className={`shrink-0 transition-[height] duration-200 ease-out ${open ? "h-[100px]" : "h-0"}`}
      />
      <BottomNav active="/" onNavigate={onNavigate} expanded={open} onToggle={onToggle} />
    </>
  );
}

/**
 * A tool in the top corner.
 *
 * An icon, not a word. The first version printed 导出 and 更多 in small text on
 * translucent circles and the owner's note was that they read as speech
 * bubbles rather than tools — a word inside a pill looks like something to
 * read, where a mark inside a circle looks like something to press.
 *
 * Both are disabled and say why. The owner's rule holds here as everywhere
 * else: something that looks ready and does nothing is worse than something
 * that admits it is not. Export becomes real in S6.
 */
function ToolButton({
  icon,
  label,
  hint,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly hint: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled
      title={`${label}——${hint}`}
      aria-label={`${label}，${hint}`}
      className="flex size-9 items-center justify-center rounded-full bg-white/15 text-white/70"
    >
      {icon}
    </button>
  );
}

/** A box with an arrow leaving it: the usual mark for getting data out. */
function ShareIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="size-[18px]" aria-hidden="true">
      <path d="M12 15V4M12 4 8.5 7.5M12 4l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" strokeLinecap="round" />
    </svg>
  );
}

/** Three dots: anything that does not deserve its own button yet. */
function MoreIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="size-[18px]" aria-hidden="true">
      <circle cx="5.5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="18.5" cy="12" r="1.7" />
    </svg>
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
      className="detail-arrow rounded-full p-1.5 text-white/85 transition"
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
    <section className={`${className} detail-currency-card px-5`}>
      <span className="detail-main-name text-xs text-white/75">{currencyName(currency)}</span>

      {summary === null ? (
        <span className="mt-1 text-sm text-white/80">本月暂无数据</span>
      ) : (
        <>
          <span className="detail-main-amount font-semibold tabular-nums">
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
 * A fixed width, not a share of the row.
 *
 * A percentage would be measured against the row's *content* box, which shrinks
 * when the row indents to make room for the primary card — so every card got
 * narrower exactly when there was one more of them, which is backwards. A fixed
 * width keeps them all the same and lets the ones that do not fit run off the
 * right edge, which is what the owner asked for: a currency that cannot fit
 * should move along, not shrink everything.
 */
function SecondaryCard({ summary }: { readonly summary: CurrencySummary }): React.JSX.Element {
  return (
    <div className="detail-currency-card h-full w-34 shrink-0 snap-start px-4">
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
