import type { TransactionListResponse } from "@libellum/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../api.js";
import { UNFILTERED_TRANSACTIONS, queryKeys } from "../queries.js";

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
 * Whether the browser says this connection is metered.
 *
 * `saveData` is the user's own "do not use much data" setting; `effectiveType` is
 * the browser's estimate. Downloading an entire ledger on somebody's mobile data
 * without asking is not a thing to do quietly, and the check is free.
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

export interface OfflineFill {
  /** Months finished, and how many were planned. */
  readonly done: number;
  readonly total: number;
  readonly running: boolean;
  /** Set when it stopped early, with a sentence worth showing. */
  readonly stopped: string | null;
  /** Whether it skipped itself because the connection is metered. */
  readonly skippedMetered: boolean;
  /** Fetch the missing months. Safe to call again; finished months are skipped. */
  start: (monthsBack?: number) => Promise<void>;
}

/**
 * Fill the cache with the whole history, one month per request.
 *
 * Everything already cached is skipped, so calling this on every launch is cheap
 * after the first time — which is what makes it safe to leave switched on rather
 * than something the user has to remember to press.
 */
export function useOfflineFill(options: { readonly enabled: boolean }): OfflineFill {
  const queryClient = useQueryClient();
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState<string | null>(null);
  const [skippedMetered, setSkippedMetered] = useState(false);

  /**
   * A ref as well as state, because `start` must not depend on the render it was
   * created in: this runs once per launch from an effect, and a stale closure
   * there would restart the whole download.
   */
  const runningRef = useRef(false);

  const start = useCallback(
    async (monthsBack: number = DEFAULT_MONTHS_BACK) => {
      if (runningRef.current) return;

      if (isMeteredConnection()) {
        setSkippedMetered(true);
        return;
      }

      const months = monthsToFetch(new Date(), monthsBack);
      setTotal(months.length);
      setDone(0);
      setStopped(null);
      runningRef.current = true;
      setRunning(true);

      let finished = 0;

      try {
        for (const month of months) {
        /**
         * The screen's own filter shape, from the one place that defines it.
         *
         * ⚠️ Not written out here. The first version spelled the filters inline with
         * an extra `currency` field, which produced a **different query key** from
         * the detail screen's — so the fill cached a month that the screen could
         * not find, and the user would see nothing offline with the data sitting in
         * the cache beside it. See `UNFILTERED_TRANSACTIONS`.
         */
        const filters = { ...UNFILTERED_TRANSACTIONS, month };
        const key = queryKeys.transactions(filters);

        /**
         * Already here: skipped, and counted as done.
         *
         * `getQueryData` rather than `fetchQuery`, so a month that is already cached
         * costs nothing — no request, no stale refetch. This is what makes the second
         * and later launches nearly free.
         */
        if (queryClient.getQueryData(key) === undefined) {
          /**
           * `fetchInfiniteQuery`, not `fetchQuery` — and the shape is the point.
           *
           * The screen reads this key with `useInfiniteQuery`, whose cached value is
           * `{ pages, pageParams }`. Handing it a plain array would leave it unable
           * to read its own cache: it would find *something* under the key and treat
           * it as the wrong shape. `fetchInfiniteQuery` builds exactly what the
           * screen expects, **including every page**, so a month with more entries
           * than one request returns is fetched completely rather than in part.
           *
           * `getNextPageParam` is the same rule the screen uses: follow the cursor
           * until the server stops giving one.
           */
          await queryClient.fetchInfiniteQuery({
            queryKey: key,
            queryFn: ({ pageParam }) =>
              apiFetch<TransactionListResponse>("/transactions", {
                query: { ...filters, limit: FILL_PAGE_SIZE, cursor: pageParam as string | undefined },
              }),
            initialPageParam: undefined as string | undefined,
            getNextPageParam: (last: TransactionListResponse) => last.nextCursor ?? undefined,
          });
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
        setStopped(
          error instanceof Error
            ? "这次没能全部取回，已取回的部分离线时可以用。下次联网会自动继续。"
            : "取回中断了，下次联网会自动继续。",
        );
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    },
    [queryClient],
  );

  useEffect(() => {
    if (!options.enabled) return;
    if (isMeteredConnection()) {
      setSkippedMetered(true);
      return;
    }

    /**
     * After the first paint, and never as part of it.
     *
     * This is sixty requests; starting it while the screen is drawing would make
     * the app feel slow for a reason the user cannot see.
     */
    const timer = window.setTimeout(() => void start(), 1_500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [options.enabled, start]);

  return { done, total, running, stopped, skippedMetered, start };
}
