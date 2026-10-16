import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Suspense, lazy, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { AuthProvider, useAuth } from "./auth/AuthProvider.js";
import { AccountEntry } from "./auth/AccountEntry.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { AppShell } from "./components/Layouts.js";
import { OfflineFillProvider } from "./components/OfflineFillProvider.js";
import { UndoProvider } from "./components/UndoProvider.js";
import { CACHE_MAX_AGE_MS, cachePersister, shouldPersistQuery } from "./lib/offline/cache.js";
import { primeDeviceId } from "./lib/api.js";
import { deviceId } from "./lib/offline/device.js";
import { startSyncTriggers } from "./lib/offline/syncController.js";
import { AboutPage } from "./pages/AboutPage.js";
import { AddEntryPage } from "./pages/AddEntryPage.js";
import { ChangePasswordPage } from "./pages/ChangePasswordPage.js";
import { DetailPage } from "./pages/DetailPage.js";
import { DownloadManagerPage } from "./pages/DownloadManagerPage.js";
import { DownloadMorePage } from "./pages/DownloadMorePage.js";
import { SoftwareUpdatePage } from "./pages/SoftwareUpdatePage.js";
import { MonthDownloadPage } from "./pages/MonthDownloadPage.js";
import { EntryDetailPage } from "./pages/EntryDetailPage.js";
import { ExportPage } from "./pages/ExportPage.js";
import { LedgerMorePage } from "./pages/LedgerMorePage.js";
import { ImportPage } from "./pages/ImportPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { CategoriesPage, PaymentMethodsPage, TagsPage } from "./pages/ManagePages.js";
import { MePage } from "./pages/MePage.js";
import { LedgerInvitePage } from "./pages/LedgerInvitePage.js";
import { MessageBoardPage } from "./pages/MessageBoardPage.js";
import { JoinPage } from "./pages/JoinPage.js";
import { LedgerHistoryPage } from "./pages/LedgerHistoryPage.js";
import { LedgerInfoPage, LedgerMembersPage } from "./pages/LedgerSubPages.js";
import { LedgerPage } from "./pages/LedgerPage.js";
import { ProfilePage } from "./pages/ProfilePage.js";
import { LedgerSpacePage } from "./pages/LedgerSpacePage.js";
import { StatsPage } from "./pages/StatsPage.js";
import { RecoverPage } from "./pages/RecoverPage.js";
import { RegisterPage } from "./pages/RegisterPage.js";
import { LegalPage } from "./pages/LegalPage.js";
import { StartBookInfoPage, StartBookMembersPage, StartBookSharePage } from "./pages/StartBookPages.js";
import { ReferralCodePage } from "./pages/ReferralCodePage.js";
import { RegenerateRecoveryCodePage } from "./pages/RegenerateRecoveryCodePage.js";
import { RecordPage } from "./pages/RecordPage.js";
import { ScanPage } from "./pages/ScanPage.js";
import { VoiceReviewPage } from "./pages/VoiceReviewPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

/**
 * The chart foundation's development harness.
 *
 * `import.meta.env.DEV` is replaced with `false` in a production build, so the
 * dynamic import is eliminated and this page never reaches the shipped bundle.
 * It exists to look at the drawing primitives under awkward data, which is far
 * cheaper than discovering those cases on a phone.
 */
const ChartLabPage = import.meta.env.DEV
  ? lazy(async () => import("./pages/ChartLabPage.js").then((module) => ({ default: module.ChartLabPage })))
  : null;

