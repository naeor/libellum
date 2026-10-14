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

import { updateTransactionViews } from "./ledgerView.js";
import { useAuth } from "../auth/AuthProvider.js";
import { ApiRequestError, apiFetch, apiFetchFile } from "./api.js";
import { setCurrentBook } from "./currentBook.js";
import { CACHE_KEY } from "./offline/cache.js";
import { migrateUnscopedKeys, setOfflineBook } from "./offline/scope.js";
import {
  asLocalPage,
  filterLocally,
  findLocalTransaction,
  installLiveSource,
  ledgerSnapshotValue,
  readLocalTransactions,
  reconcileMarks,
  subscribeLedger,
  transactionsFromCacheCached,
} from "./offline/localLedger.js";
import { readSnapshot } from "./offline/storage.js";
import { installQueryNotifier, refreshPending } from "./offline/write.js";
import { syncAll } from "./offline/sync.js";
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
  /**
   * ⚠️ **The ledger list is not scoped by ledger, and that is the point**: it is the request that
   * tells the device which ledgers exist, so naming one would be a circle.
   */
  books: ["books"] as const,
  /**
   * ⚠️ **Account-level, not ledger-level.** A referral code belongs to the account and creates a new
   * account; it grants access to no ledger, so keying it by ledger would ask the same question once
   * per ledger and cache a different answer each time.
   *
   * ⚠️ **This replaced `collaborators`, which no longer exists** (1.10.05). The old key held the
   * account-level collaborator list *and* this count; the list is gone and the count travels alone.
   */
  referralQuota: ["referral-quota"] as const,
  /**
   * ⚠️ **A prefix, and only ever used for invalidation.** Lookups are mutations (they run on
   * purpose, not on focus) and TanStack caches mutations nowhere — so there is nothing to read back
   * out of this key. It exists so that **sending an invitation can mark every previous lookup
   * stale**, which is what makes the screen re-ask *"is there an invitation outstanding?"* instead of
   * showing the state it fetched before the send.
   */
  directory: ["directory"] as const,
  notifications: ["notifications"] as const,
  /**
   * ⚠️ **A prefix for per-ledger metadata reads, kept apart from `ledger` on purpose.**
   *
   * `ledger` is the **current** ledger's metadata — the request that teaches the device which ledger
   * it is in. A read for a ledger the reader has only tapped a gear on must not land in the same cache
   * entry, or the current ledger's screen would be served the other one's name, number and counts.
   * **Two questions, two keys.**
   */
  ledgerMeta: ["ledger-meta"] as const,
  shareLinks: ["share-links"] as const,
  /**
   * ⚠️ **Keyed by the token itself**, so a second link's preview can never be served from the first
   * one's cache — which would show the wrong ledger and the wrong permission on the confirm screen.
   */
  sharePreview: (token: string) => ["share-preview", token] as const,
  /** ⚠️ Keyed by the limit, so the short preview and the full page do not overwrite each other. */
  ledgerHistory: (limit: number) => ["ledger-history", limit] as const,
  /**
   * ⚠️ **Keyed by nothing but the ledger in the header.** A member list is *about* the ledger the
   * request names, so putting the id in the key would be a second place that decides which ledger is
   * being asked about — and **the day the two disagree, the screen shows one ledger's members under
   * another's name.**
   */
  bookMembers: ["book-members"] as const,
  /**
   * ⚠️ **No conversation id, no recipient.** The board is one per ledger and the ledger comes from
   * the request header — **a key that named a conversation would be exactly the private-chat shape
   * the owner ruled out.**
   */
  bookMessages: ["book-messages"] as const,
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

/**
 * A ledger, as the list screen sees it.
 *
 * ⚠️ **`role` comes from the server and is never derived on the client.** Which ledger a person
 * may write in is a fact about `book_members`, and a client that worked it out for itself would
 * eventually disagree — the whole point of checking it server-side is that the client's answer is
 * only a courtesy.
 */
