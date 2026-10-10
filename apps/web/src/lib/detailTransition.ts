import { useCallback, useEffect, useRef, useState } from "react";
import type { TransactionKind } from "@libellum/shared";

/**
 * Where the ledger screen is between its two shapes.
 *
 * `0` is the display state — the tall green summary, the screen a reader lands
 * on. `1` is the list state — a compact bar and the entries filling the page.
 * Everything in between is a real position, not a transition between two
 * finished layouts: the month is genuinely halfway across, the main card is
 * genuinely half its height.
 *
 * The value lives in a **ref**, not React state, and is written to the DOM as a
 * CSS custom property on every frame. That is the whole point: a phone fires
 * scroll and touch events at 60–120 Hz, and re-rendering the ledger that often
 * is how a transition starts to stutter. React is told only when the screen
 * *settles* into one end or the other, which happens twice per gesture.
 */
export interface DetailTransition {
  /** Attach to the element that carries `--p` and the derived variables. */
  readonly rootRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the scrolling region. */
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  /** True once settled at the list end. React may use this for labels. */
  readonly atList: boolean;
  /** Move to one end without a gesture — used by "查看全部" and the back control. */
  readonly goTo: (progress: number) => void;
}

/**
 * State that outlives the screen.
 *
 * Held in a module variable rather than a context so it survives the remount
 * that happens when the reader switches tabs and comes back: they left the
 * ledger showing March, scrolled to the 12th, and that is what they should find
 * on returning. A full reload starts a new module, which resets it to the
 * display state — which is also what the owner asked for.
 */
interface Session {
  progress: number;
  month: string | null;
  kind: TransactionKind | null;
  scrollTop: number;
}

const session: Session = { progress: 0, month: null, kind: null, scrollTop: 0 };

export function readSession(): Readonly<Session> {
  return session;
}

export function writeSession(patch: Partial<Session>): void {
  Object.assign(session, patch);
}

/**
 * How far a finger must travel to carry the transition from one end to the
 * other. Short enough to feel responsive, long enough that the summary shrinks
 * gradually rather than snapping.
 */
const DRAG_DISTANCE = 260;

/** A firm push, so the screen follows the finger rather than lagging behind. */
const SPRING_STIFFNESS = 240;

/**
 * Damped to just under critical.
 *
 * The owner asked for "a very slight bounce, but no visible oscillation" —
 * underdamped enough to overshoot once by a couple of percent, damped enough
 * that it stops there instead of wobbling.
 */
const SPRING_DAMPING = 27;

/** Below this the motion is over; snapping to the exact end avoids a long tail. */
const SETTLED = 0.0015;

