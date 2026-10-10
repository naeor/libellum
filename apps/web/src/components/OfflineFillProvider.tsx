import { useMemo } from "react";

import { useAuth } from "../auth/AuthProvider.js";
import { useOfflineFill } from "../lib/offline/fill.js";
import { OfflineFillContext, type OfflineFillStatus } from "../lib/offline/fillContext.js";

/**
 * Starts the offline fill, once, for the whole app.
 *
 * ⚠️ **Mounted once, at the root, and that is the point.** The first version put
 * the fill inside the status line, which renders on every tab — so switching tabs
 * re-ran the effect and walked the month loop again. Every month was already
 * cached by then and skipped, so it was not a duplicate download; it was sixty
 * cache lookups and sixty state updates each time somebody changed screen, for
 * nothing. The work belongs somewhere that runs once.
 *
 * Nothing is rendered: this is a place to put an effect, and a component is how
 * React offers one. What it produces is shared through context, so the visible
 * status line can say what is happening without starting it again.
 */
export function OfflineFillProvider({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const { user } = useAuth();
  const fill = useOfflineFill({ enabled: user !== null });

  /**
   * `ready` follows the session, and the fill is only shared once there is one.
   *
   * The status line gets a single answer — "is there anything to say" — instead of
   * needing the auth context itself. See `fillContext.ts` for why that matters: a
   * line about storage should not be able to fail because nobody wrapped it in an
   * `AuthProvider`.
   */
  const value = useMemo<OfflineFillStatus>(
    () => ({ fill: user === null ? null : fill, ready: user !== null }),
    [fill, user],
  );

  return <OfflineFillContext.Provider value={value}>{children}</OfflineFillContext.Provider>;
}
