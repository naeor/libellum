import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { AuthProvider, useAuth } from "./auth/AuthProvider.js";
import { ChangePasswordPage } from "./pages/ChangePasswordPage.js";
import { HomePage } from "./pages/HomePage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { RecoverPage } from "./pages/RecoverPage.js";
import { RegisterPage } from "./pages/RegisterPage.js";
import { RegenerateRecoveryCodePage } from "./pages/RegenerateRecoveryCodePage.js";

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

      {/* Account settings live one level below the home page. A full settings
          screen will host them later; the routes are already nested for that. */}
      <Route
        path="/settings/password"
        element={
          <RequireAuth>
            <ChangePasswordPage />
          </RequireAuth>
        }
      />
      <Route
        path="/settings/recovery-code"
        element={
          <RequireAuth>
            <RegenerateRecoveryCodePage />
          </RequireAuth>
        }
      />

      <Route
        path="/"
        element={
          <RequireAuth>
            <HomePage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
