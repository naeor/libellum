import { authResponseSchema, meResponseSchema, type SessionUser } from "@libellum/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../lib/api.js";

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
  login(username: string, password: string): Promise<void>;
  register(input: RegisterInput): Promise<string | undefined>;
  logout(): Promise<void>;
  reload(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<"loading" | "ready">("loading");

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

  const login = useCallback(async (username: string, password: string) => {
    const response = authResponseSchema.parse(
      await apiFetch<unknown>("/auth/login", { method: "POST", body: { username, password } }),
    );
    setUser(response.user);
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const response = authResponseSchema.parse(
      await apiFetch<unknown>("/auth/register", { method: "POST", body: input }),
    );
    setUser(response.user);
    return response.recoveryCode;
  }, []);

  const logout = useCallback(async () => {
    await apiFetch<unknown>("/auth/logout", { method: "POST" });
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, login, register, logout, reload }),
    [user, status, login, register, logout, reload],
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
