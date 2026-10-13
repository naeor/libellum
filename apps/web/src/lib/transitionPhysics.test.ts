import { describe, expect, it } from "vitest";

import {
  MAX_SPEED,
  carryVelocity,
  clamp01,
  clampOvershoot,
  claimsGesture,
  decideTarget,
  flickFromDrag,
  hasSettled,
  progressFromDrag,
  spaceDragPx,
  limitStep,
  springStep,
  wheelFlick,
} from "./transitionPhysics.js";

/**
 * The two-state transition's decisions, tested.
 *
 * ⚠️ **Every rule here was learned from the owner reporting a jolt, a reversal or a swallowed
 * scroll** — and until this file existed, **all of it lived in comments inside a hook that no test
 * could reach.** A comment cannot fail; these can.
 */
describe("transition physics", () => {
  it("never lets a step exceed the speed ceiling", () => {
    /**
     * ⚠️ **The owner's own fix, and the one that worked after two attempts at blaming the physics.**
     * Whatever the velocity reading says, the value moves at most `MAX_SPEED` per second — **so the
     * whole animation always takes at least half a second, and a stutter cannot happen faster than
     * that.**
     */
    const elapsed = 1 / 60;
    const ceiling = MAX_SPEED * elapsed;

    expect(limitStep(1000, elapsed)).toBeCloseTo(ceiling, 10);
    expect(limitStep(-1000, elapsed)).toBeCloseTo(-ceiling, 10);

    /** Below the ceiling the step is what the velocity says. */
    expect(limitStep(0.3, elapsed)).toBeCloseTo(0.3 * elapsed, 10);
  });

  it("clamps to the two ends and refuses to leave them", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(1.7)).toBe(1);
  });

  it("sends a fast flick to an end even when the finger barely moved", () => {
    /**
     * ⚠️ **A flick outranks position.** A short, fast upward push near the display end must go to the
     * list — otherwise the gesture feels ignored, which is what "unresponsive" means to a person.
     */
    expect(decideTarget(0.1, -0.9)).toBe(1);
    expect(decideTarget(0.9, 0.9)).toBe(0);
  });

  it("lets position decide when the finger was slow", () => {
    /** Past the midpoint it commits; before it, it returns. */
    expect(decideTarget(0.51, 0)).toBe(1);
    expect(decideTarget(0.49, 0)).toBe(0);

    /**
     * ⚠️ **Exactly the middle goes back**, because the comparison is strictly greater. Stated as a
     * test because "halfway" is where a person naturally stops when they change their mind.
     */
    expect(decideTarget(0.5, 0)).toBe(0);
  });

  it("refuses to launch a spring against its own direction", () => {
    /**
     * ⚠️ **The reversal the owner saw in the middle of the animation.** A spring heading for the list
     * (target 1) must not be launched with positive velocity — **that is not a gesture, it is a
     * contradiction, and it shows as a jolt.** A flick pointing the wrong way contributes nothing.
     */
    expect(carryVelocity(0.9, 1)).toBe(0);
    expect(carryVelocity(-0.9, 0)).toBe(0);

    /** Pointing the right way, it is carried — so the snap continues the gesture. */
    expect(carryVelocity(-0.9, 1)).toBeCloseTo(-0.9, 10);
    expect(carryVelocity(0.9, 0)).toBeCloseTo(0.9, 10);
  });

  it("caps even the finger's own speed", () => {
    /**
     * ⚠️ **A hard flick must not outrun the ceiling before the spring takes over** — otherwise the
     * fastest gestures are exactly the ones that stutter.
     */
    expect(carryVelocity(-50, 1)).toBeCloseTo(-MAX_SPEED, 10);
    expect(carryVelocity(50, 0)).toBeCloseTo(MAX_SPEED, 10);
  });

  it("does not carry a slow drag's speed at all", () => {
    /** Below the flick threshold the finger's speed is noise, and position decides instead. */
    expect(carryVelocity(-0.2, 1)).toBe(0);
  });

  it("pulls an overshoot back to the end", () => {
    /** ⚠️ Past the end there is no state, and the sliver of nothing is visible at the edge. */
    expect(clampOvershoot(-0.02, 0)).toBe(0);
    expect(clampOvershoot(1.02, 1)).toBe(1);
    expect(clampOvershoot(0.5, 0)).toBe(0.5);
  });

  it("only settles when it is both close and slow", () => {
    expect(hasSettled(0.9999, 0.01, 1)).toBe(true);
    /**
     * ⚠️ **Close but fast is not settled.** Stopping there is the case that shows as a visible snap —
     * the spring is passing through the target on its way somewhere.
     */
    expect(hasSettled(0.9999, 0.5, 1)).toBe(false);
  });

  it("takes the same wall-clock time regardless of frame rate", () => {
    /**
     * ⚠️ **The spring is integrated in real time, not stepped per frame** — so a 120 Hz device and a
     * 60 Hz one finish together. This is the invariant that makes that true: ten small steps land
     * where five large ones do.
     */
    const coarse = stepTimes(5, 1 / 30);
    const fine = stepTimes(10, 1 / 60);

    expect(fine).toBeCloseTo(coarse, 3);
  });

  it("claims only the downward pull at the top of the list state", () => {
    const listAtTop = { progress: 1, atTop: true };

    /** ⚠️ The gesture with nowhere else to go: pulling down at the very top. */
    expect(claimsGesture({ ...listAtTop, dy: 40 })).toBe(true);

    /**
     * ⚠️ **An upward drag at the top is an ordinary scroll**, and an earlier version swallowed it:
     * "prevented from scrolling and driven into a progress that was already at its end.
     * **The list jolted and went nowhere.**"
     */
    expect(claimsGesture({ ...listAtTop, dy: -40 })).toBe(false);

    /** And anywhere but the top, the list belongs to the browser. */
    expect(claimsGesture({ progress: 1, atTop: false, dy: 40 })).toBe(false);
  });

  it("claims the whole pull while the display state is showing", () => {
    expect(claimsGesture({ progress: 0, atTop: true, dy: -80 })).toBe(true);
    /** ⚠️ At the top of the display state there is nothing above to pull down to. */
    expect(claimsGesture({ progress: 0, atTop: true, dy: 80 })).toBe(false);
  });

  it("scales a wheel's delta before calling it a flick", () => {
    /** ⚠️ A wheel and a finger are on different scales; the divide is what makes them comparable. */
    expect(wheelFlick(400)).toBe(1);
    expect(wheelFlick(-200)).toBe(-0.5);
  });
});