function createQueryClient(): QueryClient {
  return new QueryClient({
  defaultOptions: {
    queries: {
      // A ledger is small and personal; refetching on every window focus would
      // be noise. Mutations invalidate exactly what they changed.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
      /**
       * ⚠️ **`Infinity`, and this default was deleting the user's downloaded history.**
       *
       * TanStack's default is five minutes: a query nobody is observing any more has its data
       * **removed from the in-memory cache**. That is sensible for a web app whose cache is a cache.
       *
       * **Here the cache is the data.** The owner asked for his whole history to be available offline,
       * the download writes sixty months of it, and **the persistence layer saves the in-memory cache
       * wholesale** — so every month whose screen had been left five minutes earlier was dropped from
       * memory and then written out of storage with it. His cache listing showed it exactly:
       * `ledger`, a single `transaction`, `summary` and several `stats` entries all present, and
       * **not one `transactions · month=…` entry** — the per-month lists were gone, which is why the
       * analysis screen had nothing to compute from and why only one local read ever appeared.
       *
       * **A cache that has to be held open to stay on the device is not an offline copy.** With
       * `Infinity`, what was downloaded stays until something deliberately replaces it.
       *
       * The cost is bounded and known: this is one person's ledger, about 115 KB for sixty months.
       * The alternative — evicting it — costs the feature it was downloaded for.
       *
       * ⚠️ **It matches `CACHE_MAX_AGE_MS`, which was already `Infinity`.** The stored copy was never
       * allowed to expire; the in-memory copy was expiring after five minutes and taking the stored one
       * with it. **Two expiry policies for one cache, and the shorter one won.**
       */
      gcTime: Number.POSITIVE_INFINITY,
    },
  },
  });
}

function Splash(): React.JSX.Element {
  return (
    <main className="flex min-h-full items-center justify-center text-body text-muted">载入中…</main>
  );
}