export interface BookSummary {
  readonly id: string;
  readonly name: string;
  readonly bookNumber: string | null;
  readonly role: "owner" | "editor" | "viewer";
  readonly isCreator: boolean;
  readonly disposedByMe: boolean;
  readonly memberCount: number;
}

interface BooksResponse {
  readonly books: readonly BookSummary[];
  readonly disposed: readonly BookSummary[];
}

/**
 * ⚠️ **Not ledger-scoped, and it cannot be**: this is the request that tells the device which
 * ledgers exist, so there is no ledger to name yet. The API registers it without the ledger
 * guard for the same reason — see `routes/books.ts`.
 */
export function useBooks() {
  return useQuery({
    queryKey: queryKeys.books,
    queryFn: () => apiFetch<BooksResponse>("/books"),
    /**
     * ⚠️ **Always refetched when the screen is opened.** Roles and membership change from the
     * other side — somebody adds you, or changes what you may do — and a cached list would keep
     * showing the old answer while the server has already moved on.
     */
    staleTime: 0,
  });
}

/** Make another ledger. The server enters it, so the next load lands there. */
export function useCreateBook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ id: string; name: string; bookNumber: string | null }>("/books", {
        method: "POST",
        body: { name },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.books }),
  });
}

/**
 * Enter a ledger.
 *
 * ⚠️ **Returns a promise the caller then reloads the page with**, rather than invalidating
 * queries and hoping everything refetches in the right order. Entering a ledger changes which
 * ledger every other request addresses, and which slice of the device's offline copy is read —
 * **a half-switched screen that shows one ledger's header over another's entries is exactly the
 * failure this stage exists to prevent.** A reload is blunt and it cannot be half-done.
 *
 * ⚠️ **⚠️ `onSuccess` is not bookkeeping — without it, entering a ledger is a one-way door.**
 *
 * This was a real defect, found by the owner: he made a second ledger and **could not get into
 * it** — every attempt, from the create dialog and from the ledger list, landed back in the
 * first one. The chain, end to end:
 *
 *  1. the device remembers which ledger it is in (`lib/currentBook.ts`), and every request names
 *     it in a header;
 *  2. activating a ledger **only told the server** — `users.lastBookId` moved, which is the
 *     *server's* memory of the last ledger and is what a fresh device would use;
 *  3. the **client's** copy was never updated, so the reload at the end of `enterLedger` read the
 *     old id back out of the device and sent **that** as the header;
 *  4. `GET /ledger` honours the header, so it answered with the *old* ledger's metadata;
 *  5. and `useLedger` then called `setCurrentBook(oldLedger.id)` — **re-pinning the device to the
 *     ledger it was trying to leave.** Every subsequent attempt repeated the same loop.
 *
 * So the new ledger has to be written down where the header is read from, **before** the reload.
 * `setCurrentBook` also notifies `main.tsx`'s subscription, which primes the header, so the next
 * request already names the new ledger even if the reload never happened.
 */
export function useActivateBook() {
  return useMutation({
    mutationFn: (bookId: string) =>
      apiFetch<{ ok: boolean }>(`/books/${bookId}/activate`, { method: "POST" }),
    onSuccess: (_result, bookId) => {
      /**
       * ⚠️ **Returned, not fired and forgotten.** `setCurrentBook` resolves once the id is on the
       * device, and TanStack awaits a promise returned from `onSuccess` before `mutateAsync`
       * resolves — which is what lets `enterLedger` reload *after* the write has landed.
       * See the long note on `useActivateBook`.
       */
      return setCurrentBook(bookId);
    },
  });
}

/** Set a ledger aside. The rows stay; only the listing changes. */
export function useDisposeBook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (bookId: string) =>
      apiFetch<{ ok: boolean }>(`/books/${bookId}/dispose`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.books }),
  });
}

/** Bring one back. */
export function useRestoreBook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (bookId: string) =>
      apiFetch<{ ok: boolean }>(`/books/${bookId}/restore`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.books }),
  });
}

