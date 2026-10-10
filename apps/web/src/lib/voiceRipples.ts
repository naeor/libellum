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
 * How often a new ripple appears, in milliseconds, **when the room is quiet**.
 *
 * The owner's number, raised from 0.5 s after seeing it: a slower pulse reads as
 * calmer, and the rhythm still says "listening" without competing with the sound.
 */
export const RIPPLE_INTERVAL_MS = 600;

/**
 * The fastest the pulse may go, in milliseconds.
 *
 * The owner's second rule: **音量越大扩散，波纹的时间会越短，最多缩短至 0.2 秒** —
 * louder means the rings come faster as well as travel further, bottoming out at
 * 0.2 s, which he places at a shout ("差不多时很大声说话的时候，大约 100 分贝").
 *
 * So a quiet room ticks every 0.6 s and a shout every 0.2 s. Both ends are his,
 * and both are needed: without a floor, a clipped signal would fire rings so fast
 * they would be a solid blur rather than a pulse.
 */
export const RIPPLE_INTERVAL_MIN_MS = 200;

/**
 * How long one ripple lives, as a multiple of its own interval.
 *
 * Tied to the interval rather than fixed, and that is the whole point: a shout
 * produces rings three times as often, and with a fixed life they would pile up
 * until the display was a grey disc. Scaling the life keeps **about three rings
 * in flight** whatever the pace — which is what makes it read as a series
 * travelling outwards rather than as a pulse or a haze.
 */
export const RIPPLE_LIFE_INTERVALS = 2.5;

/**
 * How loud a full-scale signal is taken to be, in decibels.
 *
 * The owner described his ceiling as "大约 100 分贝" for very loud speech. It is a
 * rough anchor rather than a measurement — nothing here is calibrated, and a
 * phone microphone's absolute level depends on its gain, its position and the
 * room — but it gives the mapping a floor and a ceiling that match how he
 * described the two ends, which is what the display is for.
 */
export const RIPPLE_LOUD_DB = 100;

/**
 * How long a ripple thrown by this level waits before the next one.
 *
 * Loud means quick, quiet means slow, linearly between the owner's two numbers.
 * Linear rather than eased: he described a range with two ends, and the ear is
 * already doing the perceptual work here — the reach is where the square root
 * belongs, because that is the one being read as "how far did that go".
 */
export function intervalForLevel(level: number): number {
  const decibels = Math.max(0, Math.min(1, level)) * RIPPLE_LOUD_DB;
  const proportion = decibels / RIPPLE_LOUD_DB;

  return RIPPLE_INTERVAL_MS - (RIPPLE_INTERVAL_MS - RIPPLE_INTERVAL_MIN_MS) * proportion;
}

/** How long a ripple born at this pace lives. */
export function lifeForInterval(intervalMs: number): number {
  return intervalMs * RIPPLE_LIFE_INTERVALS;
}

/** The radius a ripple reaches when it dies, for a **quiet** sound. */
export const RIPPLE_MIN_REACH = 26;

/** The radius a ripple reaches when it dies, for the loudest sound. */
export const RIPPLE_MAX_REACH = 92;

export interface Ripple {
  /** Milliseconds since it was born. */
  readonly ageMs: number;
  /** Where it will have got to by the end of its life. */
  readonly reach: number;
  /** How long this one lives — shorter for a loud one, so the pace can rise. */
  readonly lifeMs: number;
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
  const interval = intervalForLevel(level);
  const life = lifeForInterval(interval);
  const reach = reachForLevel(level);

  const aged = ripples
    .map((ripple) => ({ ...ripple, ageMs: ripple.ageMs + elapsedMs }))
    // Each ripple is measured against **its own** life, not a global one: a
    // ripple born during a shout lives a shorter time, which is what lets the
    // pace rise without the display filling up.
    .filter((ripple) => ripple.ageMs < ripple.lifeMs);

  let since = sinceLastMs + elapsedMs;
  const born: Ripple[] = [];

  /**
   * The interval is recomputed from the level each time round the loop, which is
   * what makes the pulse *speed up* while somebody is talking rather than
   * switching pace only at the next ring. Cheap — it is arithmetic on one number
   * — and it means a shout is answered immediately.
   *
   * The age of a ripple born mid-frame comes from how long ago it fell due, so a
   * long frame produces a travelling series rather than a stack.
   */
  let guard = 0;

  while (since >= interval && guard < 64) {
    since -= interval;
    born.unshift({ ageMs: since, reach, lifeMs: life });
    guard += 1;
  }

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
  const life = Math.max(0, Math.min(1, ripple.ageMs / ripple.lifeMs));

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
