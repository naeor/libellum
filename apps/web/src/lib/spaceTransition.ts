import { useCallback, useEffect, useRef, useState } from "react";

import {
  MAX_SPEED,
  SPRING_DAMPING,
  SPRING_STIFFNESS,
  WHEEL_IDLE_MS,
  WHEEL_SCALE,
  carryVelocity,
  clamp01,
  clampOvershoot,
  claimsGesture,
  decideTarget,
  hasSettled,
  springStep,
  wheelFlick,
} from "./transitionPhysics.js";

/**
 * **The one number the ledger space is built on.**
 *
 * ⚠️ **`0` is the presentation state — the ocean. `1` is the ordinary one — the ledger list.**
 * Everything between is a real position: the sea is genuinely half-way up the screen and the list is
 * genuinely half-arrived. **That is what makes the retreat a retreat rather than two screens
 * swapping**, which the owner ruled out in as many words:
 *
 * > *"不能只是绿色画面渐隐、白色页面渐显，更不要简单把一个完整的新页面从下面推上来覆盖旧页面."*
 *
 * ⚠️ **This is a second user of the physics in `transitionPhysics.ts`, not a copy of it.** The ledger
 * screen's two shapes needed the same spring, the same speed ceiling and the same gesture rules, and
 * **a second implementation would be a second answer to "how fast does a flick count"** — whose
 * symptom is *"this screen feels slightly off"*, the hardest kind of bug to attribute.
 *
 * ⚠️ **The progress is a ref, not state, and it is written to the DOM every frame.** React is told
 * only when the screen settles. A phone fires touch events at 60–120 Hz, and re-rendering a page
 * this often is exactly how a transition starts to stutter.
 */
export interface SpaceTransition {
  /** Attach to the element that carries `--p`. */
  readonly rootRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the scrolling region (the ordinary state's list). */
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  /** True once settled at the ordinary end. React uses it for what only exists there. */
  readonly atList: boolean;
  /** Move to one end without a gesture. */
  readonly goTo: (progress: number) => void;
}

/**
 * ⚠️ **A deeper drag than the ledger screen's.** The sea is a full screen tall and the list has to be
 * pulled up from beyond it; the ledger's summary only shrinks by a few hundred pixels. **Reusing 260
 * would make one gesture cross the whole range and the retreat would read as a jump.**
 */
const SPACE_DRAG = 420;

/**
 * ⚠️ **The storage key prefix for "this account has seen the presentation state".**
 *
 * Prefixed rather than bare, because `localStorage` is shared with everything else on the origin and
 * **a bare key like `"seen"` is how two features come to overwrite each other.**
 */
const PRESENTATION_SEEN_PREFIX = "libellum-presentation-seen";

/**
 * Whether this account has already been shown the presentation state.
 *
 * ⚠️ **Per account, not per device.** Two people share a laptop and a phone; **"has this person seen
 * the welcome" is a fact about the person.** The key carries the id for that reason, and it is the
 * same scoping the offline stores already use.
 *
 * ⚠️ **`localStorage` rather than the server.** This is a preference about a moment, not data: if it
 * is lost the cost is **seeing the welcome once more**, and **a request whose failure mode is a
 * slightly longer welcome is not worth a round trip on the first paint.**
 */
export function readSeenPresentation(userId: string | undefined): boolean {
  if (userId === undefined) return true;
  try {
    return window.localStorage.getItem(`${PRESENTATION_SEEN_PREFIX}:${userId}`) === "1";
  } catch {
    /** ⚠️ Private browsing refuses storage, and **a refused read must not trap somebody in the welcome.** */
    return true;
  }
}

export function markPresentationSeen(userId: string | undefined): void {
  if (userId === undefined) return;
  try {
    window.localStorage.setItem(`${PRESENTATION_SEEN_PREFIX}:${userId}`, "1");
  } catch {
    // Nothing to do: the welcome will simply appear again.
  }
}

export function useSpaceTransition(initial: number): SpaceTransition {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const progress = useRef<number>(initial);
  const velocity = useRef<number>(0);
  /** ⚠️ Typed as the two ends, because every consumer of it is asking "which end". */
  const target = useRef<0 | 1>(initial >= 1 ? 1 : 0);
  const frame = useRef<number | null>(null);
  const lastTick = useRef(0);
  /**
   * ⚠️ **Which spring owns the value.** A frame already dispatched still runs, and a spring mid-step
   * schedules itself again from inside its own callback — **so cancelling a handle and starting a new
   * spring can leave two of them writing progress, one of them towards a target nobody wants.** Every
   * spring carries the number it started with and stops the moment that number is stale.
   */
  const generation = useRef(0);

  const [atList, setAtList] = useState(initial >= 1);

  const paint = useCallback((): void => {
    /**
     * ⚠️ **One DOM write, and deliberately no React state.** Nothing in the middle of an animation may
     * enter React — the ledger screen learned this the hard way, when a `setState` fired mid-flight
     * and showed up as a stall.
     */
    rootRef.current?.style.setProperty("--p", progress.current.toFixed(4));
  }, []);

  const stop = useCallback((): void => {
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  }, []);

  const run = useCallback((): void => {
    stop();
    generation.current += 1;
    const mine = generation.current;
    lastTick.current = performance.now();

    const step = (now: number): void => {
      if (mine !== generation.current) return;

      const elapsed = Math.min((now - lastTick.current) / 1000, 1 / 30);
      lastTick.current = now;

      const stepped = springStep(
        progress.current,
        velocity.current,
        target.current,
        elapsed,
        SPRING_STIFFNESS,
        SPRING_DAMPING,
      );
      const end: 0 | 1 = target.current === 0 ? 0 : 1;
      const clamped = clampOvershoot(stepped.progress, end);
      const hitEnd = clamped !== stepped.progress;

      progress.current = clamped;
      velocity.current = hitEnd ? 0 : stepped.velocity;
      paint();

      if (hasSettled(progress.current, velocity.current, target.current)) {
        progress.current = target.current;
        velocity.current = 0;
        paint();
        setAtList(target.current >= 1);
        frame.current = null;
        return;
      }

      frame.current = window.requestAnimationFrame(step);
    };

    frame.current = window.requestAnimationFrame(step);
  }, [paint, stop]);

  const goTo = useCallback(
    (next: number): void => {
      /**
       * ⚠️ **`goTo` takes a position and snaps to the nearer end, because `target` is one of two
       * values and not a number.** A target of `0.6` would be a state the page cannot display — **the
       * spring would settle half-way through the retreat and stop there, which reads as a bug rather
       * than as a position.** Progress is continuous; the place it heads for is not.
       */
      target.current = next >= 0.5 ? 1 : 0;
      run();
    },
    [run],
  );

  const dragTo = useCallback(
    (next: number): void => {
      generation.current += 1;
      stop();
      progress.current = clamp01(next);
      velocity.current = 0;
      paint();
    },
    [paint, stop],
  );

  const release = useCallback(
    (flick: number): void => {
      target.current = decideTarget(progress.current, flick);
      velocity.current = carryVelocity(flick, target.current, MAX_SPEED);
      run();
    },
    [run],
  );

  useEffect(() => {
    paint();
    return stop;
  }, [paint, stop]);

  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollRef.current;
    if (root === null || scroller === null) return;

    let tracking = false;
    let startY = 0;
    let startTime = 0;
    let startProgress = 0;
    let flick = 0;

    const onStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) return;
      const target = event.target;
      /** ⚠️ A sideways-scrolling strip owns its own gestures entirely. */
      const inStrip = target instanceof Element && target.closest("[data-h-scroll]") !== null;

