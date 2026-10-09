import {
  type CreateCategoryInput,
  type CreatePaymentMethodInput,
  type CreateTagInput,
  type CreateTransactionInput,
  type LedgerMetaResponse,
  type MeResponse,
  type RecognizeResponse,
  type StatsQuery,
  type StatsResponse,
  type SummaryResponse,
  type Transaction,
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
  type UseMutationResult,
} from "@tanstack/react-query";
import { useMemo } from "react";

import { useAuth } from "../auth/AuthProvider.js";
import { apiFetch } from "./api.js";

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

export function useSummary(month: string) {
  return useQuery({
    queryKey: queryKeys.summary(month),
    queryFn: () => apiFetch<SummaryResponse>("/summary", { query: { month } }),
  });
}

export function useTransactions(filters: TransactionFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.transactions(filters),
    queryFn: ({ pageParam }) =>
      apiFetch<TransactionListResponse>("/transactions", {
        query: {
          month: filters.month,
          kind: filters.kind,
          categoryId: filters.categoryId,
          currency: filters.currency,
          cursor: pageParam,
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useTransaction(id: string) {
  return useQuery({
    queryKey: queryKeys.transaction(id),
    queryFn: () => apiFetch<Transaction>(`/transactions/${id}`),
    enabled: id !== "",
  });
}

/**
 * Everything the analysis screen draws, in one request.
 *
 * The range is already expanded from whatever preset the user picked — this
 * hook and the endpoint both deal in concrete dates, so adding a custom date
 * picker later changes nothing here.
 */
export function useStats(query: StatsQuery) {
  return useQuery({
    queryKey: queryKeys.stats(query),
    queryFn: () =>
      apiFetch<StatsResponse>("/stats", {
        query: {
          from: query.from,
          to: query.to,
          bucket: query.bucket,
          currency: query.currency,
          compareFrom: query.compareFrom,
          compareTo: query.compareTo,
        },
      }),
    // A statistic is derived from entries; when none change, it cannot change.
    staleTime: 60_000,
  });
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
