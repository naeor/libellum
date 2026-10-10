/**
 * Escape hatch for a navigation dead end.
 *
 * If someone presses 返回 several times in quick succession without touching anything else,
 * they are not navigating any more — they are stuck. Rather than let them bounce between two
 * screens, the last press goes home.
 *
 * ⚠️ **The owner hit exactly that and reported the number**: "现在只要在10秒内连续点击4次退出，
 * 就可以退出到最开始的明细界面."
 *
 * **Ten seconds and four presses, and the old constants were neither.** The window was five
 * seconds and the threshold five — so his four presses inside ten seconds counted as **one**,
 * because a pause of more than five seconds reset the run, and the escape hatch never fired.
 * What he was left with was the bouncing it exists to prevent.
 *
 * The window is now ten seconds, because **the target is a moving one on a phone**: a thumb
 * aiming at a back control misses, and the misses are the pauses. Counting them as "the user
 * has calmed down" was the mistake — **somebody stuck presses again, and the gap between two
 * determined presses is longer than five seconds.**
 */
const PRESS_WINDOW_MS = 10_000;
const PRESS_THRESHOLD = 4;

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
