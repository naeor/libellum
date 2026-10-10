import { useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "react-router";

import { recordBackPress } from "./backFallback.js";

/**
 * ⚠️ **`useOnlineStatus` used to live here, and it was deleted rather than kept.**
 *
 * It read `navigator.onLine`, which is a *guess* — and the wrong thing to base a decision on.
 * It says online in a lift, on a train, and on a Wi-Fi network whose router has stopped
 * forwarding; the app therefore waited, failed, and showed nothing while a good copy of the
 * ledger sat on the device.
 *
 * The owner's rule replaced it: **offline when either the browser says so or a request failed
 * to get an answer**, and online again only once the browser agrees *and* a request has
 * succeeded. That lives in `offline/connectivity.ts`, as one shared state, so every screen
 * gives the same answer.
 *
 * **Deleted, not deprecated**: nothing imported it any more, and a second way to ask "are we
 * online" is how two screens come to disagree about the answer.
 */

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
    // Five presses in a row with nothing else touched: the user is stuck
    // rather than navigating, so send them somewhere real instead of letting
    // them bounce between two screens.
    if (recordBackPress()) {
      void navigate("/", { replace: true });
      return;
    }

    if (location.key !== "default") {
      void navigate(-1);
      return;
    }

    void navigate(fallback);
  }, [navigate, location.key, fallback]);
}
