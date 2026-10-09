import type { Transaction, TransactionKind } from "@libellum/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { ErrorState, EmptyState, SkeletonRows } from "../components/States.js";
import { EntryIsland } from "../components/EntryIsland.js";
import { KindToggle } from "../components/KindToggle.js";
import { TabPage } from "../components/Layouts.js";
import { errorMessage } from "../lib/api.js";
import { formatTimeInZone, formatDayLabel, currentMonth } from "../lib/datetime.js";
import { formatMoney } from "../lib/format.js";
import { useLedger, useSummary, useTransactions } from "../lib/queries.js";
import { useDetailScroll, usePrefersReducedMotion } from "../lib/useDetailScroll.js";

const VISIBLE_CURRENCIES = 2;

/**
 * Where the vertical island sits.
 *
 * Expressed from the bottom so it clears the tab bar whatever the screen
 * height, and so the avoidance band below can be worked out from the same
 * number rather than guessed twice.
 */
const ISLAND_BOTTOM_PX = 104;
const ISLAND_HEIGHT_PX = 196;

export function DetailPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * Filters can arrive in the address.
   *
   * The analysis screen links here with a category and a month already chosen,
   * so a slice of the ring is one tap away from the entries behind it — a
   * number on its own is never what the user wanted to see.
   */
  const [month, setMonth] = useState(() => searchParams.get("month") ?? currentMonth());
  const [kind, setKind] = useState<TransactionKind>("expense");
  const [showAllCurrencies, setShowAllCurrencies] = useState(false);

  const categoryId = searchParams.get("categoryId");

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { mode, isScrolling, expandedByUser, expand } = useDetailScroll(scrollRef, sentinelRef);
  const reducedMotion = usePrefersReducedMotion();

  const summary = useSummary(month);
  const ledger = useLedger();
  const list = useTransactions({ month, kind, categoryId: categoryId ?? undefined });

  useIslandAvoidance(scrollRef, listRef, mode === "list");

  const clearCategoryFilter = (): void => {
    const next = new URLSearchParams(searchParams);
    next.delete("categoryId");
    setSearchParams(next, { replace: true });
  };

  const filteredCategory =
    categoryId === null
      ? undefined
      : ledger.data?.categories.find((category) => category.id === categoryId);

  const currencies = summary.data?.currencies ?? [];
  const visible = showAllCurrencies ? currencies : currencies.slice(0, VISIBLE_CURRENCIES);
  const hiddenCount = Math.max(currencies.length - VISIBLE_CURRENCIES, 0);

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

  /**
   * The island's three shapes.
   *
   * Collapsed only ever happens while the list is actually moving — a state
   * that exists to stop the island competing with content flying past it.
   * Pressing it reopens the choices rather than picking one, which is what the
   * owner asked for and the only reading that is not a surprise.
   */
  const collapsed = mode === "list" && isScrolling && !expandedByUser;

  const summaryHeader = (
    <>
      <MonthSwitcher month={month} onChange={setMonth} />

      {categoryId === null ? null : (
        <div className="flex items-center gap-2 self-start rounded-full bg-white/15 px-3 py-1.5 text-xs text-white">
          <span>已筛选分类：{filteredCategory?.name ?? "载入中…"}</span>
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
        <div className="h-24 animate-pulse rounded-field bg-white/15" />
      ) : currencies.length === 0 ? (
        <p className="py-3 text-sm text-white/85">本月还没有记账</p>
      ) : (
        <div className="flex flex-col gap-5">
          {visible.map((item) => (
            <CurrencyBlock key={item.currency} summary={item} />
          ))}

          {hiddenCount > 0 || currencies.length > VISIBLE_CURRENCIES ? (
            <button
              type="button"
              onClick={() => {
                setShowAllCurrencies((current) => !current);
              }}
              className="flex items-center justify-between rounded-full bg-black/12 px-4 py-2 text-xs text-white/90 transition hover:bg-black/20"
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
    </>
  );

  return (
    <TabPage active="/" onNavigate={(to) => void navigate(to)} scrollRef={scrollRef}>
      <header
        className={`flex flex-col gap-5 bg-brand px-6 pt-7 text-white transition-[padding] duration-200 ${
          reducedMotion ? "" : "ease-out"
        } ${mode === "hero" ? "pb-7" : "pb-6"}`}
      >
        {summaryHeader}

        {/*
          The island sits at the foot of the green area rather than floating
          over it, and the compact toggle shares its row. Reserved space means
          the summary can grow later — a chart, a spending overview — without
          this row having to move.
        */}
        <div className="flex items-center justify-between gap-3 pt-1">
          <EntryIsland orientation="horizontal" />
          <KindToggle kind={kind} onChange={setKind} variant="inline" />
        </div>
      </header>

      {/* The boundary between the two layouts. Measured rather than guessed:
          the summary's height depends on how many currencies there are. */}
      <div ref={sentinelRef} aria-hidden="true" className="h-px" />

      {mode === "list" ? (
        <div className="sticky top-0 z-20 flex items-center gap-3 bg-brand px-4 py-2.5 text-white">
          <button
            type="button"
            // Reaching the month arrows means going back to the summary, which
            // is exactly where they live. A date picker of its own would be a
            // second way to do the same thing.
            onClick={() => {
              scrollRef.current?.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
            }}
            className="shrink-0 rounded-full bg-white/25 px-3.5 py-1.5 text-sm font-medium tabular-nums transition active:bg-white/35"
            aria-label={`当前月份 ${month}，点击回到顶部切换月份`}
          >
            {month.slice(2, 4)}/{month.slice(5, 7)}
          </button>

          <KindToggle kind={kind} onChange={setKind} variant="compact" />
        </div>
      ) : null}

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
          description="用左侧的记账岛记下第一笔。"
          actionLabel="记一笔"
          onAction={() => void navigate("/add")}
        />
      ) : null}

      <div ref={listRef} className="flex flex-col px-6 pt-3">
        {grouped.map(([day, dayEntries]) => (
          <section key={day}>
            <h2 className="py-2 text-xs text-muted">{formatDayLabel(day)}</h2>
            <ul className="overflow-hidden rounded-card bg-surface">
              {dayEntries.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => void navigate(`/transactions/${entry.id}`)}
                    className="entry-row flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-canvas"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-canvas text-xs text-muted">
                      {entry.categoryIsSystem ? "—" : entry.categoryName.slice(0, 1)}
                    </span>

                    {/* One truncated line, never wrapped: this is what lets the
                        island's inset change without the row re-flowing. */}
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

      {/*
        Fixed to the viewport rather than the scroll area, so it stays put while
        the list moves. Only the buttons themselves take touches — the wrapper
        is sized to them, so the rest of the screen scrolls normally.
      */}
      {mode === "list" ? (
        <div
          className="fixed left-1.5 z-30 transition-opacity duration-200"
          style={{ bottom: `${String(ISLAND_BOTTOM_PX)}px` }}
        >
          <EntryIsland orientation="vertical" collapsed={collapsed} onExpand={expand} />
        </div>
      ) : null}
    </TabPage>
  );
}

/**
 * Give the rows inside the island's band room to breathe.
 *
 * An IntersectionObserver with a `rootMargin` that shrinks the scroll area to
 * just the band the island occupies. Two reasons it is an observer and not a
 * scroll handler: it costs nothing on the scroll thread, and it reports only
 * crossings — so a row is touched twice per pass rather than on every frame.
 *
 * The alternative — permanently indenting every row — would avoid the problem
 * by making the whole list narrower for a control that is only in the way some
 * of the time.
 */
function useIslandAvoidance(
  containerRef: React.RefObject<HTMLElement | null>,
  listRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    const container = containerRef.current;
    const list = listRef.current;

    if (!active || container === null || list === null) {
      // Clear any marks left from the previous layout, or the rows would stay
      // indented after returning to the summary.
      for (const row of list?.querySelectorAll<HTMLElement>(".entry-row") ?? []) {
        delete row.dataset["avoid"];
      }
      return;
    }

    if (typeof IntersectionObserver !== "function") return;

    const height = container.clientHeight;
    const bandBottom = height - ISLAND_BOTTOM_PX;
    const bandTop = Math.max(bandBottom - ISLAND_HEIGHT_PX, 0);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const row = entry.target as HTMLElement;
          if (entry.isIntersecting) row.dataset["avoid"] = "true";
          else delete row.dataset["avoid"];
        }
      },
      {
        root: container,
        // Shrink the root to the band: the island's vertical span only.
        rootMargin: `-${String(Math.round(bandTop))}px 0px -${String(Math.round(height - bandBottom))}px 0px`,
        threshold: 0,
      },
    );

    for (const row of list.querySelectorAll(".entry-row")) observer.observe(row);

    return () => {
      observer.disconnect();
    };
  }, [containerRef, listRef, active]);
}

