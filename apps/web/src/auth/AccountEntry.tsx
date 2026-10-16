import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";

import { useAuth } from "./AuthProvider.js";
import { ApiRequestError, apiFetch } from "../lib/api.js";
import { entryBookId, entryPath } from "../lib/accountEntry.js";
import { currentBookId, restoreCurrentBook, setCurrentBook } from "../lib/currentBook.js";
import { setOfflineScope } from "../lib/offline/scope.js";
import { readSeenPresentation } from "../lib/spaceTransition.js";
import { Button } from "../components/Button.js";

/** Resolve the account and ledger BEFORE restoring any ledger-scoped query cache. */
export function AccountEntry({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const { user, status } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [readyAccount, setReadyAccount] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const userId = user?.id;

  useEffect(() => {
    if (!user || readyAccount === user.id) return;
    let cancelled = false;
    setFailed(false);

    async function prepare(): Promise<void> {
      // Join main.tsx's startup restore before replacing its device hint with the account preference.
      await restoreCurrentBook();
      let bookId: string | null;
      try {
        const response = await apiFetch<{ books: readonly { id: string }[] }>("/books");
        bookId = entryBookId(user!.lastBookId ?? null, response.books);
      } catch (error) {
        // Offline copies remain usable. Authorization/server failures must not become permission.
        if (error instanceof ApiRequestError && error.status > 0 && error.status < 500) throw error;
        bookId = currentBookId();
      }
      if (cancelled) return;
      setOfflineScope(user!.id, bookId);
      await setCurrentBook(bookId);
      if (cancelled) return;
      const destination = entryPath({
        pathname: location.pathname,
        completed: user!.hasCompletedIntro !== false || readSeenPresentation(user!.id),
        bookId,
      });
      if (destination !== location.pathname) void navigate(destination, { replace: true });
      setReadyAccount(user!.id);
    }

    void prepare().catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
    // A startup decision is per account, not repeated when preferences or tabs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, readyAccount, attempt]);

  if (status === "loading") return <EntryLoading />;
  if (!user) {
    const next = location.pathname.startsWith("/join/")
      ? `/login?next=${encodeURIComponent(location.pathname + location.search)}` : "/login";
    return <Navigate to={next} replace />;
  }
  if (readyAccount !== user.id) {
    if (!failed) return <EntryLoading />;
    return (
      <main className="flex min-h-full flex-col items-center justify-center gap-4 px-6 text-body text-muted">
        <p role="alert">暂时无法载入账本，请稍后重试。</p>
        <Button onClick={() => setAttempt((value) => value + 1)}>重试</Button>
      </main>
    );
  }
  return <>{children}</>;
}

function EntryLoading(): React.JSX.Element {
  return <main role="status" className="flex min-h-full items-center justify-center text-body text-muted">正在载入账本…</main>;
}
