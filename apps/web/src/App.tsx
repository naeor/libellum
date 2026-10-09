import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { AuthProvider, useAuth } from "./auth/AuthProvider.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { UndoProvider } from "./components/UndoProvider.js";
import { AboutPage } from "./pages/AboutPage.js";
import { AddEntryPage } from "./pages/AddEntryPage.js";
import { BooksPage } from "./pages/BooksPage.js";
import { ChangePasswordPage } from "./pages/ChangePasswordPage.js";
import { DetailPage } from "./pages/DetailPage.js";
import { EntryDetailPage } from "./pages/EntryDetailPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { CategoriesPage, PaymentMethodsPage, TagsPage } from "./pages/ManagePages.js";
import { MePage } from "./pages/MePage.js";
import { CollaboratorsPage, StatsPage } from "./pages/PlaceholderPages.js";
import { RecoverPage } from "./pages/RecoverPage.js";
import { RegisterPage } from "./pages/RegisterPage.js";
import { RegenerateRecoveryCodePage } from "./pages/RegenerateRecoveryCodePage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A ledger is small and personal; refetching on every window focus would
      // be noise. Mutations invalidate exactly what they changed.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
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

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <UndoProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </UndoProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
