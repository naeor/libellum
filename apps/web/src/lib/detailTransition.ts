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

/**
 * Is this the gesture that carries the screen back to its display state?
 *
 * Only when the list is at its very top and the finger is moving down. Any
 * other downward drag is the reader scrolling a list that is already scrolled,
 * and belongs to the browser.
 */
function touchesArePullingDown(startProgress: number, scrollTop: number, dy: number): boolean {
  return startProgress >= 1 && scrollTop <= 0 && dy > 0;
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
    let decided: "none" | "vertical" | "horizontal" = "none";
    let startX = 0;
    let startY = 0;
    let startProgress = 0;
    let lastY = 0;
    let lastTime = 0;
    let flick = 0;

    const onStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) return;

      const touch = event.touches[0]!;

      // A second gesture while the spring is running takes over from wherever
      // it has got to, which is why the current value is read rather than the
      // target.
      tracking = true;
      decided = "none";
      startX = touch.clientX;
      startY = touch.clientY;
      startProgress = progress.current;
      lastY = touch.clientY;
      lastTime = performance.now();
      flick = 0;
      stop();
    };

    const onMove = (event: TouchEvent): void => {
      if (!tracking || event.touches.length !== 1) return;

      const touch = event.touches[0]!;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      /*
       * The reverse pull is claimed immediately, before any threshold.
       *
       * This is the whole difference between the two directions working. At the
       * top of a scrollable list, a downward drag is a gesture the browser also
       * has a claim on — it reads as overscroll. If the first few pixels are
       * left alone while an eight-pixel threshold is measured, the browser
       * takes the gesture, stops delivering touchmove, and the screen sits
       * still until the finger lifts. Which is exactly what the owner saw:
       * nothing moved, then the whole animation played on release.
       *
       * There is no ambiguity to wait for here, so there is nothing to wait
       * for: scrolled to the top and pulling down can only mean one thing.
       */
      if (touchesArePullingDown(startProgress, scroller.scrollTop, dy)) {
        event.preventDefault();
        dragTo(1 - dy / DRAG_DISTANCE);
        return;
      }

      if (decided === "none") {
        // Eight pixels before committing to an axis. Under that, a small
        // wobble decides nothing; over it, the dominant axis owns the gesture
        // — which is what keeps a sideways swipe through the currencies from
        // changing the screen's shape.
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        decided = Math.abs(dy) > Math.abs(dx) ? "vertical" : "horizontal";
      } else if (decided === "horizontal") {
        /*
         * A sideways start does not end the gesture.
         *
         * This used to give up for the rest of the touch, and the owner found
         * the result: starting a drag slightly off-vertical, or pausing
         * half-way and letting the finger drift, killed the transition
         * entirely for that touch. The reverse direction never had the problem
         * because it claims the gesture on the first move, with no axis to
         * decide.
         *
         * So the axis is reconsidered on every move. A gesture that began
         * sideways and turns vertical is still a vertical gesture, and one
         * that turns sideways again simply stops driving the screen.
         */
        if (Math.abs(dy) > Math.abs(dx) + 4) decided = "vertical";
        else return;
      }

      const now = performance.now();
      const elapsed = now - lastTime;

      if (elapsed > 0) {
        flick = (((touch.clientY - lastY) / elapsed) * 1000) / DRAG_DISTANCE;
        lastY = touch.clientY;
        lastTime = now;
      }

      dragTo(startProgress - dy / DRAG_DISTANCE);
      event.preventDefault();
    };

    const onEnd = (): void => {
      if (!tracking) return;
      tracking = false;
      if (decided === "vertical") release(flick);
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
