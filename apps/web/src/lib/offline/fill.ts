import type { TransactionListResponse } from "@libellum/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../api.js";
import { queryKeys, transactionFilters } from "../queries.js";
import { logOffline } from "./diagnostics.js";
import { readNeverMonths } from "./downloadManager.js";

/**
 * Filling in the months the user has never opened.
 *
 * ⚠️ **This is the gap the owner found by testing**, and it is worth stating
 * exactly. The detail screen loads **one month at a time** — `useInfiniteQuery`
 * with a cursor, and a "载入更多" button for the rest — which is right for the
 * screen and wrong for offline. Only months somebody actually looked at were ever
 * fetched, so only those were in the cache. He opened the app on a plane and found
 * "曾经打开过的数据" and nothing else.
 *
 * Caching harder would not have helped: **a cache only holds what was asked for.**
 * The fix is to ask for all of it, on purpose, while there is a network.
 *
 * **Month by month, reusing the screen's own query keys**, rather than a separate
 * "download everything" endpoint. Three reasons, and the third is the important
 * one:
 *
 *  1. no new API, so nothing on the server has to change or be kept in step;
 *  2. it fills **the same cache entries the screen reads**, so the screen finds
 *     them already there — no second source of truth to reconcile;
 *  3. it can **stop and resume**. Sixty months on a phone connection is not one
 *     request; it is sixty, and the user may close the app in the middle. Whatever
 *     finished is already useful, and the next launch carries on.
 *
 * **The cost is real and is not hidden**: this is the whole ledger over the
 * network. So it runs once, it is bounded, it reports progress, and it is skipped
 * entirely when the browser says it is on a metered connection.
 */

/**
 * How far back to go when nobody says.
 *
 * Five years of months. A bound rather than "until the server runs out": an
 * unbounded loop against a cursor is a loop that can run for a very long time on a
 * phone, and a ledger older than five years is not what somebody needs on a plane.
 * The user can ask for more.
 */
export const DEFAULT_MONTHS_BACK = 60;

/** `2026-10` for a date, in local time. */
export function monthOf(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");

  return `${String(year)}-${month}`;
}

/**
 * The months to fetch, newest first.
 *
 * Pure, so the arithmetic that decides what "the whole history" means is testable
 * without a network. Getting it wrong is quiet: a missing month is a month the
 * user finds blank while offline, months later.
 */
export function monthsToFetch(now: Date, count: number): readonly string[] {
  const months: string[] = [];

  for (let back = 0; back < count; back += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - back, 1);
    months.push(monthOf(date));
  }

  return months;
}

/**
 * Whether to hold off on the **automatic** fill.
 *
 * ⚠️ **Deliberately conservative, after it caused a real failure.** The first version
 * treated `effectiveType === "3g"` as metered. That value is the browser's *estimate*,
 * it changes constantly, and **Safari reports it on Wi-Fi more often than anybody would
 * expect** — so the automatic fill could decide the user was on mobile data while they
 * were at home, and skip for ever. The symptom is a download that never happens and no
 * error anywhere, which is exactly what the owner reported.
 *
 * So only two things count now:
 *
 *  *  **`saveData`** — the user's own "do not use much data" setting. That is an
 *     instruction, not a guess, and honouring it is the point.
 *  *  **`slow-2g` / `2g`** — a connection where sixty requests would take minutes.
 *
 * **The button is never held off**, whatever this says: see `start`. Somebody who
 * presses it has asked, and a silent refusal is worse than a download they did not
 * want.
 */
export function isMeteredConnection(): boolean {
  if (typeof navigator === "undefined") return false;

  const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } })
    .connection;

  if (connection === undefined) return false;
  if (connection.saveData === true) return true;

  return connection.effectiveType === "slow-2g" || connection.effectiveType === "2g";
}

/**
 * How many entries to ask for per request.
 *
 * ⚠️ **Not the screen's default of 50, and this is not a tuning choice.**
 *
 * Measured against the real ledger: October 2026 holds **61 entries**, and the
 * default page returns the first 50 with a cursor for the rest. So filling a month
 * with the default limit would have left eleven entries on the server — offline,
 * the month would simply be short, with a subtotal that did not add up and nothing
 * to say so. **A quietly incomplete ledger is the worst failure this feature can
 * have**, because the user's whole reason for keeping one is that it is right.
 *
 * The API's own ceiling, so a month is usually one request and never more than a
 * few.
 */
const FILL_PAGE_SIZE = 100;

/**
 * How many pages one month may need.
 *
 * A guard rather than a calculation: a month is a few pages at the API's ceiling, and
 * the only thing this protects against is a server that keeps offering a cursor and
 * would otherwise spin for ever on somebody's phone.
 */
const MAX_FILL_PAGES = 40;