function RequireAuth({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const { user, status } = useAuth();

  if (status === "loading") return <Splash />;
  if (!user) return <Navigate to="/login" replace />;

  return <>{children}</>;
}

/**
 * ⚠️ **The same check, but it carries the destination through the sign-in.**
 *
 * A share link is the one URL in the app that a signed-out visitor is *supposed* to arrive at, and
 * the token in it is the whole message. `RequireAuth` sends them to `/login` and **the token is gone
 * from the address bar** — so this variant passes it along as `?next=`, and the login screen returns
 * there. The check itself is unchanged; only the destination survives.
 */
function RequireAuthKeepingPath({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const { user, status } = useAuth();

  if (status === "loading") return <Splash />;
  if (!user) {
    const next = `${window.location.pathname}${window.location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  return <>{children}</>;
}

function AppRoutes(): React.JSX.Element {
  const { status } = useAuth();

  /**
   * ⚠️ **The queue needs something to drain it, and until now nothing did.**
   *
   * `drainOutbox` was written and **never called from anywhere**, and nothing listened for the network coming
   * back — so an entry recorded offline was delivered only if the user happened to record something else
   * while online. **That is why unsynced rows accumulated and the pale red never cleared**, and why writing a
   * new entry made older ones look wrong: they genuinely were still waiting, and nobody was ever going to
   * send them.
   *
   * The owner asked for the missing piece directly: **"设计一个每次连上网的时候立刻核对一遍所有的账单，然后
   * 发现变量为零时，就把它上传到服务器上，然后把它的变量改成一."** Delivery is what makes it synced, and
   * delivery is what removes it from the queue — **one action, not two that can disagree.**
   */
  /**
   * ⚠️ **The device tells the server who it is before the first request goes out**, because the conflict record
   * has to answer "which two devices disagreed" — and a header cannot wait for a promise.
   */
  useEffect(() => {
    void deviceId().then(primeDeviceId);
  }, []);

  useEffect(() => startSyncTriggers(), []);

  // Wait for the first /auth/me before deciding where to send the visitor,
  // otherwise a signed-in user would flash the login screen on every reload.
  if (status === "loading") return <Splash />;

  return (
    <Routes>
      <Route
        path="/"
        element={
          <RequireAuth>
            <DetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/add"
        element={
          <RequireAuth>
            <AddEntryPage />
          </RequireAuth>
        }
      />
      <Route
        path="/stats"
        element={
          <RequireAuth>
            <StatsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/me"
        element={
          <RequireAuth>
            <MePage />
          </RequireAuth>
        }
      />

      <Route
        path="/transactions/:id"
        element={
          <RequireAuth>
            <EntryDetailPage />
          </RequireAuth>
        }
      />

      <Route path="/scan" element={<RequireAuth><ScanPage /></RequireAuth>} />
        <Route path="/record" element={<RequireAuth><RecordPage /></RequireAuth>} />
        <Route path="/ledger/more" element={<RequireAuth><LedgerMorePage /></RequireAuth>} />
        <Route path="/voice/review" element={<RequireAuth><VoiceReviewPage /></RequireAuth>} />
      <Route path="/export" element={<RequireAuth><ExportPage /></RequireAuth>} />
      <Route path="/import" element={<RequireAuth><ImportPage /></RequireAuth>} />
      <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
      <Route path="/downloads" element={<RequireAuth><DownloadManagerPage /></RequireAuth>} />
        <Route path="/downloads/more" element={<RequireAuth><DownloadMorePage /></RequireAuth>} />
        <Route path="/update" element={<RequireAuth><SoftwareUpdatePage /></RequireAuth>} />
        <Route path="/downloads/:month" element={<RequireAuth><MonthDownloadPage /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
      <Route path="/settings/password" element={<RequireAuth><ChangePasswordPage /></RequireAuth>} />
      {/**
        * ⚠️ **邀请码现在是一页，入口在设置-账号安全。** 所有者 2026-10-13：
        * *"账户里边生成邀请码单独包装成一个入口，放到设置-账号安全里面."*
        * 它与 更改密码、生成新的恢复码 并列——三者都是**关于账号本身**的。
        */}
      <Route path="/settings/referral-codes" element={<RequireAuth><ReferralCodePage /></RequireAuth>} />
      <Route
        path="/settings/recovery-code"
        element={
          <RequireAuth>
            <RegenerateRecoveryCodePage />
          </RequireAuth>
        }
      />
      <Route path="/categories" element={<RequireAuth><CategoriesPage /></RequireAuth>} />
      <Route path="/payment-methods" element={<RequireAuth><PaymentMethodsPage /></RequireAuth>} />
      <Route path="/tags" element={<RequireAuth><TagsPage /></RequireAuth>} />
            {/* ⚠️ 账本空间现在只有一个地址。`/books` 保留为重定向，因为旧链接与书签里还有它。 */}
      <Route path="/books" element={<Navigate to="/start" replace />} />
      {/* ⚠️ 账本空间：目前是占位页，见 `档案/账本与协作页-设计决定.md` §2.4 与 §8。 */}
      {/* ⚠️ 账本空间：展示态与常规态是**同一个页面的两个状态**，不是两个路由。 */}
      <Route path="/start" element={<RequireAuth><LedgerSpacePage /></RequireAuth>} />
      {/* ⚠️ 账本 / 协作：底部第四项。名称由成员数决定，但**只有一个路由**。 */}
      <Route path="/ledger" element={<RequireAuth><LedgerPage /></RequireAuth>} />
      <Route path="/ledger/history" element={<RequireAuth><LedgerHistoryPage /></RequireAuth>} />
      <Route path="/ledger/info" element={<RequireAuth><LedgerInfoPage /></RequireAuth>} />
      <Route path="/ledger/members" element={<RequireAuth><LedgerMembersPage /></RequireAuth>} />
      <Route path="/ledger/invite" element={<RequireAuth><LedgerInvitePage /></RequireAuth>} />
      {/**
        * ⚠️ **留言的完整对话是一个独立路由，而不是弹层。** 所有者明确要求全屏：
        * *"点击「展开」后，进入独立的全屏留言界面，而不是弹窗或半屏抽屉."*
        * 独立路由的意义是**手机返回手势与浏览器返回键都能关掉它**——弹层得自己实现这两件事，
        * 并且总会在某个人的手机上做错一个。
        */}
      <Route path="/ledger/messages" element={<RequireAuth><MessageBoardPage /></RequireAuth>} />
      {/**
        * ⚠️ **一本账的目标页面 —— 齿轮面板打开的二级页（1.10.08）。**
        *
        * 三条路由都以**账本 id 在 URL 里**为共同点，因为齿轮面板管理的**可以不是当前账本**。
        * 页内所有请求都把那个 id 放进请求头（用 `apiFetch` 已有的单次覆盖机制），
        * **所以全局「当前账本」一动不动**——所有者明确禁止静默切换：
        * *"不允许通过静默修改全局当前账本来实现这一点."*
        */}
      <Route path="/start/book/:bookId" element={<RequireAuth><StartBookInfoPage /></RequireAuth>} />
      <Route path="/start/book/:bookId/members" element={<RequireAuth><StartBookMembersPage /></RequireAuth>} />
      <Route path="/start/book/:bookId/share" element={<RequireAuth><StartBookSharePage /></RequireAuth>} />
      {/**
        * ⚠️ **A share link must be reachable while signed out**, and must come back to itself after
        * signing in — that is why it uses the variant that keeps the path.
        */}
      <Route
        path="/join/:token"
        element={
          <RequireAuthKeepingPath>
            <JoinPage />
          </RequireAuthKeepingPath>
        }
      />
      <Route path="/about" element={<RequireAuth><AboutPage /></RequireAuth>} />
      {/**
        * ⚠️ **两份法律文档各自有路由，内容明确写着"尚未编写"。** 所有者要求页脚三项都可点，
        * 而**可点却无处可去比一个标签更糟**；同时他要求**不得编造条款**——
        * 所以这两页的内容就是"这份文档还不存在"，外加一份上线前必须写清楚的清单。
        */}
      <Route path="/legal/privacy" element={<RequireAuth><LegalPage kind="privacy" /></RequireAuth>} />
      <Route path="/legal/terms" element={<RequireAuth><LegalPage kind="terms" /></RequireAuth>} />

      {ChartLabPage === null ? null : (
        <Route
          path="/lab/charts"
          element={
            <Suspense fallback={<Splash />}>
              <ChartLabPage />
            </Suspense>
          }
        />
      )}

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function AccountWorkspace(): React.JSX.Element {
  const [queryClient] = useState(createQueryClient);
  return (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: cachePersister,
          maxAge: CACHE_MAX_AGE_MS,
          /**
           * Which queries are worth keeping on the device.
           *
           * Decided per query rather than by a blanket rule, because "will this
           * answer still be the answer tomorrow" is a question only the query's own
           * author can answer. See `shouldPersistQuery`.
           */
          dehydrateOptions: {
            shouldDehydrateQuery: shouldPersistQuery,
          },
          /**
           * `buster` invalidates every stored cache when it changes.
           *
           * Bumped by hand when the shape of a response changes. Without it, an
           * upgrade would restore yesterday's responses into code that expects a
           * new field, and the app would read `undefined` from its own cache —
           * which is a class of bug that only ever appears on somebody else's
           * phone, after a deploy.
           */
          buster: "v1",
        }}
      >
          {/*
            Inside AuthProvider, because there is nothing to fetch until we know
            who is signed in and which ledger is current. The protected workspace
            remains mounted while navigating between its routes.
          */}
          <OfflineFillProvider>
            <UndoProvider>
              {/*
                Inside the router, because the recording menu folds itself when
                the reader moves to another screen — which it can only notice
                from the location.
              */}
              <AppShell>
                <AppRoutes />
              </AppShell>
            </UndoProvider>
          </OfflineFillProvider>
      </PersistQueryClientProvider>
  );
}

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/recover" element={<RecoverPage />} />
            <Route path="*" element={<AccountEntry><AccountWorkspace /></AccountEntry>} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}