/**
 * How many referral codes this account may still mint.
 *
 * ⚠️ **It used to arrive bundled with the collaborator list**, and that list is gone (1.10.05). The
 * count is still the server's — a second tally here would eventually disagree with the one the mint
 * path enforces (`教训.md` §8.12) — it simply travels on its own now.
 */
export function useReferralQuota() {
  return useQuery({
    queryKey: queryKeys.referralQuota,
    queryFn: () => apiFetch<{ quota: { readonly limit: number; readonly used: number } }>("/referral-codes"),
    staleTime: 0,
  });
}

/** What the invite screen learned about one account. */
export interface DirectoryAccount {
  readonly id: string;
  readonly displayName: string;
  readonly username: string;
  readonly accountNumber: string;
  /** ⚠️ Answered by the server against `book_members`, not guessed from a cached list. */
  readonly alreadyMember: boolean;
}

/**
 * Find one account to invite — by its eight-digit number, or by an exact username.
 *
 * ⚠️ **A mutation rather than a query, and that is deliberate**: it runs when somebody presses
 * 查找, not on every render. As a query it would refetch on focus and on every keystroke's
 * debounce, and each call is a question about *another* account — the one endpoint that answers
 * those should be asked on purpose, and it carries a tighter rate limit than the rest.
 */
export function useLookupAccount() {
  return useMutation({
    mutationFn: (input: { accountNumber?: string; username?: string }) => {
      const params = new URLSearchParams(
        input.accountNumber !== undefined
          ? { accountNumber: input.accountNumber }
          : { username: input.username ?? "" },
      );
      return apiFetch<{
        account: DirectoryAccount;
        canInvite: boolean;
        /** ⚠️ The invitation already outstanding for this person, so the screen can say its state. */
        invitation: { id: string; status: "pending" | "accepted" | "declined"; createdAt: string } | null;
      }>(`/directory/lookup?${params.toString()}`);
    },
  });
}

/**
 * The inbox, and the red dot's source.
 *
 * ⚠️ **`pendingCount` and `unreadCount` come from the server with the same rows**, rather than being
 * counted on the client — a second tally is a second thing that can disagree with the list.
 */
export interface NotificationView {
  readonly id: string;
  /**
   * ⚠️ **`collaborator_request` is not a possible value any more (1.10.05)** — the server stopped
   * returning it, and the account-level system it belonged to was removed. Two kinds remain: an
   * invitation into a ledger, and the reminder that follows using somebody's referral code.
   */
  readonly kind: "book_invite" | "referral_reminder";
  readonly status: "pending" | "accepted" | "declined";
  readonly message: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly readAt: string | null;
  readonly decidedAt: string | null;
  readonly sender: { readonly displayName: string; readonly username: string; readonly accountNumber: string };
  readonly book: { readonly id: string; readonly name: string; readonly bookNumber: string | null } | null;
}

export function useNotifications() {
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () =>
      apiFetch<{
        notifications: readonly NotificationView[];
        pendingCount: number;
        unreadCount: number;
        quota: { perSubject: number; total: number };
      }>("/notifications"),
    staleTime: 0,
  });
}

export function useDecideNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; decision: "accepted" | "declined" }) =>
      apiFetch<{ ok: boolean; bookId: string | null; joined: boolean }>(
        `/notifications/${input.id}/decide`,
        { method: "POST", body: { decision: input.decision } },
      ),
    onSuccess: () => {
      /**
       * ⚠️ **Accepting can change which ledgers this account has**, so the book list and the ledger
       * list are invalidated too — not only the inbox. Otherwise the new ledger would exist and the
       * home screen would not show it.
       */
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
      void queryClient.invalidateQueries({ queryKey: queryKeys.books });
    },
  });
}

/** Clear the dot. Does **not** decide anything — that is a separate, deliberate action. */
export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; marked: number }>("/notifications/read-all", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
  });
}

