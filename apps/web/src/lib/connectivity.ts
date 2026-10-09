import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

/**
 * Whether the browser currently believes it has a network.
 *
 * `navigator.onLine` is not a promise that the server is reachable — it only
 * means there is no obviously dead link. That is the right level for this
 * application: it is used to *warn* the user that what they see may be stale,
 * not to block them from doing anything.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = (): void => {
      setOnline(true);
    };
    const goOffline = (): void => {
      setOnline(false);
    };

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}

/**
 * Go back to wherever the user actually came from.
 *
 * The screens below the tabs are reachable from more than one place — 分类管理
 * is linked from 我的, and the same kind of link could appear in 设置. Sending
 * everyone to one fixed parent means somebody always lands somewhere they did
 * not come from, which reads as a bug even though the data is fine.
 *
 * React Router marks the first entry of the session with the key `"default"`;
 * there is nothing to go back to in that case, so the fallback is used — which
 * matters for a deep link opened directly.
 */
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(() => {
    if (location.key !== "default") {
      void navigate(-1);
      return;
    }

    void navigate(fallback);
  }, [navigate, location.key, fallback]);
}