export interface OfflineFill {
  /** Months finished, and how many were planned. */
  readonly done: number;
  readonly total: number;
  readonly running: boolean;
  /** Set when it stopped early, with a sentence worth showing. */
  readonly stopped: string | null;
  /** Whether it skipped itself because the connection is metered. */
  readonly skippedMetered: boolean;
  /**
   * When the last run finished, or `null` if none has.
   *
   * ⚠️ **A timestamp rather than a boolean, and that is what fixes the notice.**
   *
   * The owner reported: "下载完成弹窗会在每一次打开账户和分析页面时出现，十秒后消失".
   * The cause is that the *component* owned the ten seconds — so every screen mount
   * started a fresh countdown, and the notice reappeared for ever as the user moved
   * around. **The window belongs to the download, not to whoever is looking at it.**
   *
   * With a timestamp, every screen computes the same answer from the same fact:
   * "less than ten seconds ago" is true everywhere at once, and false everywhere at
   * once.
   */
  readonly justFinishedAt: number | null;
  /**
   * Fetch months into the local copy.
   *
   * With no argument: everything missing, back `DEFAULT_MONTHS_BACK` months. With
   * an explicit list: exactly those months, which is what the download manager's
   * per-month screen needs to re-fetch one the user deleted.
   */
  readonly start: (months?: readonly string[]) => Promise<void>;
}

/**
 * Fill the cache with the whole history, one month per request.
 *
 * Everything already cached is skipped, so calling this on every launch is cheap
 * after the first time — which is what makes it safe to leave switched on rather
 * than something the user has to remember to press.
 */
/**
 * Whether this page load has already started the automatic fill.
 *
 * Module scope rather than a ref: the guard has to survive a remount, and a ref does
 * not. Cleared only by a reload, which is the same thing as "once per visit".
 */
let autoFillStarted = false;

