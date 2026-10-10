import { authResponseSchema, meResponseSchema, type SessionUser } from "@libellum/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { ApiRequestError, apiFetch } from "../lib/api.js";
import { clearQueryCache } from "../lib/offline/cache.js";
import { forgetUser, readRememberedUser, rememberUser } from "../lib/offline/storage.js";

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

/**
 * What to do when asking the server who is signed in does not work.
 *
 * ⚠️ **"Offline" and "signed out" were being treated as the same thing**, and they
 * are opposites. `GET /auth/me` fails offline, and the handler that answered it set
 * the user to `null` on *any* failure — so opening the app without a network logged
 * the user out, hid their cached ledger behind a login screen, and left them unable
 * to get past it, because logging in needs a network too. The app was unusable in
 * exactly the situation it exists for.
 *
 * **Only the server may end a session.** A `401` is the server saying so; anything
 * else is us failing to ask, and the right answer to that is to carry on with what
 * we already knew.
 *
 * A pure function of the status code, so the rule can be tested without a DOM, a
 * network or a renderer — it is one of the two decisions in this app that a wrong
 * answer makes the program useless rather than merely wrong.
 */
export type AuthOutcome = "signed-out" | "remembered";

export function decideAuthOutcome(status: number | null): AuthOutcome {
  return status === 401 ? "signed-out" : "remembered";
}

/** The status an error carries, or `null` when it is not an API answer at all. */
function statusOf(error: unknown): number | null {
  return error instanceof ApiRequestError ? error.status : null;
}

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [sessionRevoked, setSessionRevoked] = useState(false);

  const reload = useCallback(async () => {
    try {
      const response = await apiFetch<unknown>("/auth/me");
      const current = meResponseSchema.parse(response).user;
      setUser(current);
      // Kept so that a later launch without a network can show the same interface.
      await rememberUser(current);
    } catch (error) {
      /**
       * See `decideAuthOutcome` above for why this distinction exists. The short
       * version: only the server may end a session, and failing to reach it is not
       * the server saying anything.
       */
      if (decideAuthOutcome(statusOf(error)) === "signed-out") {
        await forgetUser();
        setSessionRevoked(true);
        setUser(null);
      } else {
        setUser(await readRememberedUser());
      }
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
    await rememberUser(response.user);
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const response = authResponseSchema.parse(
      await apiFetch<unknown>("/auth/register", { method: "POST", body: input }),
    );
    setSessionRevoked(false);
    setUser(response.user);
    await rememberUser(response.user);
    return response.recoveryCode;
  }, []);

  const logout = useCallback(async () => {
    /**
     * ⚠️ **The order matters, and the second step matters more.**
     *
     * The local data goes first: if the request failed, the user still expects to
     * be logged out of *this device*, and the next person to open the app must not
     * find somebody's ledger on it. The offline feature must not become the reason
     * that happens.
     *
     * `forgetUser` before `clearQueryCache`, because a crash between the two would
     * leave a signed-out app that still believes it knows who was here.
     *
     * The server call is attempted but not required: a logout that only works with
     * a network is not a logout.
     */
    await forgetUser();
    await clearQueryCache();

    try {
      await apiFetch<unknown>("/auth/logout", { method: "POST" });
    } catch {
      // The session cookie will be refused or replaced on the next sign-in anyway.
    }

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