/**
 * Invite somebody into **the current ledger** — the one-step flow.
 *
 * ⚠️ **The ledger is not a parameter** — it comes from the request header, because that is what the
 * server checks against `book_members`. Passing a ledger id from here would suggest the client
 * decides which ledger it is inviting into, and it does not: it declares, the server verifies.
 *
 * ⚠️ **The person may be named by number or by username**, and the server accepts exactly one of the
 * two — the same two ways the lookup accepts, so the screen can use whichever the user typed.
 */
export function useInviteToBook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      accountNumber?: string;
      username?: string;
      role: "editor" | "viewer";
    }) =>
      apiFetch<{ ok: boolean; notificationId: string; refreshed: boolean; role: "editor" | "viewer" }>(
        "/books/invite",
        { method: "POST", body: input },
      ),
    /**
     * ⚠️ **The lookup is invalidated, not a list**, because there is no list any more. The state the
     * sender needs next — *"已邀请，等待对方确认"* — comes from the lookup for that person, and it
     * must be re-read rather than assumed from a local flag that could go stale.
     */
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.directory }),
  });
}

/**
 * The share links into the current ledger.
 *
 * ⚠️ **The token is never in this list**, because the server cannot produce it again — it stores a
 * hash. So a link that already exists can be copied only at the moment it was minted; afterwards
 * the honest answer is "generate a new one", which is why revocation and regeneration are ordinary
 * operations here rather than a recovery procedure.
 */
export interface ShareLinkView {
  readonly id: string;
  readonly role: "editor" | "viewer";
  /** ⚠️ The chosen lifetime in days (1–7) — stored rather than derived, so the list can say it. */
  readonly days: number;
  /** ⚠️ How many people may join through it (1–10). */
  readonly maxUses: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly useCount: number;
  readonly lastUsedAt: string | null;
  readonly createdBy: string;
  /**
   * ⚠️ **Computed by the server, never here.** Whether a link still works depends on revoked,
   * expired and full — three facts the join path also checks, and **a client that worked it out
   * again would eventually disagree with the server about whether somebody can get in.** The
   * screen would be the one that was wrong.
   */
  readonly active: boolean;
}

/**
 * The share links into a ledger.
 *
 * ⚠️ **`bookId` is optional and names the ledger for this call only** — same mechanism and same
 * reason as `useBookMembers`. The start page's gear panel opens a ledger's sharing screen **without
 * entering that ledger**, so reading the current one's links would show the wrong ledger's links
 * under the right ledger's name: **the most confusing shape this bug can take**, because both halves
 * of the screen look plausible.
 *
 * ⚠️ **The key carries the ledger**, so two ledgers' links cannot share a cache entry.
 */
export function useShareLinks(bookId?: string) {
  return useQuery({
    queryKey: bookId === undefined ? queryKeys.shareLinks : [...queryKeys.shareLinks, bookId],
    queryFn: () => apiFetch<{ links: readonly ShareLinkView[] }>("/share/links", { ...(bookId === undefined ? {} : { bookId }) }),
    staleTime: 0,
  });
}

/** Mint one. **The token in the response is the only time it exists** — the screen must show it. */
export function useCreateShareLink(bookId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { role: "editor" | "viewer"; days: number; maxUses: number }) =>
      apiFetch<{ id: string; token: string; expiresAt: string }>("/share/links", {
        method: "POST",
        ...(bookId === undefined ? {} : { bookId }),
        body: input,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks }),
  });
}

export function useRevokeShareLink(bookId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (linkId: string) =>
      apiFetch<{ ok: boolean; alreadyRevoked: boolean }>(`/share/links/${linkId}/revoke`, {
        method: "POST",
        ...(bookId === undefined ? {} : { bookId }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks }),
  });
}

