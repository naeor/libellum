/**
 * **The arithmetic behind a two-state screen, as pure functions.**
 *
 * ⚠️ **This file exists because the mechanism had no tests at all.** `useDetailTransition` is the only
 * thing that drives the ledger screen's two shapes, it was tuned over several rounds of the owner
 * reporting jolts and stutters, and **every one of those conclusions lived in a comment and a hook
 * body that no test could reach.**
 *
 * ⚠️ **A hook needs a DOM; the decisions inside it do not.** Pulling them out is what makes the
 * following testable, and each of them was learned the hard way:
 *
 *  * **Which end a released gesture goes to** (`decideTarget`) — and why a flick outranks position.
 *  * **The speed ceiling** (`limitStep`) — the owner's own fix, and the one that finally stopped the
 *    stutter after the physics had been blamed twice.
 *  * **Carrying the finger's speed into the spring** (`carryVelocity`) — and the reversal the owner
 *    saw when that speed pointed against the direction of travel.
 *
 * ⚠️ **The constants are exported with their reasoning attached**, because "why 260" and "why 1/0.5"
 * are exactly the questions a later change asks, and the answers were not obvious.
 */

/** Where the screen is, clamped to the two ends. */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * How far a finger must travel to carry the transition from one end to the other.
 *
 * Short enough to feel responsive, long enough that the summary shrinks gradually rather than
 * snapping.
 */
export const DRAG_DISTANCE = 260;

/** A firm push, so the screen follows the finger rather than lagging behind. */
export const SPRING_STIFFNESS = 240;

/**
 * Damped to just under critical.
 *
 * The owner asked for "a very slight bounce, but no visible oscillation" — underdamped enough to
 * overshoot once by a couple of percent, damped enough that it stops there instead of wobbling.
 */
export const SPRING_DAMPING = 27;

/** Below this the motion is over; snapping to the exact end avoids a long tail. */
export const SETTLED = 0.0015;

/**
 * The screen may not cross from one state to the other in less than this.
 *
 * ⚠️ **The owner's fix, after several rounds of chasing the jolt properly.** Anything the transition
 * does faster than this — a hard flick, a spring launched with the finger's own speed — is where the
 * stutter lives, and **a stutter is far more noticeable than a transition that takes half a second
 * instead of a quarter.**
 *
 * ⚠️ **It is a speed limit rather than a physics fix**: whatever the velocity reading says, the value
 * moves at most this fast, so the whole animation always plays out over at least half a second.
 * **It does not matter which of the earlier causes was responsible, because none of them can act
 * faster than this** — which is why it worked where the two physics attempts did not.
 */
export const MAX_SPEED = 1 / 0.5;

/** A flick is enough on its own, without needing to travel half the distance. */
export const FLICK_VELOCITY = 0.55;

/**
 * Which end a released gesture is heading for.
 *
 * ⚠️ **A quick flick decides it; otherwise where the finger stopped does.** The threshold is the
 * midpoint, so a slow half-drag commits to whichever side of the middle it was released on — **a
 * gesture that ends exactly at the middle goes back**, because the comparison is strictly greater.
 *
 * @param flick the gesture's average speed, in drag-distances per second, positive meaning downward
 */
export function decideTarget(progress: number, flick: number, flickVelocity = FLICK_VELOCITY): 0 | 1 {
  const fast = Math.abs(flick) > flickVelocity;
  const wantsList = fast ? flick < 0 : progress > 0.5;
  return wantsList ? 1 : 0;
}

/**
 * The speed the spring is launched with.
 *
 * ⚠️ **The owner saw the animation reverse briefly in the middle.** Whatever the velocity reading is,
 * a spring heading for one end must not be launched with speed pointing at the other: **that is not a
 * gesture, it is a contradiction, and it shows as a jolt.** A flick that points the wrong way
 * contributes nothing.
 *
 * ⚠️ **Even the finger's own speed is capped**, so a hard flick cannot outrun the limit before the
 * spring has had a chance to take over.
 */
export function carryVelocity(flick: number, target: 0 | 1, maxSpeed = MAX_SPEED): number {
  const heading = target >= 1 ? -1 : 1;
  const fast = Math.abs(flick) > FLICK_VELOCITY;
  const carried = fast && Math.sign(flick) === heading ? flick : 0;
  return Math.max(-maxSpeed, Math.min(maxSpeed, carried));
}

/**
 * One step of the spring's position, with the speed ceiling applied.
 *
 * ⚠️ **The limit is applied to the step rather than to the velocity**, so a reading far above it
 * simply travels at the ceiling instead of being thrown away — **and the end still arrives smoothly.**
 */
export function limitStep(
  velocity: number,
  elapsed: number,
  maxSpeed = MAX_SPEED,
): number {
  const limit = maxSpeed * elapsed;
  const step = velocity * elapsed;
  return step > limit ? limit : step < -limit ? -limit : step;
}

/**
 * Integrate one frame of a damped spring.
 *
 * ⚠️ **Integrated in real time rather than stepped per frame**, so the motion takes the same
 * wall-clock time whether the device draws sixty frames a second or a hundred and twenty.
 */
export function springStep(
  progress: number,
  velocity: number,
  target: number,
  elapsed: number,
  stiffness = SPRING_STIFFNESS,
  damping = SPRING_DAMPING,
): { readonly progress: number; readonly velocity: number } {
  const displacement = target - progress;
  let nextVelocity = velocity + displacement * stiffness * elapsed;
  nextVelocity *= Math.exp(-damping * elapsed);

  const next = progress + limitStep(nextVelocity, elapsed);
  return { progress: next, velocity: nextVelocity };
}

