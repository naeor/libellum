import {
  type CreateCategoryInput,
  type CreatePaymentMethodInput,
  type CreateTagInput,
  type CreateTransactionInput,
  type DuplicateCheckInput,
  type DuplicateCheckResponse,
  type ExportFormat,
  type ImportReport,
  type LedgerMetaResponse,
  type MeResponse,
  type RecognizeResponse,
  type StatsQuery,
  type StatsResponse,
  type SummaryResponse,
  type Transaction,
  type TranscribeResponse,
  type TransactionListResponse,
  type UpdateCategoryInput,
  type UpdatePaymentMethodInput,
  type UpdatePreferencesRequest,
  type UpdateTagInput,
  type UpdateTransactionInput,
} from "@libellum/shared";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { useAuth } from "../auth/AuthProvider.js";
import { ApiRequestError, apiFetch, apiFetchFile } from "./api.js";
import { CACHE_KEY } from "./offline/cache.js";
import {
  asLocalPage,
  filterLocally,
  findLocalTransaction,
  installLiveSource,
  ledgerSnapshotValue,
  readLocalTransactions,
  subscribeLedger,
  transactionsFromCacheCached,
} from "./offline/localLedger.js";
import { readSnapshot } from "./offline/storage.js";
import { withLocalFallback } from "./offline/fallback.js";
import { computeStats, monthRange, summaryFor } from "./offline/localStats.js";
import { uuidV7 } from "./uuid.js";

/**
 * Every server call the interface makes, in one place.
 *
 * Centralising them means the cache keys and the invalidation rules are stated
 * once: after anything that changes money, both the list and the summary are
 * refreshed, so a total on screen can never disagree with the rows beneath it.
 */

export const queryKeys = {
  ledger: ["ledger"] as const,
  summary: (month: string) => ["summary", month] as const,
  transactions: (filters: TransactionFilters) => ["transactions", filters] as const,
  transaction: (id: string) => ["transaction", id] as const,
  stats: (query: StatsQuery) => ["stats", query] as const,
};

export interface TransactionFilters {
  readonly month?: string | undefined;
  readonly kind?: "income" | "expense" | undefined;
  readonly categoryId?: string | undefined;
  readonly currency?: string | undefined;
}

/**
 * The one way to build transaction filters.
 *
 * ⚠️ **Why this exists, precisely.** TanStack Query hashes a key with
 * `JSON.stringify`, and **`JSON.stringify` drops `undefined` values.** So
 * `{month, kind, categoryId}` and `{month, kind, categoryId, currency: undefined}`
 * are different strings, therefore different hashes, therefore **different cache
 * entries** — even though they ask the server for exactly the same thing.
 *
 * The offline fill wrote four fields and the detail screen wrote three, so the month
 * the user had waited to download was stored under a key the screen never looked up.
 * **A cache miss that looks like a missing download is very hard to see**, which is
 * why this is a function with one definition rather than a shape every caller is
 * trusted to repeat correctly.
 */
export function transactionFilters(given: TransactionFilters = {}): TransactionFilters {
  return {
    month: given.month,
    kind: given.kind,
    categoryId: given.categoryId,
    currency: given.currency,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Account preferences: the default currency, for now.
 *
 * The signed-in user is cached by the auth provider, so the response replaces
 * that rather than a query key here — otherwise the currency would change in
 * settings while every other screen kept the old one until a reload.
 */
export function useUpdatePreferences() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdatePreferencesRequest) =>
      apiFetch<MeResponse>("/auth/me", { method: "PATCH", body: input }),
    onSuccess: (data) => {
      client.setQueryData(["me"], data);
      void client.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

/**
 * Send screenshots to be read.
 *
 * A mutation rather than a query, even though it looks like a read: it sends
 * files, the server does real work, and nothing about it should be cached or
 * retried behind the user's back. The same screenshot must not be recognised
 * twice because a cache decided to refetch.
 *
 * The deadline is generous because five screenshots take several seconds on
 * the server — the recogniser runs on the CPU, one image at a time.
 */
export function useRecognize(): UseMutationResult<RecognizeResponse, Error, File[]> {
  return useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append("file", file);

      return apiFetch<RecognizeResponse>("/recognize", {
        method: "POST",
        formData: form,
        timeoutMs: 90_000,
      });
    },
  });
}

