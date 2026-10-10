import { createContext, useContext } from "react";

import type { OfflineFill } from "./fill.js";

/**
 * The fill's progress, shared with whatever wants to show it.
 *
 * A context rather than calling `useOfflineFill` in two places: the hook **does**
 * work when it mounts, so a second caller would start a second walk over every
 * month. One provider owns the work; everyone else reads it.
 *
 * ⚠️ **`ready` exists so the status line does not need the auth context.**
 *
 * `OfflineStatus` is rendered by `TabPage`, which several screens render — including
 * `AddEntryPage`, whose test builds the smallest possible tree around the real
 * screen. The first version of the status line called `useAuth` and therefore threw
 * "useAuth must be used inside <AuthProvider>" in a test that has nothing to do with
 * authentication.
 *
 * The fix is not to wrap that test in an `AuthProvider` — it is that **a line about
 * storage has no business knowing who is signed in**. The provider, which does need
 * to know, answers the only question the line has: is there anything to say.
 *
 * Outside the provider this stays a default with `fill: null`, and the line says
 * nothing, which is the right answer for a tree with no fill running.
 */
export interface OfflineFillStatus {
  readonly fill: OfflineFill | null;
  /** Whether the fill is owned by a signed-in session. */
  readonly ready: boolean;
}

export const OfflineFillContext = createContext<OfflineFillStatus>({
  fill: null,
  ready: false,
});

export function useOfflineFillStatus(): OfflineFillStatus {
  return useContext(OfflineFillContext);
}