/** A flick is enough on its own, without needing to travel half the distance. */
const FLICK_VELOCITY = 0.55;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function useDetailTransition(initial: number): DetailTransition {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const progress = useRef(initial);
  const velocity = useRef(0);
  const target = useRef(initial);
  const frame = useRef<number | null>(null);
  const lastTick = useRef(0);

  const [atList, setAtList] = useState(initial >= 1);

  /** Paint the current value. One DOM write, no React involved. */
  const paint = useCallback((): void => {
    rootRef.current?.style.setProperty("--p", progress.current.toFixed(4));
  }, []);

  const stop = useCallback((): void => {
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  }, []);

  /**
   * The spring.
   *
   * Integrated in real time rather than stepped per frame, so the motion takes
   * the same wall-clock time whether the device draws sixty frames a second or
   * a hundred and twenty.
   */
  const run = useCallback((): void => {
    stop();
    lastTick.current = performance.now();

    const step = (now: number): void => {
      const elapsed = Math.min((now - lastTick.current) / 1000, 1 / 30);
      lastTick.current = now;

      const displacement = target.current - progress.current;
      velocity.current += displacement * SPRING_STIFFNESS * elapsed;
      velocity.current *= Math.exp(-SPRING_DAMPING * elapsed);
      progress.current += velocity.current * elapsed;

      // Overshoot past the end would show a sliver of nothing at either edge.
      if ((target.current === 0 && progress.current < 0) || (target.current === 1 && progress.current > 1)) {
        progress.current = target.current;
        velocity.current = 0;
      }

      paint();

      if (Math.abs(displacement) < SETTLED && Math.abs(velocity.current) < 0.05) {
        progress.current = target.current;
        velocity.current = 0;
        paint();
        setAtList(target.current >= 1);
        writeSession({ progress: target.current });
        frame.current = null;
        return;
      }

      frame.current = window.requestAnimationFrame(step);
    };

    frame.current = window.requestAnimationFrame(step);
  }, [paint, stop]);

  const goTo = useCallback(
    (next: number): void => {
      target.current = clamp01(next);
      run();
    },
    [run],
  );

  /** Follow the finger directly; no spring while it is down. */
  const dragTo = useCallback(
    (next: number): void => {
      stop();
      progress.current = clamp01(next);
      velocity.current = 0;
      paint();
    },
    [paint, stop],
  );

  const release = useCallback(
    (flick: number): void => {
      // A quick flick decides it, otherwise where the finger stopped does.
      const fast = Math.abs(flick) > FLICK_VELOCITY;
      const wantsList = fast ? flick < 0 : progress.current > 0.5;

      target.current = wantsList ? 1 : 0;
      // Carry the finger's speed into the spring, so the snap continues the
      // gesture instead of restarting from a standstill.
      velocity.current = fast ? flick : 0;
      run();
    },
    [run],
  );

  useEffect(() => {
    paint();
    return stop;
  }, [paint, stop]);

  /**
   * The gesture.
   *
   * Attached to the root rather than to a handle, because the whole screen is
   * the handle: at the display end there is nothing to scroll, so an upward
   * drag has exactly one meaning. Touch events rather than pointer events
   * because only touch events can be made non-passive and cancelled when the
   * list is at its top and the reader keeps pulling.
   */
  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollRef.current;
    if (root === null || scroller === null) return;

    let tracking = false;
    let startY = 0;
    let startProgress = 0;
    let lastY = 0;
    let lastTime = 0;
    /**
     * The gesture's speed, smoothed.
     *
     * Taken from one sample it was wrong at the end of a swipe: fingers slow
     * and drift in the last few milliseconds before they lift, so the final
     * delta is often tiny and occasionally points the wrong way. The owner saw
     * the result - the animation reversing briefly in the middle before
     * finishing. A short exponential average keeps the swipe's real direction
     * and discards the wobble at the end.
     */
    let flick = 0;

    /**
     * Which zone the finger landed in decides what the gesture means.
     *
     * The owner proposed this after the axis-detection version failed him three
     * times, and he was right: deciding by direction meant guessing from the
     * first few pixels, getting it wrong, and either killing the transition or
     * blocking an ordinary scroll. Where the finger *starts* is not a guess.
     *
     * A strip that scrolls sideways marks itself `data-h-scroll`; a gesture
     * beginning inside one belongs to it entirely and the screen does not
     * intercept a single event. Anywhere else, the gesture is the screen's.
     */
    const onStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) return;

      const target = event.target;
      const inStrip =
        target instanceof Element && target.closest("[data-h-scroll]") !== null;

      tracking = !inStrip;
      startY = event.touches[0]!.clientY;
      startProgress = progress.current;
      flick = 0;
      stop();
    };

    const onMove = (event: TouchEvent): void => {
      if (!tracking || event.touches.length !== 1) return;

      const dy = event.touches[0]!.clientY - startY;
      const atTop = scroller.scrollTop <= 0;

      /*
       * Past the end of the transition the list belongs to the browser.
       *
       * The only gesture claimed here is a *downward* pull at the very top —
       * the one with nowhere else to go. Everything else is an ordinary
       * scroll, including an upward drag at the top, which is how a reader
       * moves further down a list.
       *
       * The previous version checked "at the top" but not the direction, so an
       * upward drag there was swallowed: prevented from scrolling and driven
       * into a progress that was already at its end. The list jolted and went
       * nowhere.
       */
      if (progress.current >= 1) {
        if (!atTop || dy <= 0) return;

        event.preventDefault();
        dragTo(1 - dy / DRAG_DISTANCE);
        return;
      }

      // At the top of the display state there is nothing above to pull down to.
      if (progress.current <= 0 && dy > 0) return;

      const now = performance.now();
      const elapsed = now - lastTime;
      if (elapsed > 0) {
        const sample = (((event.touches[0]!.clientY - lastY) / elapsed) * 1000) / DRAG_DISTANCE;
        // Weighted towards what has come before, so a single stray sample
        // cannot flip the direction the release will read.
        flick = flick * 0.72 + sample * 0.28;
        lastY = event.touches[0]!.clientY;
        lastTime = now;
      }

      event.preventDefault();
      dragTo(startProgress - dy / DRAG_DISTANCE);
    };

    const onEnd = (): void => {
      if (!tracking) return;
      tracking = false;
      release(flick);
    };

    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onEnd);

    /*
     * The same gesture with a wheel.
     *
     * Not a nicety: without it the screen has two shapes and no way to reach
     * the second one on a desktop, where there is no touch to listen for. The
     * wheel is also the only way I can test the transition myself, since the
     * machine I work on has a mouse.
     *
     * Deltas are accumulated rather than applied per event — a trackpad emits
     * dozens per gesture and a wheel notch is about a hundred pixels, so
     * dividing each event by the full drag distance would jump the whole way in
     * one flick.
     */
    let wheelIdle: number | null = null;

    /**
     * How many wheel pixels carry the transition from one end to the other.
     *
     * Tuned so a few notches move it visibly and one hard flick does not cross
     * the whole range: the wheel should feel like pushing the screen, not like
     * pressing a switch.
     */
    const WHEEL_SCALE = 2400;

    const onWheel = (event: WheelEvent): void => {
      // Only the pull past the top drives the reverse transition; everywhere
      // else the list scrolls normally and this stays out of the way.
      if (progress.current >= 1 && scroller.scrollTop > 0) return;

      event.preventDefault();
      dragTo(progress.current + event.deltaY / WHEEL_SCALE);

      if (wheelIdle !== null) window.clearTimeout(wheelIdle);
      wheelIdle = window.setTimeout(() => {
        release(event.deltaY / 400);
      }, 90);
    };

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

  /**
   * Remember where the reader was, so returning to the tab finds the screen as
   * they left it. Written on the way out rather than on every scroll event.
   */
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;

    const element = scroller;

    return () => {
      writeSession({ scrollTop: element.scrollTop, progress: target.current });
    };
  }, []);

  return { rootRef, scrollRef, atList, goTo };
}