/**
 * What a link would do — **without doing it**.
 *
 * ⚠️ **Reading and joining are separate steps on purpose.** Somebody who taps a link in a chat
 * window should see *which ledger and what permission* before anything happens to their account;
 * a single "open = join" endpoint would add people to ledgers from a stray tap.
 */
export interface ShareLinkPreview {
  readonly bookId: string;
  readonly bookName: string;
  readonly bookNumber: string | null;
  readonly role: "editor" | "viewer";
  readonly alreadyMember: boolean;
  readonly createdByName: string;
}

export function useShareLinkPreview(token: string | null) {
  return useQuery({
    queryKey: queryKeys.sharePreview(token ?? ""),
    queryFn: () => apiFetch<ShareLinkPreview>(`/share/${encodeURIComponent(token ?? "")}`),
    enabled: token !== null && token !== "",
    /** ⚠️ Never cached: a revoked link must stop working the next time somebody looks. */
    staleTime: 0,
    retry: false,
  });
}

export function useJoinViaShareLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (token: string) =>
      apiFetch<{ ok: boolean; bookId: string; joined: boolean; role: "editor" | "viewer" }>(
        `/share/${encodeURIComponent(token)}/join`,
        { method: "POST" },
      ),
    onSuccess: () => {
      // A new ledger appeared (or became reachable), so the lists that show ledgers must reload.
      void queryClient.invalidateQueries({ queryKey: queryKeys.books });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ledger });
    },
  });
}

/** Leave a shared ledger. Not the same thing as disposing of one — see `版本记录` 1.09.11. */
export function useLeaveBook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (bookId: string) => apiFetch<{ ok: boolean }>(`/books/${bookId}/leave`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.books }),
  });
}

/**
 * Mint a referral code — the owner's "次级邀请码".
 *
 * ⚠️ **The code comes back in clear and stays readable**, unlike a share link's token: an invitation
 * code gets read aloud over the phone and sent again in a chat, so a generator who could never look
 * it up again would have a code they cannot use twice. **Two credentials, two storage rules, and the
 * difference is how they are meant to travel.**
 */
export function useMintReferralCode() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ code: string; expiresAt: string; quota: { limit: number } }>("/referral-codes", {
        method: "POST",
        body: {},
      }),
  });
}

/**
 * What has happened in this ledger.
 *
 * ⚠️ **The sentence comes from the server already assembled.** The API owns the wording (it is the
 * side that knows which fields are tracked), so this screen renders `summary` rather than building
 * its own — **a second place deciding "what an edit is called" is a second place that can disagree**
 * (`教训.md` §8.12).
 */
export interface LedgerHistoryEntry {
  readonly id: string;
  readonly kind: "created" | "updated" | "deleted" | "restored" | "member_changed";
  readonly occurredAt: string;
  readonly actorName: string | null;
  readonly transactionId: string | null;
  readonly transactionSeq: number | null;
  readonly summary: string;
  readonly changes: readonly { readonly label: string; readonly from: string; readonly to: string }[];
}

export function useLedgerHistory(limit: number) {
  return useQuery({
    queryKey: queryKeys.ledgerHistory(limit),
    queryFn: () => apiFetch<{ entries: readonly LedgerHistoryEntry[]; total: number }>(
      `/ledger/history?limit=${String(limit)}`,
    ),
    /**
     * ⚠️ **Always fresh.** Somebody else's edit is exactly what this screen reports, and they act on
     * their own device — **a cached history is a history that stops mentioning the newest change**,
     * which is the one the reader came to see.
     */
    staleTime: 0,
  });
}

/**
 * **Who is in this ledger, and what they may do.**
 *
 * ⚠️ **Scoped to the current ledger, and that is the owner's line**: *"这里的关系**始终是账本成员关系**，
 * 而不是微信或 QQ 那样的**全局社交好友关系**"* and *"成员管理必须明确属于当前账本."* So this is keyed
 * by nothing but the ledger in the request header — **the header is what makes it the right ledger.**
 */
