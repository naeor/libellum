/**
 * The ripples that spread out while recording.
 *
 * The owner's design, after rejecting the first attempt: "给中间放一个圆形的录音
 * 符号，然后在录音的时候，录音符号周围会每隔 0.5 秒出现圆形音波向外并逐渐消失，声音
 * 越大，当时出现的音波传的就越远."
 *
 * The first attempt drew a few horizontal lines whose shape came from two sine
 * waves at different frequencies. His verdict was blunt and correct — "那五根线条
 * 扭动的很诡异" — and the reason is worth keeping: the movement was invented rather
 * than derived. Nothing about a sine at 3× the width says "recording"; it was
 * decoration wearing the costume of a visualisation.
 *
 * What makes this version different is that **every number means something**:
 *
 *  * the **interval** is real time (500 ms), so the rhythm is a clock;
 *  * the **reach** of a ripple comes from the microphone level at the moment it
 *    was born, so a loud word throws a ripple further than a quiet one;
 *  * the **fade** is the ripple's life, so a ripple that has stopped is gone.
 *
 * Kept away from the canvas so the timing and the mapping can be tested, which
 * the previous version taught is worth doing: a visual that only exists inside a
 * draw call can only be judged by looking at it.
 */

/**
 * How often a new ripple appears, in milliseconds.
 *
 * The owner's number. Worth keeping rather than tuning: at 500 ms a ripple is
 * born twice a second, which reads as a steady pulse, and the rhythm itself
 * carries the message that recording is live even when the room is silent.
 */
export const RIPPLE_INTERVAL_MS = 500;

/**
 * How long one ripple lives, in milliseconds.
 *
 * Three intervals, so there are always about three on screen — enough for the
 * eye to read them as a series travelling outwards rather than as separate
 * blinks. Fewer and it pulses; many more and it becomes a haze.
 */
export const RIPPLE_LIFE_MS = 1_500;

/** The radius a ripple reaches when it dies, for a **quiet** sound. */
export const RIPPLE_MIN_REACH = 26;

/** The radius a ripple reaches when it dies, for the loudest sound. */
export const RIPPLE_MAX_REACH = 92;

export interface Ripple {
  /** Milliseconds since it was born. */
  readonly ageMs: number;
  /** Where it will have got to by the end of its life. */
  readonly reach: number;
}

/**
 * How far a ripple thrown by this level will travel.
 *
 * The owner's rule in one line: **louder means further**. The square root is
 * there because loudness is not linear in perception — a level of 0.25 is
 * already "somebody talking" and should not produce a ripple a quarter of the
 * way out, which would make ordinary speech look like a whisper.
 */
export function reachForLevel(level: number, min = RIPPLE_MIN_REACH, max = RIPPLE_MAX_REACH): number {
  const clamped = Math.max(0, Math.min(1, level));
  const lifted = Math.sqrt(clamped);

  return min + (max - min) * lifted;
}

/**
 * Advance the ripples by `elapsedMs`, adding any whose moment has come.
 *
 * One function rather than a `setInterval` plus a list, because the two have to
 * agree: a timer that keeps firing while the animation is paused, or a ripple
 * added without a matching birth time, is how a pulse ends up out of step with
 * the sound.
 *
 * Returns a **new array**, so a caller holding the previous frame's list is not
 * surprised by it changing underneath — and so the function has no hidden state
 * to test around.
 *
 * `sinceLastMs` is the time since the previous ripple was born, carried between
 * frames by the caller. Growing it can cross **more than one** interval — a
 * dropped frame, a backgrounded tab, a phone under load — and the code handles
 * that rather than losing a beat.
 *
 * ⚠️ **A ripple is given the age it really has, not zero.**
 *
 * The first version stamped every new ripple as born *now*, whatever interval it
 * belonged to, so a frame that spanned three intervals produced three ripples in
 * the same place. The difference is invisible in one frame and obvious over a
 * second, which is the kind of bug a test finds and an eye excuses.
 *
 * ⚠️ **`level` is the peak since the last call, not an instant.** A frame
 * boundary has nothing to do with when somebody spoke: sampling the level at the
 * moment a ripple happens to be born would miss the syllable that earned it. The
 * caller accumulates the peak between frames, and a burst of speech inside one
 * interval throws a ripple as far as its loudest moment deserves.
 *
 * The one approximation left, stated rather than hidden: when a single frame
 * spans several intervals they all take that frame's peak. At sixty frames a
 * second that is at most sixteen milliseconds of blur, and paying for better
 * would mean sampling on a timer of its own.
 */
export function advanceRipples(
  ripples: readonly Ripple[],
  elapsedMs: number,
  sinceLastMs: number,
  level: number,
): { readonly ripples: readonly Ripple[]; readonly sinceLastMs: number } {
  const aged = ripples
    .map((ripple) => ({ ...ripple, ageMs: ripple.ageMs + elapsedMs }))
    .filter((ripple) => ripple.ageMs < RIPPLE_LIFE_MS);

  let since = sinceLastMs + elapsedMs;
  const count = Math.floor(since / RIPPLE_INTERVAL_MS);
  since -= count * RIPPLE_INTERVAL_MS;

  /**
   * The ripples that came due, oldest first and one interval apart.
   *
   * `since` is the leftover time to the *next* one, so after `count` intervals the
   * oldest is `since + (count - 1) · interval` old and the newest is `since` old.
   * Spacing them by whole intervals is what makes a long frame produce a
   * travelling series rather than a stack — and in the ordinary case of one birth
   * per frame this is a single ripple whose age is the leftover time.
   */
  const reach = reachForLevel(level);
  const born: Ripple[] = Array.from({ length: count }, (_, index) => ({
    ageMs: since + (count - 1 - index) * RIPPLE_INTERVAL_MS,
    reach,
  }));

  return { ripples: [...aged, ...born], sinceLastMs: since };
}

/**
 * How far out a ripple is, as a fraction of its own reach, and how visible.
 *
 * `0` at birth, `1` when it dies. **Eased out** rather than linear: a ripple that
 * expands at a constant rate looks like a mechanical animation, where one that
 * leaves quickly and slows down looks like something spreading. This is the one
 * piece of craft in the file, and it is a single exponent rather than a curve
 * library.
 *
 * The fade is deliberately not the same as the growth: it stays near full
 * opacity for the first half of the life and then goes, so the ripple is a
 * visible ring for as long as possible instead of a grey smudge for most of it.
 */
export function rippleProgress(ripple: Ripple): { readonly spread: number; readonly opacity: number } {
  const life = Math.max(0, Math.min(1, ripple.ageMs / RIPPLE_LIFE_MS));

  return {
    spread: 1 - (1 - life) ** 2,
    opacity: life < 0.5 ? 1 : 1 - (life - 0.5) / 0.5,
  };
}

/**
 * Seconds left before the recording stops itself.
 *
 * The owner's thirty-second limit, shown counting down. Enforced by the recorder
 * rather than checked afterwards: a recording refused for being too long has
 * already wasted the thirty seconds it took to make.
 */
export function secondsLeft(elapsedMs: number, limitSeconds: number): number {
  return Math.max(0, limitSeconds - Math.floor(elapsedMs / 1000));
}