export function useLedger() {
  return useQuery({
    queryKey: queryKeys.ledger,
    queryFn: () => apiFetch<LedgerMetaResponse>("/ledger"),
    // Categories change rarely; keeping them hot avoids a flash of empty
    // pickers every time the entry screen opens.
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Every transaction currently in the in-memory cache.
 *
 * ⚠️ **The live copy, read straight from the query client**, for the case the stored blob has
 * not caught up yet. The two are merged by the caller, so whichever is newer contributes what
 * it has — see `readLocalTransactions`.
 *
 * Every transaction-list query is visited, including the filtered ones the tabs create, and
 * the results are de-duplicated by id because the same entry legitimately appears in more
 * than one view.
 */
export function transactionsIn(queryClient: QueryClient): readonly Transaction[] {
  const found = new Map<string, Transaction>();

  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey;
    if (!Array.isArray(key) || key[0] !== "transactions") continue;

    const data = query.state.data as
      | { readonly pages?: readonly TransactionListResponse[]; readonly items?: readonly Transaction[] }
      | undefined;

    if (data === undefined) continue;

    const pages = data.pages ?? (data.items === undefined ? [] : [{ items: data.items, nextCursor: null }]);

    for (const page of pages) {
      for (const item of page.items ?? []) found.set(item.id, item);
    }
  }

  return [...found.values()];
}

/**
 * Whether the account is cut off from the server.
 *
 * Kept for the call sites that only need a boolean; the shared state is the authority, and it
 * is offline when **either** the browser says so **or** a request failed to get an answer.
 */

export function useSummary(month: string) {
  return useQuery({
    queryKey: queryKeys.summary(month),
    queryFn: () =>
      /**
       * ⚠️ **Network first, device second — not "device if the browser says offline".**
       *
       * The owner put the rule better than the code did: "先去读网络数据，被拒绝/超过两秒
       * 没有收到数据然后直接改成用本地数据就可以了吧？" The old version asked
       * `navigator.onLine`, which is a phone's *guess*: it says online in a lift, on a
       * train, and on a Wi-Fi network whose router stopped forwarding. In all of those the
       * app waited, failed, and showed nothing while a good copy of the month sat on the
       * device.
       *
       * The question is not "does the browser think we are online" but "did the answer
       * arrive".
       */
      withLocalFallback({
        label: `summary ${month}`,
        network: (timeoutMs) =>
          apiFetch<SummaryResponse>("/summary", { query: { month }, timeoutMs }),
        local: async () => summaryFor(await readLocalTransactions(), month, monthRange(month)),
      }),
  });
}

/**
 * Whether the device holds anything for these filters, synchronously.
 *
 * ⚠️ **A one-line gate for the loading state, and it exists because of the tablet.**
 *
 * The owner reported screens sitting on a loading state there while the same code felt instant on
 * his phone. `useTransactions` now has a deadline so a hung database read cannot hang for ever, but
 * **a deadline still means waiting** — and on a device where the read is slow, waiting is exactly
 * what the user sees.
 *
 * **This answers the only question the skeleton is actually asking — "is there anything to show?"
 * — without waiting for anything.** If the device holds entries for this view, the screen has
 * something real to draw and does not need to say "loading"; if it holds nothing, the skeleton is
 * the honest thing and is left alone.
 *
 * Returning a boolean rather than the data is deliberate: **the screen still asks the server, and
 * still uses the answer.** This only decides whether to show placeholder rows, so it cannot make the
 * app display stale data or skip a fetch.
 */
export function hasLocalTransactions(filters: TransactionFilters): boolean {
  const raw = readSnapshot<string>(CACHE_KEY);
  if (raw === null) return false;

  /**
   * ⚠️ **Through the memo.** This is called during render, so re-parsing a hundred-kilobyte
   * blob here would block the frame it is meant to speed up.
   */
  const stored = transactionsFromCacheCached(raw);

  return stored.length > 0 && filterLocally(stored, filters).length > 0;
}

export function useTransactions(given: TransactionFilters) {
  /**
   * ⚠️ **Normalised here, at the boundary**, so every caller gets the same key
   * whether they passed three fields or four. See `transactionFilters`.
   */
  const filters = transactionFilters(given);

  const queryClient = useQueryClient();

  /**
   * ⚠️ **Teach the local reader where the in-memory copy is.**
   *
   * The owner found this by using a second device: the phone worked offline and the tablet
   * did not, with the same ledger and the same download. **The two copies of the cache are
   * not equally up to date** — the persister writes on a throttle, so between a change and
   * the write the live cache holds data the stored one does not. On the phone the window had
   * always closed before the network was unplugged; on the tablet it had not, so the
   * fallback read the stored copy, found a month missing, and showed nothing while the data
   * sat in memory.
   *
   * Installed from here because this is where React and the query cache meet, and it is
   * idempotent — every render of this hook offers the same reader, and the last one wins.
   */
  installLiveSource(() => transactionsIn(queryClient));

  /**
   * ⚠️ **The device is read on mount, whether or not the query ever runs.**
   *
   * The same gap the owner found in the analysis screen: `ledgerSnapshot` was only ever written by
   * `readLocalTransactions`, and the only thing that called it was a `queryFn` — **so a query that never
   * runs means a snapshot that is never filled, and a screen with nothing to draw.** He put it exactly
   * right: "为什么之前的那个卡住一秒自动开始计算的逻辑没有生效呢？"
   *
   * So this reads the device by itself, once per view. `readLocalTransactions` publishes to the store,
   * the screens read it synchronously, and **the query layer is no longer in the path between the user's
   * data and the user's screen.**
   *
   * ⚠️ **Once per view, not on a timer.** Re-reading a hundred-kilobyte store repeatedly is the cost
   * that made the tablet struggle; the data only changes when the user does something.
   */
  const viewMonth = filters.month ?? "";
  const viewKind = filters.kind ?? "";
  const viewCategory = filters.categoryId ?? "";
  const viewCurrency = filters.currency ?? "";

  useEffect(() => {
    void readLocalTransactions();
  }, [viewMonth, viewKind, viewCategory, viewCurrency]);

  return useInfiniteQuery({
    queryKey: queryKeys.transactions(filters),
    queryFn: ({ pageParam }) =>
      /**
       * ⚠️ **Filtered views are answered from the device too — and the network is tried
       * first, whatever the browser claims.**
       *
       * The spending tab, the income tab and any category filter are *different queries
       * with different keys*, so even with every month downloaded, switching to 收入 asked
       * something the cache had never been asked and got nothing — "切换到收入界面……什么都
       * 看不到". The stored copy is not per-view, so the answer does not have to be either:
       * filter it here and hand back one page, with no cursor, because everything the
       * device has is already in hand.
       *
       * The local page keeps `nextCursor: null` deliberately: there is no server to page
       * through, and offering a cursor would put a "载入更多" button on screen that fetches
       * nothing.
       */
      withLocalFallback({
        label: `transactions ${filters.month ?? "?"}${filters.kind === undefined ? "" : ` ${filters.kind}`}`,
        network: (timeoutMs) =>
          apiFetch<TransactionListResponse>("/transactions", {
            query: {
              month: filters.month,
              kind: filters.kind,
              categoryId: filters.categoryId,
              currency: filters.currency,
              cursor: pageParam,
            },
            timeoutMs,
          }),
        local: async () => asLocalPage(filterLocally(await readLocalTransactions(), filters)),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * ⚠️ **The two screens that broke offline, answered from the device instead.**
 *
 * The owner's report was precise: with twenty megabytes stored locally he could see
 * every month's list and still could not open an entry or look at the analysis
 * screen. Both were asking the server a question the device could already answer —
 * `GET /transactions/:id` and `GET /stats` — and `apiFetch` refuses immediately when
 * `navigator.onLine` is false, so the query never got as far as its own cache.
 *
 * **A fallback per call site rather than a change to `apiFetch`.** The list screens
 * already work offline because their answers are cached under the same key; making
 * `apiFetch` return cached data would require it to understand query keys, which is
 * the query layer's job. So each call site says what to do without a network, and
 * only the analysis screen has anything interesting to say.
 *
 * ⚠️ **`navigator.onLine` is no longer the trigger** — see `withLocalFallback`. The
 * browser's answer is a guess that is wrong in a lift, on a train, and on any Wi-Fi
 * network whose router has stopped forwarding, and in each of those cases the app used
 * to wait, fail and show nothing while the data sat on the device. What matters is
 * whether the answer arrived, not what the browser believes.
 */

export function useTransaction(id: string) {
  /**
   * ⚠️ **The device's snapshot, so this screen cannot be held hostage by the query.**
   *
   * The owner's trace had one line for this path: `DIAGNOSTIC:fallback · transaction 01a125a1`. The
   * same reasoning as the ledger applies — see `useLocalEntries` — so the entry is looked up in the
   * published snapshot and returned when the query has nothing.
   *
   * ⚠️ **Only when the query has nothing.** A server answer is the truth; this is the copy.
   */
  const local = useSyncExternalStore(subscribeLedger, ledgerSnapshotValue, ledgerSnapshotValue);
  const query = useQuery({
    queryKey: queryKeys.transaction(id),
    queryFn: () =>
      /**
       * Looked up among the entries already stored when the network does not answer.
       *
       * A stored month is not a summary: `transactionSchema` carries the category name,
       * the payment method and the tags, which is everything this screen displays.
       * **Throwing when it is genuinely absent is deliberate** — an entry the device has
       * never seen cannot be shown without a network, and pretending otherwise would
       * produce a blank screen with no explanation.
       */
      withLocalFallback({
        label: `transaction ${id.slice(0, 8)}`,
        network: (timeoutMs) => apiFetch<Transaction>(`/transactions/${id}`, { timeoutMs }),
        local: async () => {
          const found = findLocalTransaction(await readLocalTransactions(), id);

          if (found !== null) return found;

          throw new ApiRequestError(
            0,
            "not_stored",
            "这一笔还没有存到本机，离线时看不到。联网后会自动补上。",
          );
        },
      }),
    enabled: id !== "",
  });

  return useMemo(() => {
    if (query.data !== undefined) return query;

    const found = local.find((entry) => entry.id === id);

    /**
     * ⚠️ **Returned as a successful query rather than a thrown error.**
     *
     * The page reads `entry.isPending`, `entry.isError` and `entry.data`; giving it a resolved value
     * keeps every one of those meaningful. Throwing instead — which is what the old local branch did —
     * would put the screen back on the path that does not settle on this device.
     */
    if (found === undefined) return query;

    return { ...query, data: found, isPending: false, isError: false, error: null, status: "success" as const };
  }, [query, local, id]);
}

/**
 * Everything the analysis screen draws, in one request.
 *
 * The range is already expanded from whatever preset the user picked — this
 * hook and the endpoint both deal in concrete dates, so adding a custom date
 * picker later changes nothing here.
 */
/**
 * How long to wait before computing the analysis on the device.
 *
 * One second: long enough that a working server answer almost always arrives first and is used, short
 * enough that nobody stares at a placeholder wondering whether anything is happening.
 */
const STATS_COMPUTE_DELAY_MS = 1_000;

export function useStats(query: StatsQuery) {
  /**
   * ⚠️ **The ledger store, not a second store of our own.**
   *
   * The ledger's channel is the one that has been confirmed on the device that breaks everything else —
   * the owner's words: "明细界面大成功，所有的都能看了，而且甚至不需要等待时间". A second store
   * `analysisStore` was built for this screen and **never worked**, through two rounds of fixes.
   *
   * **So this stops inventing a mechanism and reuses the proven one.** One subscription to the ledger,
   * shared by every caller — including the three on the analysis screen — with the arithmetic done
   * **during render**, which is what makes it immune to the dropped-update problem: there is no update
   * to drop, only a value read synchronously from a store that is already filled.
   *
   * ⚠️ **Computing during render is safe here.** `computeStats` is pure and its input is 138
   * entries — a fraction of a millisecond, on a device whose chip the owner rightly pointed out is not
   * the problem.
   */
  const all = useSyncExternalStore(subscribeLedger, ledgerSnapshotValue, ledgerSnapshotValue);

  /**
   * ⚠️ **Started here, not by the query.** See `useTransactions`: a store that is only written from
   * inside a `queryFn` is a store that stays empty whenever the query does not run.
   */
  useEffect(() => {
    void readLocalTransactions();
  }, []);

  const result = useQuery({
    queryKey: queryKeys.stats(query),
    queryFn: () =>
      withLocalFallback({
        label: `stats ${query.from}..${query.to}`,
        network: (timeoutMs) =>
          apiFetch<StatsResponse>("/stats", {
            query: {
              from: query.from,
              to: query.to,
              bucket: query.bucket,
              currency: query.currency,
              compareFrom: query.compareFrom,
              compareTo: query.compareTo,
            },
            timeoutMs,
          }),
        local: async () =>
          computeStats(await readLocalTransactions(), {
            from: query.from,
            to: query.to,
            bucket: query.bucket,
            currency: query.currency,
            compareFrom: query.compareFrom,
            compareTo: query.compareTo,
          }),
      }),
    // A statistic is derived from entries; when none change, it cannot change.
    staleTime: 60_000,
  });

  /**
   * ⚠️ **The server's answer if there is one, the device's arithmetic otherwise.**
   *
   * A server answer is the truth; `computeStats` reproduces it from the same entries and the same rules.
   * Falling back to the computation when the query is pending, empty or failed is what makes the screen
   * show something instead of waiting for a state that may never arrive.
   */
  return useMemo(() => {
    if (result.data !== undefined) return result;
    if (all.length === 0) return result;

    return {
      ...result,
      data: computeStats(all, {
        from: query.from,
        to: query.to,
        bucket: query.bucket,
        currency: query.currency,
        compareFrom: query.compareFrom,
        compareTo: query.compareTo,
      }),
      isPending: false,
      isError: false,
      error: null,
      status: "success" as const,
    };
  }, [result, all, query.from, query.to, query.bucket, query.currency, query.compareFrom, query.compareTo]);
}

/** Amounts offered as one-tap shortcuts. */
const FALLBACK_QUICK_AMOUNTS = [1_000, 2_000, 10_000];
const QUICK_AMOUNT_COUNT = 5;
/** Below this many entries there is not enough history to be worth reading. */
const QUICK_AMOUNT_HISTORY_MINIMUM = 10;
const QUICK_AMOUNT_WINDOW_DAYS = 30;

/**
 * The five amounts this person reaches for most often.
 *
 * Until there are ten entries to learn from, defaults (10 / 20 / 100) are
 * shown instead — guessing from two data points would produce nonsense
 * shortcuts that change every time.
 */
export function useQuickAmounts(): number[] {
  const query = useQuery({
    queryKey: ["quick-amounts"],
    queryFn: () => apiFetch<TransactionListResponse>("/transactions", { query: { limit: 100 } }),
    staleTime: 5 * 60 * 1000,
  });

  return useMemo(() => {
    const items = query.data?.items ?? [];
    if (items.length < QUICK_AMOUNT_HISTORY_MINIMUM) return FALLBACK_QUICK_AMOUNTS;

    const cutoff = Date.now() - QUICK_AMOUNT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const counts = new Map<number, number>();

    for (const item of items) {
      if (new Date(item.occurredAt).getTime() < cutoff) continue;
      counts.set(item.amountCents, (counts.get(item.amountCents) ?? 0) + 1);
    }

    const ranked = [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, QUICK_AMOUNT_COUNT)
      .map(([amount]) => amount);

    return ranked.length > 0 ? ranked : FALLBACK_QUICK_AMOUNTS;
  }, [query.data]);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Anything that changes money must refresh the list *and* the totals. */
function useMoneyInvalidator(): () => Promise<void> {
  const client = useQueryClient();

  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["transactions"] }),
      client.invalidateQueries({ queryKey: ["summary"] }),
      client.invalidateQueries({ queryKey: ["transaction"] }),
    ]);
  };
}

export function useCreateTransaction(): UseMutationResult<Transaction, Error, CreateTransactionInput> {
  const invalidate = useMoneyInvalidator();

  return useMutation({
    mutationFn: (input: CreateTransactionInput) =>
      apiFetch<Transaction>("/transactions", { method: "POST", body: input }),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateTransaction(
  id: string,
): UseMutationResult<Transaction, Error, UpdateTransactionInput> {
  const invalidate = useMoneyInvalidator();

  return useMutation({
    mutationFn: (input: UpdateTransactionInput) =>
      apiFetch<Transaction>(`/transactions/${id}`, { method: "PATCH", body: input }),
    onSuccess: () => void invalidate(),
  });
}

export function useDeleteTransaction(): UseMutationResult<unknown, Error, string> {
  const invalidate = useMoneyInvalidator();

  return useMutation({
    mutationFn: (id: string) => apiFetch<unknown>(`/transactions/${id}`, { method: "DELETE" }),
    onSuccess: () => void invalidate(),
  });
}

/**
 * Is an entry like this one already recorded?
 *
 * A mutation rather than a query, deliberately: it is a question asked at one
 * moment about fields the user is still editing, not a piece of server state to
 * cache and re-fetch. Caching it would also make a stale "no duplicates" answer
 * possible right after somebody recorded the very entry being checked for.
 *
 * A POST because it carries an amount, which does not belong in a URL — it would
 * end up in browser history, in access logs, and in any proxy in between.
 */
export function useCheckDuplicates(): UseMutationResult<
  Transaction[],
  Error,
  DuplicateCheckInput
> {
  return useMutation({
    mutationFn: async (input: DuplicateCheckInput) => {
      const response = await apiFetch<DuplicateCheckResponse>("/transactions/duplicates", {
        method: "POST",
        body: input,
      });

      return response.duplicates;
    },
  });
}

/**
 * Send a recording, get back what was heard and the fields read out of it.
 *
 * Multipart through `apiFetch`'s `formData` option, which is the same path the
 * screenshot upload takes — so the timeout, the offline check and the error
 * translation are shared rather than reimplemented. (The first version of this
 * called `fetch` directly and rebuilt all three; `apiFetch` already had them.)
 *
 * A **longer timeout than the default**, because this is the one request in the
 * app that waits on a language model: thirty seconds of audio on a small server
 * is seconds of work, and the default would abandon it while it was still going.
 */
export function useTranscribe(): UseMutationResult<TranscribeResponse, Error, Blob> {
  return useMutation({
    mutationFn: async (audio: Blob) => {
      const form = new FormData();
      /**
       * A filename is required for the server to treat it as a file part at all,
       * and the extension matches what the browser actually recorded — Safari
       * writes an MP4 container, Chrome a WebM one. The server sniffs the real
       * bytes either way; this is for anything reading logs.
       */
      const extension = audio.type.includes("mp4") ? "mp4" : "webm";
      form.append("audio", audio, `recording.${extension}`);

      return apiFetch<TranscribeResponse>("/voice/transcribe", {
        method: "POST",
        formData: form,
        timeoutMs: 120_000,
      });
    },
  });
}

/** Undo for a delete: restores the same row, not a copy of it. */
export function useRestoreTransaction(): UseMutationResult<Transaction, Error, string> {
  const invalidate = useMoneyInvalidator();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Transaction>(`/transactions/${id}/restore`, { method: "POST" }),
    onSuccess: () => void invalidate(),
  });
}

// ---------------------------------------------------------------------------
// Managing the three organisers
// ---------------------------------------------------------------------------

function useLedgerInvalidator(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: queryKeys.ledger });
  };
}

export function useCategoryMutations() {
  const invalidate = useLedgerInvalidator();
  const invalidateMoney = useMoneyInvalidator();

  const create = useMutation({
    mutationFn: (input: CreateCategoryInput) =>
      apiFetch("/categories", { method: "POST", body: input }),
    onSuccess: () => void invalidate(),
  });

  const update = useMutation({
    mutationFn: ({ id, ...input }: UpdateCategoryInput & { id: string }) =>
      apiFetch(`/categories/${id}`, { method: "PATCH", body: input }),
    // Renaming or archiving changes how entries render, so the lists refresh too.
    onSuccess: () => void Promise.all([invalidate(), invalidateMoney()]),
  });

  const archive = useMutation({
    mutationFn: (id: string) => apiFetch(`/categories/${id}`, { method: "DELETE" }),
    onSuccess: () => void Promise.all([invalidate(), invalidateMoney()]),
  });

  return { create, update, archive };
}

export function usePaymentMethodMutations() {
  const invalidate = useLedgerInvalidator();
  const invalidateMoney = useMoneyInvalidator();

  const create = useMutation({
    mutationFn: (input: CreatePaymentMethodInput) =>
      apiFetch("/payment-methods", { method: "POST", body: input }),
    onSuccess: () => void invalidate(),
  });

  const update = useMutation({
    mutationFn: ({ id, ...input }: UpdatePaymentMethodInput & { id: string }) =>
      apiFetch(`/payment-methods/${id}`, { method: "PATCH", body: input }),
    onSuccess: () => void Promise.all([invalidate(), invalidateMoney()]),
  });

  const archive = useMutation({
    mutationFn: (id: string) => apiFetch(`/payment-methods/${id}`, { method: "DELETE" }),
    onSuccess: () => void Promise.all([invalidate(), invalidateMoney()]),
  });

  return { create, update, archive };
}

export function useTagMutations() {
  const invalidate = useLedgerInvalidator();
  const invalidateMoney = useMoneyInvalidator();

  const create = useMutation({
    mutationFn: (input: CreateTagInput) => apiFetch("/tags", { method: "POST", body: input }),
    onSuccess: () => void invalidate(),
  });

  const update = useMutation({
    mutationFn: ({ id, ...input }: UpdateTagInput & { id: string }) =>
      apiFetch(`/tags/${id}`, { method: "PATCH", body: input }),
    onSuccess: () => void Promise.all([invalidate(), invalidateMoney()]),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ affectedEntries: number }>(`/tags/${id}`, { method: "DELETE" }),
    onSuccess: () => void Promise.all([invalidate(), invalidateMoney()]),
  });

  return { create, update, remove };
}

