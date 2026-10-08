import { authResponseSchema, meResponseSchema, type SessionUser } from "@libellum/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { ApiRequestError, apiFetch } from "../lib/api.js";

interface RegisterInput {
  readonly inviteCode: string;
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
}

interface AuthContextValue {
  readonly user: SessionUser | null;
  /** `loading` until the first /auth/me answer arrives. */
  readonly status: "loading" | "ready";
  /**
   * Set when the server rejected our session because the account signed in
   * somewhere else. The login screen uses it to explain why.
   */
  readonly sessionRevoked: boolean;
  login(username: string, password: string): Promise<void>;
  register(input: RegisterInput): Promise<string | undefined>;
  logout(): Promise<void>;
  reload(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * How often an open tab asks the server whether its session is still valid.
 *
 * Only one session per account is allowed, so signing in on another device
 * silently ends this one. Without a check, this tab would keep showing a
 * signed-in interface until the user happened to reload.
 */
const REVALIDATE_INTERVAL_MS = 60_000;

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [sessionRevoked, setSessionRevoked] = useState(false);

  const reload = useCallback(async () => {
    try {
      const response = await apiFetch<unknown>("/auth/me");
      setUser(meResponseSchema.parse(response).user);
    } catch {
      setUser(null);
    } finally {
      setStatus("ready");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // While a user is signed in, revalidate periodically and whenever the tab
  // regains focus — returning to the window is exactly when someone would
  // notice that they were signed out elsewhere.
  useEffect(() => {
    if (!user) return;

    let cancelled = false;

    async function revalidate(): Promise<void> {
      try {
        const response = await apiFetch<unknown>("/auth/me");
        if (!cancelled) setUser(meResponseSchema.parse(response).user);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          setSessionRevoked(true);
          setUser(null);
        }
      }
    }

    const timer = window.setInterval(() => void revalidate(), REVALIDATE_INTERVAL_MS);
    const onFocus = (): void => void revalidate();
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void revalidate();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user]);

  const login = useCallback(async (username: string, password: string) => {
    const response = authResponseSchema.parse(
      await apiFetch<unknown>("/auth/login", { method: "POST", body: { username, password } }),
    );
    setSessionRevoked(false);
    setUser(response.user);
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const response = authResponseSchema.parse(
      await apiFetch<unknown>("/auth/register", { method: "POST", body: input }),
    );
    setSessionRevoked(false);
    setUser(response.user);
    return response.recoveryCode;
  }, []);

  const logout = useCallback(async () => {
    await apiFetch<unknown>("/auth/logout", { method: "POST" });
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, sessionRevoked, login, register, logout, reload }),
    [user, status, sessionRevoked, login, register, logout, reload],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }

  return context;
}