/**
 * The ledger space's own two directions.
 *
 * ⚠️ **These are the parts of `useSpaceTransition` that no test could reach while they lived inside
 * the hook** — and **the sign is the one thing in the whole system that nothing else can check.**
 * Get it backwards and the retreat still runs, still animates, still passes every other test, and
 * **simply moves the wrong way.**
 */
describe("ledger space directions", () => {
  it("moves towards the list when the finger travels up the screen", () => {
    /**
     * ⚠️ **A finger moving up produces a negative `dy`, and that has to *increase* progress.**
     *
     * The ledger screen inverts this the other way round, because its summary is at the top and its
     * list below. **The two screens travel in opposite senses**, which is exactly why this is a named
     * function with a test rather than a minus sign in a handler.
     */
    expect(progressFromDrag(0, -420, 420)).toBe(1);
    expect(progressFromDrag(1, 420, 420)).toBe(0);

    /** Half the distance is half the way. */
    expect(progressFromDrag(0, -210, 420)).toBeCloseTo(0.5, 10);
  });

  it("clamps, so a hard drag cannot leave the two states", () => {
    /** ⚠️ Past either end there is no state — see `clampOvershoot`. */
    expect(progressFromDrag(0.9, -5000, 420)).toBe(1);
    expect(progressFromDrag(0.1, 5000, 420)).toBe(0);
  });

  it("starts from wherever the gesture began, not from zero", () => {
    /** ⚠️ A gesture that starts half-way through must move from there, or the sea jumps on touch. */
    expect(progressFromDrag(0.5, -210, 420)).toBeCloseTo(1, 10);
  });

  it("measures a flick over the whole gesture", () => {
    /** 420px in one second is exactly one drag-distance per second. */
    expect(flickFromDrag(-420, 1000, 420)).toBeCloseTo(-1, 10);

    /** ⚠️ A gesture of no duration contributes no speed rather than an infinity. */
    expect(flickFromDrag(-100, 0, 420)).toBe(0);
  });

  it("scales the gesture with the viewport, not with the device", () => {
    /**
     * ⚠️ **This is the measurement that fixed the feel.** The sea contracts by **59vh**, and the drag
     * distance used to be a flat 420px — on an 844px phone that is **498px of water against 420px of
     * finger**, so the last fifth of the retreat happened with no finger left to follow it.
     *
     * ⚠️ **62vh of finger for 59vh of sea, on every screen**: a phone, an iPad in landscape, a short
     * desktop window. **The same felt effort rather than the same number of pixels.**
     */
    expect(spaceDragPx(844)).toBeCloseTo(523.3, 1);
    expect(spaceDragPx(768)).toBeCloseTo(476.2, 1);

    /** ⚠️ Proportional means the *ratio* is constant, not the distance. */
    expect(spaceDragPx(844) / 844).toBeCloseTo(spaceDragPx(768) / 768, 10);
  });
});

/** Run a spring to its end at a given frame rate and return where it landed. */
function stepTimes(steps: number, elapsed: number): number {
  let progress = 0;
  let velocity = 0;
  for (let i = 0; i < steps; i += 1) {
    const next = springStep(progress, velocity, 1, elapsed);
    progress = next.progress;
    velocity = next.velocity;
  }
  return progress;
}
