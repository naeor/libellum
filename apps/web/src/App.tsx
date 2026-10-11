import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { AuthProvider, useAuth } from "./auth/AuthProvider.js";
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
import { BooksPage } from "./pages/BooksPage.js";
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
import { CollaboratorsPage } from "./pages/PlaceholderPages.js";
import { ProfilePage } from "./pages/ProfilePage.js";
import { StatsPage } from "./pages/StatsPage.js";
import { RecoverPage } from "./pages/RecoverPage.js";
import { RegisterPage } from "./pages/RegisterPage.js";
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

const queryClient = new QueryClient({
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

function Splash(): React.JSX.Element {
  return (
    <main className="flex min-h-full items-center justify-center text-sm text-muted">载入中…</main>
  );
}

function RequireAuth({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const { user, status } = useAuth();

  if (status === "loading") return <Splash />;
  if (!user) return <Navigate to="/login" replace />;

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
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/recover" element={<RecoverPage />} />

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
        path="/collaborators"
        element={
          <RequireAuth>
            <CollaboratorsPage />
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
      <Route path="/books" element={<RequireAuth><BooksPage /></RequireAuth>} />
      <Route path="/about" element={<RequireAuth><AboutPage /></RequireAuth>} />

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

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
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
        <AuthProvider>
          {/*
            Inside AuthProvider, because there is nothing to fetch until we know
            who is signed in — and outside the router, because it must not restart
            when the reader changes screen.
          */}
          <OfflineFillProvider>
            <UndoProvider>
            <BrowserRouter>
              {/*
                Inside the router, because the recording menu folds itself when
                the reader moves to another screen — which it can only notice
                from the location.
              */}
              <AppShell>
                <AppRoutes />
              </AppShell>
            </BrowserRouter>
            </UndoProvider>
          </OfflineFillProvider>
        </AuthProvider>
      </PersistQueryClientProvider>
    </ErrorBoundary>
  );
}