/**
 * Whether the motion is finished.
 *
 * ⚠️ **Both the distance and the speed must be small.** Checking distance alone stops a spring that
 * is passing through the target at speed, which is the case that shows as a visible snap.
 */
export function hasSettled(
  progress: number,
  velocity: number,
  target: number,
  settled = SETTLED,
): boolean {
  return Math.abs(target - progress) < settled && Math.abs(velocity) < 0.05;
}

/**
 * Whether an overshoot past an end should be pulled back.
 *
 * ⚠️ **Overshoot past the end would show a sliver of nothing at either edge** — the state on the
 * other side of the end does not exist.
 */
export function clampOvershoot(progress: number, target: 0 | 1): number {
  if (target === 0 && progress < 0) return 0;
  if (target === 1 && progress > 1) return 1;
  return progress;
}

/**
 * How many wheel pixels carry the transition from one end to the other.
 *
 * ⚠️ **Deltas are accumulated rather than applied per event** — a trackpad emits dozens per gesture
 * and a wheel notch is about a hundred pixels, so **dividing each event by the full drag distance
 * would jump the whole way in one flick.** Tuned so a few notches move it visibly and one hard flick
 * does not cross the whole range: **the wheel should feel like pushing the screen, not like pressing
 * a switch.**
 */
export const WHEEL_SCALE = 2400;

/** How long the wheel must be idle before a release is decided. */
export const WHEEL_IDLE_MS = 90;

/**
 * Where the currency strip switches from wrapping to scrolling.
 *
 * ⚠️ **Late on purpose**: by this point the cards are nearly their final size, so **the row's reflow
 * lands on a layout that has almost stopped changing and reads as nothing at all.**
 */
export const LATE_THRESHOLD = 0.72;

/**
 * The fraction of a wheel gesture that counts as a flick.
 *
 * ⚠️ A wheel's own delta is on a different scale from a finger's, so it is divided down before being
 * handed to `decideTarget`.
 */
export function wheelFlick(deltaY: number): number {
  return deltaY / 400;
}

/**
 * How far a finger must travel on the ledger space, **expressed in vh so it is proportional**.
 *
 * ⚠️ **The unit is the point, and it took a measurement to see it.** The sea contracts from 80vh to
 * 14vh — **a 66vh journey** — while this was a flat `420px`. On an 844px-tall phone that is 557px of
 * water against 420px of finger: **the finger runs out of screen before the sea finishes moving, so
 * the last fifth of the retreat happens with nothing left to follow it.**
 *
 * ⚠️ **A percentage keeps the two in step on every device.** 70vh of finger carries 66vh of sea, on a
 * phone, on an iPad in landscape, and in a short desktop window — **the same felt effort rather than
 * the same number of pixels.** The ledger screen's flat `260` is right *there* because what it moves
 * shrinks by a few hundred pixels regardless of the screen; **this one's travel is itself a share of
 * the viewport, so the gesture has to be measured in the same unit.**
 */
export const SPACE_DRAG_VH = 70;

/** The same distance in pixels, for a viewport of a known height. */
export function spaceDragPx(viewportHeight: number): number {
  return (viewportHeight * SPACE_DRAG_VH) / 100;
}

/**
 * Where a finger is, as progress between the two states.
 *
 * ⚠️ **The sign is inverted, and that inversion is the whole reason this is a function.** On the
 * ledger screen a downward drag *reduces* progress towards the list. Here the list is **above** the
 * presentation state in the order the reader travels, so **a finger moving up the screen (a negative
 * `dy`) has to *increase* progress.** Getting this backwards produces an animation that runs the
 * wrong way while every test still passes — **nothing else in the system knows which way is "up".**
 */
export function progressFromDrag(startProgress: number, dy: number, drag: number): number {
  return clamp01(startProgress - dy / drag);
}

/**
 * The gesture's average speed, in drag-distances per second.
 *
 * ⚠️ **Averaged over the whole touch rather than sampled at the end**, for the reason the ledger
 * screen discovered: **fingers slow and drift in the last few milliseconds before they lift, so the
 * final delta is often tiny and sometimes points the wrong way** — and the spring then reverses
 * briefly before finishing. The average cannot be flipped by that last stray sample.
 */
export function flickFromDrag(dy: number, elapsedMs: number, drag: number): number {
  if (elapsedMs <= 0) return 0;
  return ((dy / elapsedMs) * 1000) / drag;
}

/**
 * Whether a touch gesture that began in the list state belongs to the screen.
 *
 * ⚠️ **The owner's rule, and the reason it is about *where* rather than *which way*.** The version
 * that decided by direction "meant guessing from the first few pixels, getting it wrong, and either
 * killing the transition or blocking an ordinary scroll. **Where the finger starts is not a guess.**"
 *
 * ⚠️ **And the direction still matters inside the list state**: the only gesture claimed there is a
 * *downward* pull at the very top — the one with nowhere else to go. An upward drag at the top is how
 * a reader moves further down a list, and an earlier version swallowed it: **prevented from scrolling
 * and driven into a progress that was already at its end. The list jolted and went nowhere.**
 */
export function claimsGesture(input: {
  readonly progress: number;
  readonly atTop: boolean;
  readonly dy: number;
}): boolean {
  if (input.progress >= 1) return input.atTop && input.dy > 0;
  /** At the top of the display state there is nothing above to pull down to. */
  if (input.progress <= 0 && input.dy > 0) return false;
  return true;
}
