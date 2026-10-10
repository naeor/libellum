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
  /**
   * The strip that switches between wrapping and scrolling. Handed back so the
   * transition can toggle it directly.
   */
  readonly stripRef: React.RefObject<HTMLDivElement | null>;
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

/**
 * Where the currency strip switches from wrapping to scrolling.
 *
 * Late on purpose: by this point the cards are nearly their final size, so the
 * row's reflow lands on a layout that has almost stopped changing and reads as
 * nothing at all.
 */
const LATE_THRESHOLD = 0.72;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function useDetailTransition(initial: number): DetailTransition {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const progress = useRef(initial);
  const velocity = useRef(0);
  const target = useRef(initial);
  const frame = useRef<number | null>(null);
  const lastTick = useRef(0);

  /**
   * Which animation owns the value.
   *
   * `stop()` cannot be trusted on its own: a frame that has already been
   * dispatched will still run, and a spring that is mid-step will schedule
   * itself again from inside its own callback — so cancelling the handle and
   * then starting a new spring could leave two of them writing progress, one
   * of them to a target nobody wants any more. The owner's friend named this
   * first and it is the most likely cause of a fast flick stepping backwards.
   *
   * Every spring carries the number it was started with and stops the moment
   * that number is no longer current. There is exactly one owner at any time.
   */
  const generation = useRef(0);

  const [atList, setAtList] = useState(initial >= 1);
  const lateState = useRef(initial >= LATE_THRESHOLD);

  /**
   * Paint the current value.
   *
   * One DOM write, and deliberately no React state. The strip used to be
   * switched by a `setState` from here, and the owner's friend found the
   * consequence: it fired exactly as the transition crossed 0.72, which during
   * a fast flick is while the spring is still in the air, and the re-render
   * showed up as a stall or a step backwards. Nothing in the middle of an
   * animation may enter React.
   */
  const paint = useCallback((): void => {
    const value = progress.current;
    rootRef.current?.style.setProperty("--p", value.toFixed(4));

    const crossed = value >= LATE_THRESHOLD;
    if (crossed !== lateState.current) {
      lateState.current = crossed;
      const strip = stripRef.current;
      if (strip !== null) {
        strip.classList.toggle("flex-nowrap", crossed);
        strip.classList.toggle("flex-wrap", !crossed);
      }
    }
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
    generation.current += 1;
    const mine = generation.current;
    lastTick.current = performance.now();

    const step = (now: number): void => {
      // This spring is no longer the owner: a newer gesture took over. It must
      // not write, and above all it must not schedule itself again.
      if (mine !== generation.current) return;

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
      // A gesture takes ownership: whatever spring was running is retired, not
      // merely cancelled.
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
      // A quick flick decides it, otherwise where the finger stopped does.
      const fast = Math.abs(flick) > FLICK_VELOCITY;
      const wantsList = fast ? flick < 0 : progress.current > 0.5;

      target.current = wantsList ? 1 : 0;
      /*
       * Carry the finger's speed into the spring, so the snap continues the
       * gesture instead of restarting from a standstill — but never against the
       * direction the spring is travelling.
       *
       * The owner saw the animation reverse briefly in the middle. Whatever the
       * velocity reading is, a spring heading for one end must not be launched
       * with speed pointing at the other; that is not a gesture, it is a
       * contradiction, and it shows as a jolt.
       */
      const heading = target.current >= 1 ? -1 : 1;
      velocity.current = fast && Math.sign(flick) === heading ? flick : 0;
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
    let startTime = 0;
    let startProgress = 0;

    /**
     * The gesture's speed, taken as an average over the whole touch.
     *
     * The owner proposed this after two attempts at reading a recent sample
     * both failed him, and he was right about why. A recent sample is the
     * noisiest thing available: fingers slow and drift in the last few
     * milliseconds before they lift, so the final delta is often tiny and
     * sometimes points the wrong way — and the spring then reverses briefly
     * before finishing. A one-frame smoothing pass did not fix it because there
     * was only ever a handful of frames to smooth.
     *
     * The average over the gesture cannot do that. It cannot be flipped by the
     * last stray sample, and it means the same thing as the question being
     * asked: how fast did the reader move, on the whole. Where a pause makes it
     * small, the progress the finger reached decides instead.
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
      startTime = performance.now();
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
      const elapsed = now - startTime;
      const moved = event.touches[0]!.clientY - startY;

      if (elapsed > 0) {
        flick = ((moved / elapsed) * 1000) / DRAG_DISTANCE;
      }

      event.preventDefault();
      dragTo(startProgress - moved / DRAG_DISTANCE);
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

  return { rootRef, scrollRef, stripRef, atList, goTo };
}
