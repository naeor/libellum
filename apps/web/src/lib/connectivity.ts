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
 *
 * ⚠️ **⚠️ `location.state.from` wins over history, and the owner reported the bug that proves why**
 * (2026-10-13):
 *
 * > *"点击关于 libellum 时会出现那个经典的老 bug：从关于退出会进到设置，从设置退出又会回到关于界面."*
 *
 * ⚠️ **The bounce is a history loop, and it is not a mistake in any one screen.** 关于's `backTo` is
 * `/settings`; 设置 is reached from 我的. So 我的 → 设置 → 关于 → *back* goes to 设置, and 设置's own back
 * goes to 我的… **but when 关于 is opened from a *third* place, the two screens point at each other and
 * pressing back walks a circle.** The start page's footer was exactly that third place, and the owner
 * asked for it explicitly: *"从开始界面直接进入关于界面时，点击返回是返回开始界面."*
 *
 * ⚠️ **Why the origin has to be declared rather than inferred.** History knows *where you were*, not
 * *where you meant to return to* — for a screen reachable from several places, those are different
 * questions. `state.from` is the caller answering the second one, **and it is what makes 关于's back
 * deterministic instead of a function of how the reader arrived.**
 *
 * ⚠️ **Plain `navigate` here, not `navigate(-1)` and not `replace`.** Going back to a declared parent
 * is a real move: it should be a history entry, and the reader can then go forward again. Replacing
 * would erase the screen they came from.
 */
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate();
  const location = useLocation();

  /** ⚠️ Read defensively: this state is set by callers, and an untyped `unknown` must not crash a screen. */
  const declared = (location.state as { from?: unknown } | null)?.from;
  const from = typeof declared === "string" ? declared : null;

  return useCallback(() => {
    // Five presses in a row with nothing else touched: the user is stuck
    // rather than navigating, so send them somewhere real instead of letting
    // them bounce between two screens.
    if (recordBackPress()) {
      void navigate("/", { replace: true });
      return;
    }

    /**
      * ⚠️ **A declared origin is used before history**, because the reader has already told us where
      * this screen was opened from — see the note above about the 关于/设置 loop.
      */
    if (from !== null) {
      void navigate(from);
      return;
    }

    if (location.key !== "default") {
      void navigate(-1);
      return;
    }

    void navigate(fallback);
  }, [navigate, location.key, fallback, from]);
}
