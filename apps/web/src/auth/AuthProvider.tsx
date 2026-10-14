import { authResponseSchema, meResponseSchema, type SessionUser } from "@libellum/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { ApiRequestError, apiFetch } from "../lib/api.js";
import { clearQueryCache } from "../lib/offline/cache.js";
import { forgetUser, readRememberedUser, rememberUser } from "../lib/offline/storage.js";
import { forgetCurrentBook } from "../lib/currentBook.js";
import { setOfflineAccount } from "../lib/offline/scope.js";

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
 * ⚠️ **"Only one session per account is allowed" used to be true and is not any more.** The owner
 * removed that rule once the offline design needed two devices holding two copies of one ledger —
 * see the note on `issueSession` in `apps/api/src/routes/auth.ts`. What survives is the reason for
 * this timer: **this tab has to find out that its session ended**, and without the check it would
 * keep showing a signed-in interface until the user happened to reload.
 *
 * ⚠️ **And when it does find out, the cleanup must be the same as a sign-out.** That is the bug
 * this file was fixed for in 1.10.02: the expiry path signed the user out but kept the previous
 * account's ledger, so the next account to sign in on this device saw *somebody else's* ledger
 * number on screen. See `forgetLocalState`.
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

  /**
   * Drop everything on this device that belongs to the account being left behind.
   *
   * ⚠️ **This was extracted because a second path needed it and had been missing it.**
   *
   * Before this, only `logout()` cleaned up. **A session that ended any other way left the
   * device pointing at the previous account's ledger**, and the owner found it by using the
   * app: he signed in as another account and saw *his own* ledger number on screen.
   *
   * What happened, step by step:
   *
   *  1. the session expired, so `reload()` got a 401 — which is *"only the server may end a
   *     session"*, and correctly signs the user out;
   *  2. but that path only called `forgetUser()` and `setSessionRevoked(true)`. It did **not**
   *     call `forgetCurrentBook()`, unlike `logout()`;
   *  3. the app landed on the login page with `current-book` still set to the previous
   *     account's book id, kept in memory **and** on the device;
   *  4. signing in as somebody else set the new user but left that id alone, so the very next
   *     request declared a book the new account is not a member of;
   *  5. the server refused it — 403, permission is still decided by `book_members` and nothing
   *     leaked — but the cached metadata for that book was still on screen, so the ledger label
   *     read as the **other account's** number.
   *
   * ⚠️ **The order is load-bearing and is inherited from `logout()`**: the query cache is
   * cleared *before* the scope collapses, because the cache lives under a scoped key. Clearing
   * it after the scope had been emptied would delete the *unscoped* key and leave this account's
   * cached responses behind under the scoped one — the opposite of the intent.
   */
  const forgetLocalState = useCallback(async () => {
    await forgetUser();
    await clearQueryCache();
    /**
     * ⚠️ **The remembered ledger goes with the account.** Inheriting it would aim the next
     * person's requests at somebody else's book: the server would refuse, but the client should
     * not ask, and it should not show the wrong ledger's cached copy on the way there.
     */
    forgetCurrentBook();
    setOfflineAccount(null);
  }, []);

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
        /**
         * ⚠️ **This is a sign-out, so it has to clean up like one.** Treating it as "just
         * forget the user" is the defect described on `forgetLocalState`.
         */
        await forgetLocalState();
        setSessionRevoked(true);
        setUser(null);
      } else {
        setUser(await readRememberedUser());
      }
    } finally {
      setStatus("ready");
    }
  }, [forgetLocalState]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * ⚠️ **The account half of the offline scope follows the session, from one place.**
   *
   * `user` is set in six different paths — restored from storage, refreshed, signed in, registered,
   * recovered, signed out — and **an effect is the only way to be sure all six are covered.** The
   * version of this that set the scope inside each path would have missed one, and the failure
   * mode of a missing account is a device that reads **the previous person's ledger** out of
   * IndexedDB.
   *
   * ⚠️ Setting `null` is as important as setting an id: on sign-out the scope must collapse, so
   * the next account cannot inherit it.
   */
  useEffect(() => {
    setOfflineAccount(user?.id ?? null);
  }, [user]);

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

  const login = useCallback(
    async (username: string, password: string) => {
      /**
       * ⚠️ **Who was here before, captured before the request replaces them.**
       *
       * This is the second half of the fix for "signing in as another account shows the previous
       * account's ledger". `forgetLocalState` covers the session-expiry path; this covers the
       * case where the app reached the login screen some other way and the device still holds
       * the earlier account's book id and cached responses.
       *
       * It is also **cheap where it matters most**: signing back in as *yourself* keeps the
       * offline copy, and only a genuine change of account clears it. A blanket wipe on every
       * sign-in would throw away the ledger copy of someone who was simply logged out.
       */
      const previous = await readRememberedUser();

      const response = authResponseSchema.parse(
        await apiFetch<unknown>("/auth/login", { method: "POST", body: { username, password } }),
      );

      if (previous !== null && previous.id !== response.user.id) {
        await forgetLocalState();
      }

      setSessionRevoked(false);
      setUser(response.user);
      await rememberUser(response.user);
    },
    [forgetLocalState],
  );

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
     * The server call is attempted but not required: a logout that only works with
     * a network is not a logout.
     *
     * ⚠️ **The cleanup itself moved into `forgetLocalState`, which the session-expiry path now
     * calls as well.** Leaving it inline here is what let that path sign the user out without
     * letting go of their ledger — see the long note on `forgetLocalState`.
     */
    await forgetLocalState();

    try {
      await apiFetch<unknown>("/auth/logout", { method: "POST" });
    } catch {
      // The session cookie will be refused or replaced on the next sign-in anyway.
    }

    setUser(null);
  }, [forgetLocalState]);

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