// ---------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------

/**
 * What a caller gets back from an export.
 *
 * The bytes are carried here so **the platform can decide what to do with
 * them**: the share sheet on an iPhone, a download everywhere else. A response
 * the browser insists on saving cannot be shared, and a share sheet cannot save.
 */
export interface ExportedFile {
  /** e.g. `账目-20261010.csv` — named here, because the client knows the moment. */
  readonly fileName: string;
  readonly mimeType: string;
  readonly format: ExportFormat;
  /** The `Out-…` reference, shown to the user and written into every row. */
  readonly fileRef: string;
  readonly rowCount: number;
  readonly bytes: Uint8Array;
}

export interface ExportFilters {
  readonly format: ExportFormat;
  readonly monthFrom?: string;
  readonly monthTo?: string;
  readonly kind?: "income" | "expense";
  readonly categoryId?: string;
  readonly currency?: string;
}

const EXPORT_MIME: Record<ExportFormat, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function describe(filters: ExportFilters, now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const range =
    filters.monthFrom === undefined && filters.monthTo === undefined
      ? "全部"
      : `${filters.monthFrom ?? "起始"}-${filters.monthTo ?? "至今"}`;

  return `账目-${range}-${stamp}`;
}

export async function fetchExport(filters: ExportFilters): Promise<ExportedFile> {
  const file = await apiFetchFile("/export", {
    format: filters.format,
    monthFrom: filters.monthFrom,
    monthTo: filters.monthTo,
    kind: filters.kind,
    categoryId: filters.categoryId,
    currency: filters.currency,
  });

  return {
    fileName: `${describe(filters, new Date())}.${filters.format}`,
    mimeType: EXPORT_MIME[filters.format],
    format: filters.format,
    fileRef: file.fileRef,
    rowCount: file.rowCount,
    bytes: file.bytes,
  };
}

/** The template: headings only, no rows, no traceability columns. */
export async function fetchTemplate(): Promise<ExportedFile> {
  const file = await apiFetchFile("/export", { format: "csv", template: "true" });

  return {
    fileName: "记账导入模板.csv",
    mimeType: EXPORT_MIME.csv,
    format: "csv",
    fileRef: "",
    rowCount: 0,
    bytes: file.bytes,
  };
}

export function useExportLog() {
  return useQuery({
    queryKey: ["export-log"],
    queryFn: () =>
      apiFetch<{
        entries: {
          fileRef: string;
          format: string;
          rowCount: number;
          createdAt: string;
          by: string;
        }[];
      }>("/export-log"),
  });
}

export function useImportEntries() {
  const invalidateMoney = useMoneyInvalidator();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("fileId", uuidV7());
      form.append("file", file, file.name === "" ? "import.csv" : file.name);
      return apiFetch<ImportReport>("/import", { method: "POST", formData: form, timeoutMs: 120_000 });
    },
    onSuccess: () => {
      void invalidateMoney();
      void queryClient.invalidateQueries({ queryKey: ["export-log"] });
    },
  });
}
