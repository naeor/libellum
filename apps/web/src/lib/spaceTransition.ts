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
  flickFromDrag,
  spaceDragPx,
  hasSettled,
  progressFromDrag,
  springStep,
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
 * ⚠️ **The storage key prefix for "this account has seen the presentation state".**
 *
 * Prefixed rather than bare, because `localStorage` is shared with everything else on the origin and
 * **a bare key like `"seen"` is how two features come to overwrite each other.**
 */
const PRESENTATION_SEEN_PREFIX = "libellum-presentation-seen";

/**
 * Whether this account has already been shown the presentation state.
 *
 * A per-account DEVICE acknowledgement and pending completion retry hint.
 * The authoritative completion flag is now users.has_completed_intro; a missing local key
 * never replays the presentation for an account the server already marked complete.
 */
export function readSeenPresentation(userId: string | undefined): boolean {
  if (userId === undefined) return true;
  try {
    return window.localStorage.getItem(`${PRESENTATION_SEEN_PREFIX}:${userId}`) === "1";
  } catch {
    // Storage refusal is not evidence of completion. The server flag still decides.
    return false;
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
    if (scrollRef.current) {
      scrollRef.current.inert = progress.current <= 0.001;
      scrollRef.current.style.overflowY = progress.current >= 1 ? "auto" : "hidden";
    }
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
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      progress.current = target.current;
      velocity.current = 0;
      paint();
      setAtList(target.current >= 1);
      return;
    }
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
      velocity.current = -carryVelocity(flick, target.current, MAX_SPEED);
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

    /**
     * ⚠️ **Measured from the viewport every time, not captured once.** A phone rotates, a desktop
     * window is resized, and Safari's dynamic viewport changes height as its toolbars slide away —
     * **a distance captured at mount would be the wrong one for the rest of the session.**
     */
    const dragPx = (): number => spaceDragPx(window.innerHeight);

    let wheelIdle: number | null = null;
    let wheelTravel = 0;
    let tracking = false;
    let claimed = false;
    let eligible = false;
    let startY = 0;
    let startX = 0;
    let startTime = 0;
    let startProgress = 0;
    let flick = 0;

    const onStart = (event: TouchEvent): void => {
      if (wheelIdle !== null) { window.clearTimeout(wheelIdle); wheelIdle = null; wheelTravel = 0; }
      if (event.touches.length !== 1) {
        tracking = false;
        if (progress.current > 0 && progress.current < 1) release(0);
        return;
      }
      const element = event.target;
      tracking = !(element instanceof Element && element.closest("input, textarea, select, [data-h-scroll], [role=dialog]"));
      claimed = false;
      // A scroll that starts below the top remains an ordinary scroll throughout.
      eligible = scroller.scrollTop <= 1;
      startY = event.touches[0]!.clientY;
      startX = event.touches[0]!.clientX;
      startTime = performance.now();
      startProgress = progress.current;
      if (tracking && startProgress > 0 && startProgress < 1) stop();
      flick = 0;
    };
    const onMove = (event: TouchEvent): void => {
      if (!tracking || event.touches.length !== 1) return;
      const dy = event.touches[0]!.clientY - startY;
      const dx = event.touches[0]!.clientX - startX;
      if (!claimed) {
        if (Math.max(Math.abs(dy), Math.abs(dx)) < 8) return;
        if (Math.abs(dx) > Math.abs(dy) || !claimsGesture({ progress: startProgress, atTop: eligible, dy })) {
          tracking = false;
          if (progress.current > 0 && progress.current < 1) release(0);
          return;
        }
        claimed = true;
      }
      if (!event.cancelable) { tracking = false; release(flick); return; }
      event.preventDefault();
      flick = flickFromDrag(dy, performance.now() - startTime, dragPx());
      dragTo(progressFromDrag(startProgress, dy, dragPx()));
    };
    const onEnd = (): void => {
      if (tracking && (claimed || (progress.current > 0 && progress.current < 1))) release(flick);
      tracking = false;
      claimed = false;
    };
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onEnd);
    window.addEventListener("resize", onEnd);

    const onWheel = (event: WheelEvent): void => {
      /** ⚠️ Past the top of the list, the pull drives the retreat; anywhere else the list scrolls. */
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (progress.current >= 1 && (scroller.scrollTop > 1 || event.deltaY >= 0)) return;
      if (progress.current <= 0 && event.deltaY <= 0) return;

      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
      wheelTravel += delta;
      dragTo(progress.current + delta / WHEEL_SCALE);

      if (wheelIdle !== null) window.clearTimeout(wheelIdle);
      wheelIdle = window.setTimeout(() => {
        // A deliberate wheel notch commits; tiny trackpad noise returns to rest.
        release(Math.abs(wheelTravel) >= 40 ? -Math.sign(wheelTravel) : 0);
        wheelTravel = 0;
        wheelIdle = null;
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
      window.removeEventListener("resize", onEnd);
      root.removeEventListener("wheel", onWheel);
      if (wheelIdle !== null) window.clearTimeout(wheelIdle);
    };
  }, [dragTo, release, stop]);

  return { rootRef, scrollRef, atList, goTo };
}

