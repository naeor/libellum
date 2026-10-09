/**
 * Escape hatch for a navigation dead end.
 *
 * If someone presses 返回 five times in quick succession without touching
 * anything else, they are not navigating any more — they are stuck. Rather
 * than let them bounce between two screens, the fifth press goes home.
 *
 * Two things keep this from firing on normal use: the presses have to be close
 * together in time, and any press anywhere else on the page resets the count.
 */
const PRESS_WINDOW_MS = 1_500;
const PRESS_THRESHOLD = 5;

let presses = 0;
let lastPressAt = 0;
let listening = false;

function ensureResetListener(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;

  // Capture phase, so it runs before the back button's own handler and can
  // tell the two apart.
  window.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-back-control]") !== null) return;
      presses = 0;
    },
    true,
  );
}

/** @returns true when the user has clearly given up and should be sent home. */
export function recordBackPress(now: number = Date.now()): boolean {
  ensureResetListener();

  presses = now - lastPressAt <= PRESS_WINDOW_MS ? presses + 1 : 1;
  lastPressAt = now;

  if (presses >= PRESS_THRESHOLD) {
    presses = 0;
    return true;
  }

  return false;
}