export interface BookMemberView {
  readonly userId: string;
  readonly displayName: string;
  readonly username: string;
  readonly accountNumber: string;
  readonly role: "owner" | "editor" | "viewer";
  readonly isCreator: boolean;
}

/**
 * The members of a ledger.
 *
 * ⚠️ **`bookId` is optional and, when given, names the ledger for *this call only*.** It travels as
 * the request header via `apiFetch`'s existing override — the same mechanism the offline queue
 * uses — so **the global "current ledger" is not touched.**
 *
 * ⚠️ **This is what lets the start page's gear panel manage a ledger that is not the current one.**
 * The owner was explicit that the alternative is not allowed: *"不允许通过静默修改全局当前账本来实现
 * 这一点."* Changing the global would move every later request, the offline scope, and the cached
 * slice with it — **to answer a question about a ledger the reader has not entered.**
 *
 * ⚠️ **The cache key carries the ledger**, because otherwise the second ledger's members would be
 * served from the first ledger's cache — the cross-ledger leak this project treats as the worst kind.
 */
export function useBookMembers(bookId?: string) {
  return useQuery({
    queryKey: bookId === undefined ? queryKeys.bookMembers : [...queryKeys.bookMembers, bookId],
    queryFn: () =>
      apiFetch<{ members: readonly BookMemberView[]; myRole: string }>("/books/members", {
        ...(bookId === undefined ? {} : { bookId }),
      }),
    /** ⚠️ Fresh: membership changes from the other side, on their device. */
    staleTime: 0,
  });
}

/**
 * Rename a ledger.
 *
 * ⚠️ **Both ids are sent, and they must agree.** The route takes the ledger from the path and the
 * permission from the header, and refuses with `book_mismatch` if they differ — so this passes the
 * same id to both, which is the only honest thing a caller can do.
 *
 * ⚠️ **`bookId` is required here, unlike the read hooks**, because a rename has no "current ledger"
 * default that is safe: the panel renames *the ledger whose gear was tapped*, and a rename that
 * silently fell back to the current one would be the exact mistake the owner warned about.
 */
export function useRenameBook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { bookId: string; name: string }) =>
      apiFetch<{ ok: boolean; book: { id: string; name: string; bookNumber: string | null } }>(
        `/books/${input.bookId}`,
        { method: "PATCH", bookId: input.bookId, body: { name: input.name } },
      ),
    onSuccess: (_result, input) => {
      /** ⚠️ The list the reader is looking at, and the ledger header if this was the current one. */
      void queryClient.invalidateQueries({ queryKey: queryKeys.books });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ledger });
      /**
       * ⚠️ **The history prefix, not one limit.** `ledgerHistory` is keyed by limit — the start page
       * shows 2, the history screen 200 — so invalidating a single limit would refresh one screen and
       * leave the other showing a name the ledger no longer has. **Prefix matching is what makes
       * "the history changed" mean all of it.**
       */
      void queryClient.invalidateQueries({ queryKey: ["ledger-history"] });
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.bookMembers, input.bookId] });
    },
  });
}

/**
 * Change somebody's role in a ledger.
 *
 * ⚠️ **`bookId` is optional and, when given, names the ledger for this call** — the start page's gear
 * panel manages a ledger the reader is not in, and **every write it offers must carry that ledger
 * explicitly.** Omitting it means the ledger the reader is in, which is what the 成员管理 screen means.
 *
 * ⚠️ **The invalidation follows the same split**: with a `bookId` it refreshes *that* ledger's members
 * and history; without one it refreshes the current ledger's. Refreshing the wrong one would leave the
 * screen showing a name it just changed, which reads as the save having failed.
 */
