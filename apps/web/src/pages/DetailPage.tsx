import { CURRENCIES, type CurrencySummary, type Transaction, type TransactionKind } from "@libellum/shared";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useAuth } from "../auth/AuthProvider.js";
import { BottomNav } from "../components/BottomNav.js";
import { useEntryMenu } from "../components/Layouts.js";
import { MonthPicker } from "../components/MonthPicker.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { OfflineStatus } from "../components/OfflineStatus.js";
import { ConflictScreen } from "../components/ConflictScreen.js";
import { SyncBanner } from "../components/SyncBanner.js";
import { errorMessage } from "../lib/api.js";
import { useAccountOffline } from "../lib/offline/connectivity.js";
import { currentMonth, formatDayLabel, formatTimeWithZone } from "../lib/datetime.js";
import { readSession, useDetailTransition, writeSession } from "../lib/detailTransition.js";
import { currencyName, formatMoney } from "../lib/format.js";
import {
  filterLocally,
  lastLocalRead,
  ledgerSnapshotValue,
  deletedEntriesValue,
  pendingEntriesValue,
  readLocalTransactions,
  subscribeLedger,
  type ConflictRecord,
  conflictsValue,
  subscribeConflicts,
  subscribeDeleted,
  subscribePending,
} from "../lib/offline/localLedger.js";
import { logOffline } from "../lib/offline/diagnostics.js";
import { syncNow } from "../lib/offline/syncController.js";
import { resolveConflict } from "../lib/offline/write.js";
import {
  hasLocalTransactions,
  useLedger,
  useSummary,
  useTransactions,
  type TransactionFilters,
} from "../lib/queries.js";
import { handOverForScan } from "../lib/scanHandoff.js";

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
   * The recording menu is shared with every other screen.
   *
   * The ledger used to own this state, which was the wrong shape: the cards are
   * the app's way of starting a record, and they are wanted on every screen. The
   * one thing the ledger does differently is fold them when the reader scrolls
   * down into the list — the summary has just collapsed to give the entries
   * room, and leaving a menu open would spend exactly what was won.
   */
  const menu = useEntryMenu();
  const entryOpen = menu.open;

  useEffect(() => {
    if (atList) menu.close();
    // `menu.close` is stable for a given open state, and depending on `menu`
    // would re-run this on every toggle — closing the menu the moment it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * ⚠️ **The merged signal**, not `navigator.onLine`: offline when either the browser says
   * so or a request failed to get an answer. The error panel below keys off this, so it
   * disappears on the strength of a real failed request rather than the browser's guess.
   */
  const { offline } = useAccountOffline();

  const summary = useSummary(month);
  const ledger = useLedger();

  /**
   * ⚠️ **Named once, so the query and the loading gate cannot drift apart.**
   *
   * The skeleton check below has to ask about the *same* filters the query uses — if they ever
   * disagreed, a screen with data would show placeholder rows, which is the bug this whole change
   * is about.
   */
  const filters = { month, kind, categoryId: categoryId ?? undefined };
  const list = useTransactions(filters);

  /**
   * ⚠️ **A loading state that has lasted too long says so.**
   *
   * The owner watched the tablet flicker placeholder rows for over thirty seconds: "他加载了至少有30秒，
   * 期间我很确定我一直在盯着他." **An indefinite skeleton is a screen that never tells the user
   * anything** — it is indistinguishable from a slow network, a dead database and a bug, and the
   * person waiting cannot act on any of them.
   *
   * Three seconds is long enough that a working load never shows it, and short enough that nobody
   * sits through it twice. What appears is honest and actionable: the device holds nothing for this
   * month, and the server could not be reached.
   */
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  const listPending = list.isPending;

  /**
   * ⚠️ **The timer is armed on mount, not on a query state change.**
   *
   * The first version depended on `list.isPending` and cleared itself whenever that was false. The
   * owner reported **no message appearing at all** after more than a minute of flickering
   * placeholders: "还是一直闪，什么字都没有……已经过去了差不多一分钟."
   *
   * A timer that never fires is one that was never started, or one that was cleared by a state
   * change before it could run. **So this one depends on nothing at all** — it is armed once and
   * left alone. Whatever the query is doing, after three seconds the screen explains itself; if the
   * data arrives first the message is simply not rendered, because there is nothing to explain.
   *
   * **A watchdog that can be cancelled by the thing it is watching is not a watchdog.**
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setWaitedTooLong(true);
    }, 3_000);

    return () => {
      window.clearTimeout(timer);
    };
  }, []);

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

  /**
   * ⚠️ **A copy of this month that does not depend on the query layer at all.**
   *
   * The owner's tablet settled a long argument with one measurement: the diagnostics showed
   * `local-read — 磁盘 … → 138 条`, the banner correctly reported 138 entries, **and the screen still
   * flickered placeholders.** The data was found and `isPending` stayed true — so the fault is in the
   * query's state, not in the reading, and no amount of fixing the read was ever going to help.
   *
   * **So the screen stops asking the query whether it has anything.** It reads the device itself, on
   * mount and whenever the view changes, and shows what it finds. The query still runs underneath and
   * still supplies fresher data when it can — `list.data` wins whenever it exists — but a screen with
   * the user's ledger on it can no longer be held hostage by a query state that never settles.
   *
   * ⚠️ **This is what the owner asked for, twice**: "加载超过一秒后，立刻去本地读取数据并运算，显示".
   * It took three rounds to see that the "立刻" part had to bypass the query, because the query is
   * precisely the component that was failing.
   */
  const localEntries = useLocalEntries(filters);

  /**
   * ⚠️ **The pending set comes from the same store mechanism as the ledger**, for the reason this
   * project spent four hours learning: a value that travels through a React state update can be dropped
   * on the device that needs it most.
   */
  const pending = useSyncExternalStore(subscribePending, pendingEntriesValue, pendingEntriesValue);

  /**
   * ⚠️ **What was deleted on this device, and therefore must not appear — whatever the query still holds.**
   *
   * The stored copy of a deleted entry is kept on purpose (round 3 asks the user whether the delete should
   * stand), so the deletion has to be expressed somewhere the merge can see. **Adding nothing cannot remove
   * anything** — which is why the entry the owner deleted stayed on screen: the merge combined the device's
   * list with the query's, and the query still had it.
   */
  const deleted = useSyncExternalStore(subscribeDeleted, deletedEntriesValue, deletedEntriesValue);

  /**
   * ⚠️ **Conflicts are a state of their own, and the green mark could not say so.**
   *
   * The owner's own test showed what that costs: he edited one entry on the tablet and the phone, and the tablet's
   * row **"是绿色的；点击刷新也没用"** — a green row says "waiting to be sent", which is also what a row says when
   * it is retrying a request the server keeps refusing. **There was nothing on screen to tell him a decision was
   * waiting, so there was nothing to tap.**
   */
  const conflicts = useSyncExternalStore(subscribeConflicts, conflictsValue, conflictsValue);

  /** Entry ids waiting for a decision, so a row can say so instead of looking merely unsent. */
  const conflicted = useMemo(
    () => new Set(conflicts.map((conflict) => conflict.mine.id)),
    [conflicts],
  );

  /** The conflict being settled right now, if the user tapped a row. */
  const [settling, setSettling] = useState<ConflictRecord | null>(null);

  /**
   * ⚠️ **The refresh button: read the device again, and deliver what is waiting.**
   *
   * The owner asked for both halves in one sentence: "点击刷新按钮时，它会重新渲染这个网页。并且与此同时触发一次
   * 联网同步判定."
   *
   * ⚠️ **He is right that they belong together, and the reason is that they are the same question.** "Show me
   * what is really there" and "make what I did really reach the server" are two halves of *is my ledger in
   * step* — and a user who has to press one button after another is being made to guess which half is wrong.
   *
   * ⚠️ **`readLocalTransactions` is what re-renders**, because the ledger on screen is read from the store this
   * publishes to. Reloading the page would also "re-render" and would lose the scroll position and the month
   * the user was looking at — **so the honest reading of "重新渲染这个网页" is "show me the current state
   * again", not "reload".**
   */
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (refreshing) return;

    setRefreshing(true);

    try {
      /** ⚠️ Delivery first, so the re-read below reflects anything that just landed. */
      const delivered = await syncNow();

      /**
       * ⚠️ **Both layers are refreshed, not just the store.**
       *
       * The screen merges the device's entries with the query's, so re-reading the device alone would leave the
       * query's stale pages in place — **the same trap as before**: the store is fresh and the list still shows
       * the old data.
       */
      await readLocalTransactions();

      await logOffline(
        "DIAGNOSTIC:manual-refresh",
        delivered > 0 ? `投递 ${String(delivered)} 条` : "没有待投递的改动",
      );
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  const entries = useMemo(() => {
    const fromQuery = (list.data?.pages ?? []).flatMap((page) => page.items);

    /**
     * ⚠️ **Merged, not chosen between — and the owner's report is why.**
     *
     * The previous version used the query when it had anything and the device only when it was empty. That
     * is wrong in one specific and expensive case: **an entry recorded offline is on the device and not yet
     * on the server, so a refetch returns a list without it — and using that list made the entry vanish
     * until the queue drained.** He described exactly that: entries "都消失了；在我首次在在线状态下新增时，
     * 他们才出现".
     *
     * **The server's copy wins for any entry it knows about** — it is the truth, and the device's copy is a
     * copy. **Anything only the device has is still shown**, because it is a real entry the user recorded,
     * and hiding it because a server has not caught up yet is hiding their own work from them.
     *
     * ⚠️ **It also means the pending colour is reachable.** With the query's list taking precedence, an
     * unsynced entry was not on screen at all — so the marker that exists to warn about it had nothing to
     * mark.
     */
    const byId = new Map<string, Transaction>();

    /**
     * ⚠️ **These two lines are the merge, and I deleted them by accident.**
     *
     * A scripted edit replaced the block that filled this map and left the declaration and the read behind, so
     * `byId` was always empty — **and the ledger screen showed "这个月还没有支出" while the owner's entries sat
     * untouched on the server and on the device.** Nothing was deleted; nothing was even hidden. **The screen
     * simply stopped being given anything to draw.**
     *
     * **It is the same shape as the two unwired functions from earlier in this round** — a scripted edit that
     * did not do what I thought, and no check that the result still made sense. **The lesson was already
     * written; what was missing was the verification step, not the knowledge.**
     *
     * ⚠️ **The screen is checked against real data from now on**, not only against the type checker: an empty
     * merge compiles perfectly.
     */
    for (const entry of localEntries) byId.set(entry.id, entry);
    for (const entry of fromQuery) byId.set(entry.id, entry);

    const rows = [...byId.values()];

    return rows;
  }, [list.data, localEntries]);

  /**
   * ⚠️ **One explicit sort, applied to whatever the sources produced.**
   *
   * See `sortByTime`. The owner asked for a separate sorting function called when the screen opens and on
   * every change: "每次打开明细页面时或者明细页面有任何修改（新增账单，修改账单等等）都会单独调用一个排序
   * 函数，排序函数会根据时间把所有的账单排序."
   *
   * **The reason it matters is that every previous attempt sorted as a side effect of something else** — of
   * where the data came from, of which layer happened to answer, of whether a refetch had landed. **That is
   * why the order kept looking shuffled: it was never a decision, it was a leftover.**
   *
   * It runs whenever the entries change, which covers both halves of what he asked for: opening the screen
   * sorts what the device holds, and any write changes the entries so the sort runs again.
   */
  const ordered = useMemo(() => sortByTime(entries), [entries]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Transaction[]>();

    for (const entry of ordered) {
      const bucket = groups.get(entry.occurredLocalDate) ?? [];
      bucket.push(entry);
      groups.set(entry.occurredLocalDate, bucket);
    }

    /**
     * ⚠️ **The day headings are ordered too, by date descending** — a map preserves insertion order, so
     * without this the sections would follow whatever the entries happened to arrive in. **The heading and
     * its contents have to agree about which end is newest.**
     */
    return [...groups.entries()].sort(([left], [right]) => (left < right ? 1 : -1));
  }, [ordered]);

  const isEmptyMonth = list.isSuccess && entries.length === 0;
  const year = month.slice(0, 4);
  const monthNumber = Number(month.slice(5, 7));

  /**
   * ⚠️ **The choice is shown in place of the list, and that is deliberate.**
   *
   * The user reached it by tapping a specific row, so the question is about *that* entry — **a separate route or a
   * sheet would lose the connection between the row they touched and the decision they are making**, and this is
   * the one screen in the app where losing that connection means choosing the wrong version of the wrong entry.
   */
  if (settling !== null) {
    return (
      <div className="detail-root flex h-dvh flex-col overflow-hidden">
        <div className="flex items-center px-6 pt-6 pb-2">
          <button
            type="button"
            onClick={() => {
              setSettling(null);
            }}
            className="text-sm text-muted transition hover:text-ink"
          >
            ← 返回明细
          </button>
        </div>

        <ConflictScreen
          conflict={settling}
          onResolve={(settled) => {
            void (async () => {
              setSettling(null);
              await resolveConflict(settling.mine.id, settled);
            })();
          }}
          onLater={() => {
            setSettling(null);
          }}
        />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="detail-root flex h-dvh flex-col overflow-hidden">
      {/*
        ⚠️ **The ledger builds its own frame, so it needs its own banners.**

        `OfflineStatus` lives in the shared frames — `TabPage` and `InnerPage` — and this
        screen deliberately uses neither, because it owns its scroll position and its hero
        animation. **That is why the download notice appeared everywhere except here**,
        which is what the owner reported: "它只会在分析和账户页面出现，在明细页面则不会弹出."

        Anything added to a shared frame has to be added here too. This is the only screen
        with a frame of its own; if a second one appears, these banners should move into a
        component both can use rather than being copied a third time.
      */}
      <SyncBanner />
      <OfflineStatus />

      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-md flex-col pb-24">
          {/*
            The green area. Its height is the one place a layout size animates,
            and it is contained so the reflow stops here instead of reaching
            the list on every frame.
          */}
          <header
            className="detail-hero relative bg-brand px-6 text-white"
            data-pinned={atList}
          >
            <div className="flex h-9 items-center justify-between">
              <h1 className="detail-title text-2xl font-semibold tracking-tight">Libellum</h1>

              <div className="detail-tools flex gap-2">
                <ToolButton
                  /**
                   * ⚠️ **The icon spins while the sync runs, because "slow" and "nothing is happening" are the
                   * same thing on screen.** The owner's note was "联网的自动刷新比较慢" — and a slow operation
                   * with no sign of activity is indistinguishable from a broken one, which is one of this
                   * project's own lessons: **"没有反馈"和"没有生效"在用户看来没有区别.** The spin continues for at
                   * least as long as the work does, so the button is never silent.
                   */
                  icon={<RefreshIcon spinning={refreshing} />}
                  label="刷新"
                  hint="重新读取并同步账目"
                  busy={refreshing}
                  onClick={() => {
                    void refresh();
                  }}
                />
                <ToolButton
                  icon={<ShareIcon />}
                  label="导出"
                  hint="导出账目"
                  onClick={() => {
                    void navigate("/export");
                  }}
                />
                <ToolButton
                  icon={<MoreIcon />}
                  label="更多"
                  hint="本机存放与待同步印记"
                  onClick={() => {
                    /**
                     * ⚠️ **This button was disabled from the day it was drawn** — "更多操作即将开放" — and the
                     * owner pointed out that the screen it should open already had somewhere to go:
                     * **"明细页面不是还有一个'更多'键没用吗？"**
                     *
                     * ⚠️ **And it is the right home for the clear-marks action**, which had been sitting under
                     * 下载管理: **clearing a "not yet synced" mark is a statement about entries, not about
                     * downloads**, and nobody looking for it would look there.
                     */
                    void navigate("/ledger/more");
                  }}
                />
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
              <>
                {/*
                  The hero card. It only ever leaves — it shrinks and slides off
                  the left edge — and it never has to become one card among
                  equals.

                  The owner proposed this arrangement after watching every fault
                  that comes of asking one element to be two things: text that
                  overflowed, a balance line that faded but kept its space, a
                  width that never matched its neighbours. Two elements, each
                  doing one job, and all of it goes.
                */}
                <MainCard className="detail-main-card mt-4" summary={main} currency={mainCode} />

                {/*
                  One row, never wrapping: the hero card is not in it, so it has
                  only ever to lay out small cards. Its first item is the
                  primary currency's twin, which is nothing until the hero card
                  has gone and then grows into the row.
                */}
                <div
                  data-h-scroll
                  className="detail-strip flex flex-nowrap gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none]"
                >
                  <SmallCard className="detail-twin" summary={main} currency={mainCode} />

                  {others.map((item) => (
                    <SmallCard key={item.currency} summary={item} currency={item.currency} />
                  ))}

                  <button
                    type="button"
                    onClick={() => {
                      setShowAllCurrencies(true);
                    }}
                    className="detail-currency-card detail-small-card w-30 shrink-0 px-4 text-left text-xs text-white/90"
                  >
                    更多币种
                  </button>
                </div>
              </>
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

            {/*
                ⚠️ **Placeholder rows only when there is genuinely nothing to draw.**

                `isPending` alone means "the query has not answered yet" — which on a tablet whose
                database read is slow is a state the user can sit in while the ledger is already on
                the device. The owner reported exactly that: the same screen instant on a phone,
                stuck on a spinner on a tablet.

                `hasLocalTransactions` answers the question the skeleton is really asking — "is
                there anything to show?" — from a synchronous snapshot, so a device that holds
                entries shows them and one that holds nothing still gets the honest skeleton.
              */}
              {/*
                ⚠️ **The skeleton is drawn only while the device genuinely has nothing to show.**

                `hasLocalTransactions` answers the question the skeleton is really asking — "is there
                anything to show?" — from a synchronous snapshot, so a device holding entries shows
                them and one holding nothing still gets the honest placeholder.

                ⚠️ **And after three seconds the explanation replaces it rather than sitting under it.**
                The owner watched the two coexist: "还是一直闪，什么字都没有." Flashing rows above a
                sentence is a screen contradicting itself — one part saying "coming soon" while the
                other says "this is not coming". When the wait is over, the wait indicator goes.
              */}
              {entries.length === 0 && list.isPending && !hasLocalTransactions(filters) && !waitedTooLong ? (
                <SkeletonRows />
              ) : null}

              {/*
                ⚠️ **What was tried, not just that something failed.**

                The owner asked for this: "如果此时没有读到数据或者出现了任何问题，就显示尝试读取数据但
                失败（也可以分得详细些）". A message naming the numbers lets the reader tell a month that
                was never downloaded from a database that is not answering — different problems with
                different fixes, and identical on screen otherwise.
              */}
              {entries.length === 0 && list.isPending && waitedTooLong ? <StuckOnLoad /> : null}

            {/*
              ⚠️ **"加载失败" is suppressed when there is nothing the user can do.**
              
              The owner's report: "在断网的情况下，它会显示加载失败，请求超时，让我检查网络
              后重试。但是在重试下面又会有之前下载好的明细." A hard failure panel above a
              perfectly good list is worse than no panel at all — it tells the user
              something is broken while showing them the thing that is not.
              
              Two conditions, and both are needed:
              
                * **offline** — a request that fails while online is real news, and
                  the retry button is the useful thing to offer;
                * **there are entries to show** — when there are none, an error is the
                  only honest thing on the screen.
              
              The red offline banner above already says what is happening, and says it
              once, which is the point: one message that is read beats two that
              contradict each other.
            */}
            {list.isError && !(offline && entries.length > 0) ? (
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
                    <li
                      key={entry.id}
                      /**
                       * ⚠️ **Two colours, two meanings: green for "not saved yet", red for "not deleted yet".**
                       *
                       * The owner's first request was colour on its own terms — "离线状态下新建出来的记账底色要
                       * 特殊一些…换成浅红色之类的，用来提醒用户，现在还没被备份到服务器" — and when the deletion
                       * side arrived he split it: **"删除印记变为 1 时背景变成淡红色——之前的断网新增账单背景就得
                       * 改一下了，改成淡绿色吧."**
                       *
                       * ⚠️ **He is right, and the reason is that red was carrying two unrelated messages.**
                       *
                       * | Row | Colour | What the user needs to know |
                       * |---|---|---|
                       * | **已删除，服务器还不知道** | **淡红** | it is **still on the server** — the delete has not happened there yet |
                       * | **已新建，服务器还不知道** | **淡绿** | it is **only on this device** — it is not backed up yet |
                       *
                       * A single warning colour for both would say "something is unsynced" and stop, **when the thing
                       * the user has to do about each one is opposite**: one needs the entry to disappear elsewhere,
                       * the other needs it to appear elsewhere.
                       *
                       * ⚠️ **Green rather than an amber warning token**, because green is the palette's calm colour
                       * and an unsynced *addition* is not a problem — it is the feature working. **Red stays reserved
                       * for the case where the two copies disagree about whether something exists.**
                       *
                       * ⚠️ **A deleted row is never rendered at all** — the deletion is applied to the merged list
                       * before this point (see above). So in practice a row here is red only if it is deleted while
                       * visible, and the honest reading is "this will go, once the server hears about it".
                       */
                      className={
                        deleted.has(entry.id)
                          ? "bg-danger-soft line-through decoration-danger/40"
                          : conflicted.has(entry.id)
                            ? "bg-warn-soft"
                            : pending.has(entry.id)
                              ? "bg-brand-soft"
                              : undefined
                      }
                    >
                      <button
                        type="button"
                        onClick={() => {
                          /**
                           * ⚠️ **A conflicted row opens the choice, not the editor.**
                           *
                           * Opening the editor would let the user make a *third* version of an entry that already
                           * has two — and the question "which of these two do you want" would never be asked.
                           */
                          const waiting = conflicts.find((conflict) => conflict.mine.id === entry.id);

                          if (waiting !== undefined) {
                            setSettling(waiting);

                            return;
                          }

                          void navigate(`/transactions/${entry.id}`);
                        }}
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
                            {formatTimeWithZone(entry.occurredAt, entry.occurredTz)}
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

      {/*
        Which ledger this is.
        
        The owner asked for this on every screen once several ledgers exist, and
        it earns its place even before then: the number is what two people say
        out loud to confirm they are looking at the same one. A ledger somebody
        has been invited into can be called anything, so the name alone is not
        enough.
        
        ⚠️ **Moved here at his request, and the placement is the point.** It was
        first tried above the expense/income control, floating on a pill over the
        seam — he called it ugly, and he was right: it cut the control off from
        the list it belongs to and looked like a stray label. 
        
        It now sits **above the bar and outside it**: to the left, in line with
        the 明细 and 分析 tabs directly beneath it, so it reads as a caption for
        the whole screen rather than a badge on one control.
        
        Two constraints that decided the exact placement:
        
          * **Outside the bar, not inside it.** Inside, it would be a sixth thing
            competing with five tabs for a phone's width, and it would move
            whenever the tab row did.
          * **Still part of the column, not the scrolling region.** Being a flex
            sibling of the scroll area means it cannot be scrolled away — "which
            ledger am I adding to" is a question you ask mid-list, so the answer
            has to be there mid-list. It also cannot affect the transition: the
            green area's height is the only thing that animates.
        
        Hidden while the recording cards are open, because those cards are 100px
        of buttons immediately above this line and a caption underneath a menu is
        just noise.
      */}
      {ledger.data === undefined || entryOpen ? null : (
        <p className="shrink-0 truncate px-6 pt-2 text-[11px] text-muted">
          当前账本：{ledger.data.book.name}
          {ledger.data.book.bookNumber === null ? null : (
            <span className="ml-1.5 font-mono">{ledger.data.book.bookNumber}</span>
          )}
        </p>
      )}

      <LedgerNav
        open={entryOpen}
        onToggle={menu.toggle}
        onNavigate={(to) => void navigate(to)}
        onPickImages={(chosen) => {
          /**
           * Straight from the tap to recognition.
           *
           * The card has just opened the picker and has the pictures; this hands
           * them over in memory and goes to the screen that recognises them. The
           * user's two presses — 拍照, then choosing a picture — are the whole
           * interaction, where before there was a screen in between whose only
           * job was to ask for the picture again.
           */
          handOverForScan(chosen);
          void navigate("/scan");
        }}
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
 *
 * The cards behave the same here as on every other screen — pressing the button
 * unfolds three ways to record. The difference is only that the ledger folds
 * them itself when the reader scrolls into the list; see the call site.
 *
 * The ledger is also where 拍照 gets the picker-direct behaviour: this is the
 * main screen, so it is where somebody is most likely to press that card, and
 * the two taps saved are saved here first.
 */
function LedgerNav({
  open,
  onToggle,
  onNavigate,
  onPickImages,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onNavigate: (to: string) => void;
  readonly onPickImages: (files: File[]) => void;
}): React.JSX.Element {
  return (
    <>
      <div
        aria-hidden="true"
        className={`shrink-0 transition-[height] duration-200 ease-out ${open ? "h-[100px]" : "h-0"}`}
      />
      <BottomNav
        active="/"
        onNavigate={onNavigate}
        cards={{ mode: "toggle", expanded: open, active: true, onToggle }}
        onPickImages={onPickImages}
      />
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
 * With no `onClick` it is disabled and says why, which is the honest state for a
 * tool that does not exist yet — the owner's rule: something that looks ready
 * and does nothing is worse than something that admits it is not. Export now has
 * a destination and is live; 更多 still does not.
 */
function ToolButton({
  icon,
  label,
  hint,
  onClick,
  busy,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly hint: string;
  readonly onClick?: () => void;
  /** ⚠️ Shows that the action is running, and blocks a second press. */
  readonly busy?: boolean;
}): React.JSX.Element {
  const disabled = onClick === undefined || busy === true;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-busy={busy === true}
      title={busy === true ? `${label}——正在进行` : `${label}——${hint}`}
      aria-label={`${label}，${hint}`}
      className={`flex size-9 items-center justify-center rounded-full transition ${
        disabled
          ? "bg-white/15 text-white/70"
          : "bg-white/20 text-white hover:bg-white/30 active:bg-white/40"
      }`}
    >
      {icon}
    </button>
  );
}

/** A box with an arrow leaving it: the usual mark for getting data out. */
/**
 * A circular arrow, matching the weight and size of the two beside it.
 *
 * ⚠️ **Same stroke, same box, same `size-[18px]` as `ShareIcon` and `MoreIcon`** — the owner asked for the
 * animation and weight to match the other two, and a button that looks subtly different from its neighbours
 * reads as a different kind of control.
 */
function RefreshIcon({ spinning = false }: { readonly spinning?: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      /**
       * ⚠️ **`animate-spin` on the icon, and the rotation is the whole feedback.** A refresh that takes a
       * second and shows nothing looks like a button that does not work — **and the user then presses it
       * again**, which is why the handler also ignores a second press while one is running.
       */
      className={`size-[18px] ${spinning ? "animate-spin" : ""}`}
      aria-hidden="true"
    >
      <path d="M20 12a8 8 0 1 1-2.6-5.9" strokeLinecap="round" />
      <path d="M20 4v4.5h-4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
 * One small currency card.
 *
 * Every card in the strip is this, including the primary currency's twin, so
 * they cannot drift apart in size, type or content — which is what the owner
 * kept seeing when the primary card was also trying to be one of them.
 *
 * A fixed width rather than a share of the row: a percentage is measured
 * against the row's content box, and a card that changes width when a
 * neighbour appears is a card that looks smaller the more there are. The ones
 * that do not fit run off the right edge instead.
 *
 * A currency with nothing in it this month says so, rather than showing zero —
 * the twin exists in both states, and in a month with no entries it would
 * otherwise claim the account had spent nothing.
 */
function SmallCard({
  summary,
  currency,
  className = "",
}: {
  readonly summary: CurrencySummary | null;
  readonly currency: string;
  readonly className?: string;
}): React.JSX.Element {
  return (
    /*
     * The padding lives inside, not on the card.
     *
     * On the card it is part of its width, so the twin — which is nothing until
     * the hero card has left — still measured thirty-two pixels and left a hole
     * in front of the first real card. The owner saw that hole in the display
     * state before anything had moved.
     */
    <div className={`detail-currency-card detail-small-card w-34 shrink-0 ${className}`}>
      <div className="flex h-full flex-col justify-center px-4">
        <span className="text-[11px] whitespace-nowrap text-white/70">{currencyName(currency)}</span>
        {summary === null ? (
          <span className="text-[11px] whitespace-nowrap text-white/60">暂无数据</span>
        ) : (
          <>
            <span className="text-base font-medium tabular-nums whitespace-nowrap">
              {formatMoney(summary.expenseCents, summary.currency)}
            </span>
            <span className="text-[11px] whitespace-nowrap text-white/70 tabular-nums">
              结余 {formatMoney(summary.balanceCents, summary.currency)}
            </span>
          </>
        )}
      </div>
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

/**
 * Put the ledger in the order it is always shown in: newest first, oldest last.
 *
 * ⚠️ **A named function, called from one place, because the order must not depend on anything else.**
 *
 * The owner asked for exactly this: "每次打开明细页面时或者明细页面有任何修改（新增账单，修改账单等等）
 * 都会单独调用一个排序函数，排序函数会根据时间把所有的账单排序."
 *
 * **Every previous attempt sorted as a side effect of something else** — of where the data came from, of
 * which layer happened to answer, of whether a refetch had landed. That is why the order kept looking
 * shuffled: **it was never a decision, it was a leftover.** A single explicit sort, applied to whatever the
 * sources produced, makes the order a decision.
 *
 * It runs whenever the entries change, which covers both halves of his request: opening the screen sorts
 * what the device holds, and any write changes the entries, so the sort runs again.
 *
 * ⚠️ **Ties fall back to the id.** Two entries recorded in the same second must keep a stable relative
 * order, or they swap places between renders — **and a list that reshuffles while being read is worse than
 * one that is slightly wrong.**
 */
export function sortByTime(entries: readonly Transaction[]): readonly Transaction[] {
  return [...entries].sort((left, right) => {
    /**
     * ⚠️ **Compared as instants, never as strings — and that was a real bug, not a precaution.**
     *
     * The first version compared `occurredAt` lexicographically. That is only correct when every entry
     * carries the same UTC offset, and **this ledger holds entries recorded in two different zones**: the
     * owner was in California (UTC-7) while other entries were recorded in UTC+8.
     *
     * ```
     * "2026-10-11T20:00:00.000-07:00"   -> 03:00 UTC the next day   (actually the newest)
     * "2026-10-11T19:09:00.000+08:00"   -> 11:09 UTC that day
     * ```
     *
     * String order reads the second as *later*, because it compares the digits `19` and `20` and **never
     * looks at the offset**. So an entry recorded at eight in the evening sorted below one recorded at seven,
     * for no reason visible on screen — which is exactly what he reported: "他们都是在晚上8点…记得，应该在
     * 最前面才对."
     *
     * **Two instants compare by when they happened; two ISO strings compare by how they are spelled.**
     */
    const leftAt = Date.parse(left.occurredAt);
    const rightAt = Date.parse(right.occurredAt);

    /**
     * ⚠️ **An unparsable value sorts last rather than throwing.** One malformed timestamp must not take the
     * whole screen down, and an entry whose time cannot be read belongs at the bottom rather than nowhere.
     */
    if (Number.isNaN(leftAt) || Number.isNaN(rightAt)) {
      if (Number.isNaN(leftAt) && Number.isNaN(rightAt)) return left.id < right.id ? 1 : -1;

      return Number.isNaN(leftAt) ? 1 : -1;
    }

    if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;

    /** ⚠️ Same instant: a stable tiebreak, so two entries never swap places between renders. */
    return left.id < right.id ? 1 : -1;
  });
}

/**
 * This month's entries, read straight from the device.
 *
 * ⚠️ **`useSyncExternalStore`, not `useState`, and that change is the fix.**
 *
 * The owner's tablet read the ledger correctly — 138 entries, reported by the diagnostics and by the
 * banner — and the screen stayed on its placeholder rows through several attempts, **including one
 * that passed the read's result straight into `useState`.** The state updater ran and the component
 * did not re-render, which is a reported WebKit/React interaction rather than anything about the data
 * ([React #22459](https://github.com/react/react/issues/22459)). The device is an iPad Pro, so the
 * rendering is not the weak link.
 *
 * **So the answer is not to make the work smaller — it is to stop routing the answer through a
 * mechanism that can drop it.** `useSyncExternalStore` reads the value **synchronously during render**
 * and re-renders when the store changes, so the entries are present the next time anything renders,
 * however that render was triggered.
 *
 * It does not poll: one read is kicked off on mount and whenever the view changes. **Re-reading a
 * hundred-kilobyte blob on a timer is the cost that made the tablet struggle in the first place**, and
 * the data only changes when the user does something.
 */
function useLocalEntries(filters: TransactionFilters): readonly Transaction[] {
  /**
   * ⚠️ **The stored value is the whole ledger**, so this subscribes to that and filters on read.
   *
   * Filtering inside the snapshot getter would return a new array every call, and
   * `useSyncExternalStore` compares snapshots by identity — a new array each time is an infinite
   * render loop.
   */
  const all = useSyncExternalStore(subscribeLedger, ledgerSnapshotValue, ledgerSnapshotValue);

  /**
   * The filters as strings, so this effect compares values rather than object identity — otherwise a
   * fresh object literal every render would re-read the whole cache every render, which is the bug
   * being fixed.
   */
  const month = filters.month ?? "";
  const kind = filters.kind ?? "";
  const categoryId = filters.categoryId ?? "";
  const currency = filters.currency ?? "";

  useEffect(() => {
    /**
     * ⚠️ **Fired and not awaited.** The result arrives through the store, so there is nothing to do
     * with it here — and awaiting it inside the effect would put the update back on the path that was
     * failing.
     */
    void readLocalTransactions();
  }, [month, kind, categoryId, currency]);

  return useMemo(
    () =>
      filterLocally(all, {
        ...(month === "" ? {} : { month }),
        ...(kind === "" ? {} : { kind: kind as Transaction["kind"] }),
        ...(categoryId === "" ? {} : { categoryId }),
        ...(currency === "" ? {} : { currency }),
      }),
    [all, month, kind, categoryId, currency],
  );
}

/**
 * Why a screen is still waiting, in terms a person can act on.
 *
 * ⚠️ **Two different problems, told apart on screen.**
 *
 * "It will not load offline" has two very different causes and the owner has hit both:
 *
 *  * **the device holds nothing for this view** — a download that never happened, or a month outside
 *    the range that was downloaded. Fixable by downloading, and the message says so;
 *  * **the device was never successfully read** — the cache is there but something failed. Fixable
 *    by nothing the user can do, and the message says that instead of sending them to re-download.
 *
 * Telling them apart needs the counts from the last local read, which is why that is recorded at all.
 */
function StuckOnLoad(): React.JSX.Element {
  const read = lastLocalRead();

  const nothingStored = read.at === 0 || read.total === 0;

  return (
    <div className="flex flex-col gap-1.5 py-3 text-center text-xs leading-relaxed text-muted">
      {nothingStored ? (
        <>
          <p>本机没有这一段时间的记录，而且现在连不上服务器。</p>
          <p>联网后会自动补上；也可以在「账户 → 下载管理」里提前下载。</p>
        </>
      ) : (
        <>
          <p>本机有 {read.total} 条记录，但这次没能读到。</p>
          <p>联网后会自动恢复。</p>
        </>
      )}

      {/* The numbers, so the line above can be checked rather than believed. */}
      <p className="font-mono text-[10px] opacity-70">
        {read.at === 0
          ? "本机读取：尚未尝试"
          : `本机读取：本机存储 ${String(read.storedEntries)} 条 / 查询缓存 ${String(read.diskEntries)} 条 / 内存 ${String(read.liveEntries)} 条 / 合计 ${String(read.total)} 条${
              read.note === null ? "" : `（${read.note}）`
            }`}
      </p>
    </div>
  );
}