export function useOfflineFill(options: { readonly enabled: boolean }): OfflineFill {
  const queryClient = useQueryClient();
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState<string | null>(null);
  const [skippedMetered, setSkippedMetered] = useState(false);
  const [justFinishedAt, setJustFinishedAt] = useState<number | null>(null);

  /**
   * A ref as well as state, because `start` must not depend on the render it was
   * created in: this runs once per launch from an effect, and a stale closure
   * there would restart the whole download.
   */
  const runningRef = useRef(false);

  const start = useCallback(
    async (requested?: readonly string[]) => {
      if (runningRef.current) return;

      /**
       * ⚠️ **An explicit request ignores the metered check**; the automatic one does
       * not.
       *
       * The background fill running itself on a phone connection is a download the
       * user did not ask for, so it waits for Wi-Fi. But somebody who has opened the
       * download manager and pressed "下载全部" *has* asked — and silently doing
       * nothing is the worst possible answer. That is very close to what happened
       * here: the button looked broken, and the reason was a check the user could
       * not see.
       */
      const explicit = requested !== undefined;

      /**
       * ⚠️ **Every attempt is written down**, because four rounds of reading this file
       * did not explain why the button appeared to do nothing. See `diagnostics.ts`.
       */
      await logOffline(explicit ? "手动下载" : "自动下载", explicit ? `月份：${requested.join("、")}` : undefined);

      if (!explicit && isMeteredConnection()) {
        await logOffline("已跳过", "浏览器报告省流量或 2G/慢速网络");
        setSkippedMetered(true);
        return;
      }

      if (isMeteredConnection()) {
        await logOffline("（流量网络，但你手动要求，继续）");
      }

      setSkippedMetered(false);

      const months = explicit ? requested : monthsToFetch(new Date(), DEFAULT_MONTHS_BACK);
      await logOffline("开始", `计划 ${months.length} 个月`);
      setTotal(months.length);
      setDone(0);
      setStopped(null);
      runningRef.current = true;
      setRunning(true);

      /**
       * ⚠️ **The "never download" months, read before the loop and honoured.**
       *
       * They were not honoured at all, and the owner found it in the worst way: he
       * deleted October from the download manager and it came straight back, so the
       * deletion looked broken — and the "do not keep this" control did nothing.
       *
       * **A setting the fill ignores is not a setting**, and this one exists for a
       * real reason: somebody may not want five years of old months on a phone.
       */
      const never = await readNeverMonths();

      let finished = 0;

      try {
        for (const month of months) {
          if (never.includes(month)) {
            /**
             * Counted as done so the progress bar finishes.
             *
             * It is not fetched and never will be; leaving it out of the count would
             * make the bar stop short at "58/60" for ever, which reads as a stuck
             * download rather than as a decision the user made.
             */
            finished += 1;
            setDone(finished);
            continue;
          }

        /**
         * The screen's own filter shape, from the one place that defines it.
         *
         * ⚠️ Not written out here. The first version spelled the filters inline with
         * an extra `currency` field, which produced a **different query key** from
         * the detail screen's — so the fill cached a month that the screen could
         * not find, and the user would see nothing offline with the data sitting in
         * the cache beside it. See `UNFILTERED_TRANSACTIONS`.
         */
        const filters = transactionFilters({ month });
        const key = queryKeys.transactions(filters);

        /**
         * ⚠️ **The month is fetched page by page, in a loop of our own.**
         *
         * `fetchInfiniteQuery` resolves after the **first** page — pagination is driven
         * by the *screen* calling `fetchNextPage` when somebody presses "载入更多".
         * `QueryClient` has no `fetchNextPage` at all. So the first version of this
         * fetched one page, at most a hundred entries, and called the month done:
         * everything past that page was never on the device, which is exactly what the
         * owner saw — a month reported as downloaded that could not be read offline.
         *
         * **That was the defect behind "下载全部点了没有反应", and it took a test that
         * counted the requests to find it** (`fillPagination.test.ts`).
         */
        type Cached = { readonly pages?: readonly TransactionListResponse[] };

        const existing = queryClient.getQueryData<Cached>(key);

        /**
         * ⚠️ **"Has data" is not the same as "has all of it".**
         *
         * `fetchInfiniteQuery` — and any check of the form "is it cached" — resolves
         * immediately when *some* data exists under the key. So a month ever cached
         * with only its first page stayed half-downloaded for ever: the fill saw data,
         * did nothing, and reported success. That is the second half of the same
         * complaint.
         *
         * Only a **finished** fetch counts as done, and finishing is visible in the
         * data: the last page stops asking for a cursor.
         */
        const alreadyComplete =
          existing?.pages !== undefined &&
          existing.pages.length > 0 &&
          existing.pages[existing.pages.length - 1]?.nextCursor === null;

        if (alreadyComplete) {
          await logOffline("跳过（已完整）", month);
        }

        if (!alreadyComplete) {
          const pages: TransactionListResponse[] = [];
          let cursor: string | undefined;

          for (let page = 0; page < MAX_FILL_PAGES; page += 1) {
            const fetched = await apiFetch<TransactionListResponse>("/transactions", {
              query: { ...filters, limit: FILL_PAGE_SIZE, cursor },
            });

            pages.push(fetched);

            /**
             * Written after **each** request, in the `{ pages, pageParams }` shape the
             * screen reads. Two reasons: an interrupted fill keeps what it did get, so
             * the next launch continues rather than starting over; and the screen can
             * read a half-finished month rather than finding nothing.
             */
            queryClient.setQueryData(key, {
              pages: [...pages],
              pageParams: pages.map(() => cursor),
            });

            if (fetched.nextCursor === null) break;

            cursor = fetched.nextCursor;
          }

          await logOffline("取回", `${month}：${pages.length} 页 / ${pages.reduce((n, page) => n + page.items.length, 0)} 条`);
        }

        finished += 1;
        setDone(finished);
      }
      } catch (error) {
        /**
         * Stopping early is not a failure to report loudly.
         *
         * Everything already fetched is already useful, and the next launch
         * continues from where this stopped — so the message says that rather than
         * presenting a half-finished download as an error.
         */
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

        await logOffline("出错", detail);

        setStopped(
          error instanceof Error
            ? "这次没能全部取回，已取回的部分离线时可以用。下次联网会自动继续。"
            : "取回中断了，下次联网会自动继续。",
        );
      } finally {
        runningRef.current = false;
        setRunning(false);
        /**
         * Stamped once, where the work actually ends — so every screen that reads it
         * agrees about when "ten seconds" started.
         */
        setJustFinishedAt(Date.now());
        await logOffline("结束", `完成 ${finished}/${months.length} 个月`);
      }
    },
    [queryClient],
  );

  useEffect(() => {
    if (!options.enabled) {
      void logOffline("自动下载未启用", "尚未登录");
      return;
    }

    if (isMeteredConnection()) {
      setSkippedMetered(true);
      return;
    }

    /**
     * ⚠️ **Once per page load, not once per mount.**
     *
     * The provider is mounted once, so this is belt and braces — but the cost of being
     * wrong is high: a fill that re-runs on every mount walks sixty months of cache
     * lookups each time the user changes screen, and one that re-*fetches* is a
     * download nobody asked for. The module-level flag makes it impossible either way,
     * and survives a remount that React does for its own reasons.
     */
    if (autoFillStarted) return;
    autoFillStarted = true;

    /**
     * After the first paint, and never as part of it.
     *
     * This is sixty requests; starting it while the screen is drawing would make the
     * app feel slow for a reason the user cannot see.
     */
    const timer = window.setTimeout(() => void start(), 1_500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [options.enabled, start]);

  return { done, total, running, stopped, skippedMetered, justFinishedAt, start };
}