export function useChangeMemberRole(bookId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { userId: string; role: "editor" | "viewer" }) =>
      apiFetch<{ ok: boolean; changed: boolean }>(`/books/members/${input.userId}`, {
        method: "PATCH",
        ...(bookId === undefined ? {} : { bookId }),
        body: { role: input.role },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: bookId === undefined ? queryKeys.bookMembers : [...queryKeys.bookMembers, bookId],
      });
      /** ⚠️ The tab's own label comes from the member count, so it has to be refreshed too. */
      void queryClient.invalidateQueries({ queryKey: queryKeys.ledger });
      void queryClient.invalidateQueries({ queryKey: ["ledger-history"] });
    },
  });
}

export function useRemoveMember(bookId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<unknown>(`/books/members/${userId}`, {
        method: "DELETE",
        ...(bookId === undefined ? {} : { bookId }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: bookId === undefined ? queryKeys.bookMembers : [...queryKeys.bookMembers, bookId],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ledger });
      void queryClient.invalidateQueries({ queryKey: ["ledger-history"] });
    },
  });
}

/**
 * **这本账的公共留言。**
 *
 * ⚠️ **Belongs to the ledger, not to a conversation** — the owner: *"它只属于当前账本"* and
 * *"**不提供私人聊天**"*. So there is no per-person key here and no unread state: **the board is the
 * same board for everybody in the ledger**, which is exactly what makes it a discussion about the
 * books rather than a messaging app.
 */
export interface BookMessageView {
  readonly id: string;
  readonly senderId: string;
  /** ⚠️ The name **as it was when sent** — the server stores a snapshot, so renaming does not rewrite it. */
  readonly senderName: string;
  readonly body: string;
  readonly createdAt: string;
  readonly mine: boolean;
}

export function useBookMessages() {
  return useQuery({
    queryKey: queryKeys.bookMessages,
    queryFn: () =>
      apiFetch<{ messages: readonly BookMessageView[]; total: number }>("/books/messages?limit=100"),
    /**
     * ⚠️ **Always fresh.** Somebody else's message is the entire point, and they send it from their
     * own device — **a cached board is a board that stops at the last thing you said.**
     */
    staleTime: 0,
  });
}

export function useSendBookMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: string) =>
      apiFetch<{ ok: boolean; id: string }>("/books/messages", { method: "POST", body: { body } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.bookMessages }),
  });
}

/**
 * **One ledger's metadata, as a plain read — for a ledger the reader is *not* entering.**
 *
 * ⚠️ **⚠️ This exists because `useLedger` must not be reused for another ledger, and that is not a
 * style preference.** `useLedger` calls `setCurrentBook()` and `setOfflineBook()` — they are *how the
 * device learns which ledger it is in*, which is correct for the screen the reader is looking at and
 * **completely wrong for a ledger they merely tapped a gear on.** Reusing it there would silently move
 * the request header, the offline scope and the cached slice to a ledger nobody entered.
 *
 * ⚠️ **So this is the same endpoint with the two side effects deliberately absent**, and it has its
 * own query key. Sharing `queryKeys.ledger` would let a per-book answer overwrite the current
 * ledger's metadata in the cache — **the cross-ledger leak this project treats as the worst kind**,
 * in the shape that is hardest to notice: a correct-looking screen showing the wrong ledger.
 */
export function useLedgerMeta(bookId: string) {
  return useQuery({
    queryKey: [...queryKeys.ledgerMeta, bookId],
    queryFn: () =>
      apiFetch<LedgerMetaResponse>("/ledger", {
        ...(bookId === "" ? {} : { bookId }),
      }),
    staleTime: 0,
  });
}