      tracking = !inStrip;
      startY = event.touches[0]!.clientY;
      startTime = performance.now();
      startProgress = progress.current;
      flick = 0;
      stop();
    };

    const onMove = (event: TouchEvent): void => {
      if (!tracking || event.touches.length !== 1) return;

      const dy = event.touches[0]!.clientY - startY;
      const atTop = scroller.scrollTop <= 0;

      /**
       * ⚠️ **The owner's rule, enforced by `claimsGesture`** — and it is the rule that took him three
       * attempts on the ledger screen: the only gesture claimed in the ordinary state is a *downward*
       * pull at the very top, **the one with nowhere else to go.**
       */
      if (!claimsGesture({ progress: progress.current, atTop, dy })) return;

      const elapsed = performance.now() - startTime;
      if (elapsed > 0) flick = (((dy / elapsed) * 1000) / SPACE_DRAG);

      event.preventDefault();
      /**
       * ⚠️ **Dragging up moves towards the list, so the sign is inverted** — a finger travelling up
       * the screen (negative `dy`) must *increase* progress.
       */
      dragTo(startProgress - dy / SPACE_DRAG);
    };

    const onEnd = (): void => {
      if (!tracking) return;
      tracking = false;
      release(flick);
    };

    /**
     * ⚠️ **`touchmove` is non-passive and the others are not** — only a non-passive listener may call
     * `preventDefault`, and **preventing the browser's own scroll is the whole reason the gesture can
     * drive the transition at all.**
     */
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onEnd);

    let wheelIdle: number | null = null;

    const onWheel = (event: WheelEvent): void => {
      /** ⚠️ Past the top of the list, the pull drives the retreat; anywhere else the list scrolls. */
      if (progress.current >= 1 && scroller.scrollTop > 0) return;

      event.preventDefault();
      dragTo(progress.current + event.deltaY / WHEEL_SCALE);

      if (wheelIdle !== null) window.clearTimeout(wheelIdle);
      wheelIdle = window.setTimeout(() => {
        release(wheelFlick(event.deltaY));
      }, WHEEL_IDLE_MS);
    };

    /**
     * ⚠️ **The wheel is not a nicety.** Without it the page has two states and **no way to reach the
     * second one on a desktop**, where there is no touch to listen for.
     */
    root.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
      root.removeEventListener("wheel", onWheel);
      if (wheelIdle !== null) window.clearTimeout(wheelIdle);
    };
  }, [dragTo, release, stop]);

  return { rootRef, scrollRef, atList, goTo };
}