function MonthSwitcher({
  month,
  onChange,
}: {
  readonly month: string;
  readonly onChange: (month: string) => void;
}): React.JSX.Element {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];

  const shift = (delta: number): void => {
    const zeroBased = monthNumber - 1 + delta;
    const nextYear = year + Math.floor(zeroBased / 12);
    const nextMonth = ((zeroBased % 12) + 12) % 12;

    onChange(`${String(nextYear)}-${String(nextMonth + 1).padStart(2, "0")}`);
  };

  return (
    <div className="flex items-center justify-between px-1">
      <button
        type="button"
        onClick={() => {
          shift(-1);
        }}
        aria-label="上一个月"
        className="rounded-full p-2 text-white/85 transition hover:bg-white/15 hover:text-white"
      >
        <Chevron direction="left" />
      </button>

      <span className="text-base font-medium tracking-wide">
        {year} 年 {monthNumber} 月
      </span>

      <button
        type="button"
        onClick={() => {
          shift(1);
        }}
        aria-label="下一个月"
        className="rounded-full p-2 text-white/85 transition hover:bg-white/15 hover:text-white"
      >
        <Chevron direction="right" />
      </button>
    </div>
  );
}

function Chevron({ direction }: { readonly direction: "left" | "right" }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
      aria-hidden="true"
    >
      <path
        d={direction === "left" ? "M15 5 8 12l7 7" : "M9 5l7 7-7 7"}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface CurrencySummaryLike {
  readonly currency: string;
  readonly expenseCents: number;
  readonly incomeCents: number;
}

function CurrencyBlock({ summary }: { readonly summary: CurrencySummaryLike }): React.JSX.Element {
  const net = summary.incomeCents - summary.expenseCents;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-white/75">{currencyName(summary.currency)}</span>

      <div className="flex items-baseline gap-4">
        <span className="text-2xl font-semibold tabular-nums">
          {formatMoney(summary.expenseCents, summary.currency)}
        </span>
        <span className="text-xs text-white/80 tabular-nums">
          入账 {formatMoney(summary.incomeCents, summary.currency)}
        </span>
      </div>

      <span className={`text-xs tabular-nums ${net < 0 ? "text-white/75" : "text-white/90"}`}>
        结余 {formatMoney(net, summary.currency)}
      </span>
    </div>
  );
}

function currencyName(currency: string): string {
  const names: Record<string, string> = {
    CNY: "人民币",
    USD: "美元",
    EUR: "欧元",
    JPY: "日元",
    HKD: "港币",
    GBP: "英镑",
  };

  return names[currency] ?? currency;
}