export function useLedger() {  return useQuery({
    queryKey: queryKeys.ledger,
    queryFn: async () => {
      const ledger = await apiFetch<LedgerMetaResponse>("/ledger");

      /**
       * ⚠️ **This is where the device learns which ledger it is in**, and it is the right place
       * for it: the ledger metadata carries the id, and every screen that shows a ledger already
       * loads this. Putting it in a component would mean the answer depended on which screen
       * happened to mount first.
       *
       * It has to happen before other ledger-scoped requests, so this must stay ahead of any
       * early return in the function above — see `lib/currentBook.ts` for why the value cannot
       * simply be read from React state.
       */
      setCurrentBook(ledger.book.id);

      /**
       * ⚠️ **The offline copy is scoped by account *and* ledger.** This sets the ledger half; the
       * account half is set by the auth layer when the session is known. **The scope only takes
       * effect once both are present** — see `offline/scope.ts` for why a half-filled scope would
       * be worse than none: it would read another account's copy while looking correct.
       *
       * ⚠️ **The migration runs here, once, before anything reads the stored copy.** Everything
       * written before scoping existed belonged to the single account and single ledger there used
       * to be — so it is moved into the scope that is now current. **Skipping this would make sixty
       * downloaded months vanish from a device that still has every byte of them**, which is
       * precisely the failure `档案/离线与同步-设计决定.md` is about.
       */
      setOfflineBook(ledger.book.id);
      /**
       * ⚠️ **All three of the device's own keys move together, including the query cache.**
       *
       * `query-cache` was held back until the scope could be resolved *synchronously at startup*,
       * because the persister reads it once, early. Migrating it to a key the persister never
       * reads would have been worse than leaving it: **the data would still be on the device and
       * the application would behave as though it had never existed.** Now that
       * `restoreOfflineScopeSync` runs before the first render, the persister addresses the scoped
       * key and the migration has somewhere real to put the copy.
       *
       * ⚠️ **Copied, never moved** — see `migrateUnscopedKeys`. If this ever runs before the
       * account is known, the old key is still there to be migrated again.
       */
      void migrateUnscopedKeys(["ledger-months", "ledger-marks", CACHE_KEY]);

      return ledger;
    },
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
   * ⚠️ **Tell the query layer when a local write happens.**
   *
   * The ledger screen prefers the query's data when it has any — deliberately, since a server answer is
   * the truth. **That preference is why an offline edit did not appear**: the store was refreshed and the
   * query's cached pages were sitting in front of it, so the screen kept showing the old list until the
   * network came back and the query itself changed.
   *
   * Invalidating is what makes the trusted layer let go of an answer that is no longer true. **A refetch
   * that fails while offline does not undo anything** — the store already holds the change.
   */
  installQueryNotifier(async (changed) => {
    /**
     * ⚠️ **The affected months are written into the query cache directly, not invalidated.**
     *
     * Invalidating says "go and look again", and looking again is what read the previous value — the
     * screen was left one write behind, which is exactly what the owner described: he wrote an entry and
     * saw the *previous* one appear.
     *
     * **Writing the new list in removes the question.** Every transaction query whose month contains a
     * changed entry gets a fresh page built from the device, so the cache holds the truth immediately and
     * nothing has to be re-read to discover it.
     *
     * ⚠️ **Only the affected months are touched.** Rewriting every cached month would discard the server's
     * own ordering and paging for months this write has nothing to do with.
     */
    updateTransactionViews(queryClient, changed);

    /**
     * ⚠️ **The summary and single-entry queries are invalidated**, because their answers are computed
     * rather than listed — there is no local page to hand them, so asking again is the honest move, and a
     * refetch that fails offline changes nothing.
     */
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["summary"] }),
      queryClient.invalidateQueries({ queryKey: ["transaction"] }),
    ]);
  });

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
    /**
     * ⚠️ **The queue is republished alongside the read**, so the pending colour survives a reload without
     * anything having to be written first. **The colour comes from the queue, and the queue is on disk.**
     */
    void (async () => {
      await readLocalTransactions();
      await refreshPending();
    })();
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
      }).then(async (answer) => {
        // A list may be filtered or only the final page. Its membership cannot
        // acknowledge writes or clear conflict marks; only write responses can.
        if (answer.nextCursor === null) {
          void (async () => {
            await syncAll();
            await refreshPending();
          })();
        }

        return answer;
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
    void (async () => {
      await readLocalTransactions();
      await refreshPending();
    })();
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
