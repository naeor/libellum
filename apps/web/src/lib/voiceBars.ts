/**
 * Turning microphone levels into the amplitudes of a few drawn lines.
 *
 * Kept away from the canvas and the microphone so it can be tested, and so the
 * drawing code has nothing to decide. The owner's description of what he wanted
 * was visual — "几条横线……点击之后线就开始跟着动了，用来提示用户现在在录音状态" —
 * and the useful part of that is not decoration: **lines that move with the voice
 * answer the question "is the microphone actually hearing me?"**, which a
 * spinner cannot.
 *
 * A note on what is *not* done here: the levels are not normalised against a
 * running maximum. Auto-scaling makes a quiet room look as loud as a shout, which
 * is exactly the feedback somebody needs to distrust. A fixed scale means a
 * whisper draws small lines and a loud sentence draws tall ones.
 */

/**
 * How many lines.
 *
 * Five, because the owner asked for "几条" and because on a phone a line needs a
 * few pixels of movement to read as movement. More lines than this and each one
 * has too little room to say anything.
 */
export const LINE_COUNT = 5;

/**
 * Where a line sits between silence and a shout, after the mapping.
 *
 * Returns roughly `0`–`1` per line, with the middle lines responding most.
 *
 * **The shape is a curve, not a switch.** A linear map of loudness spends most of
 * its range on the loudest part of speech, so ordinary talking leaves the lines
 * nearly still and the display looks broken — which is the failure mode this
 * whole feature exists to avoid.
 *
 * **The middle moves more than the edges**, which is what makes the row read as a
 * single responsive object rather than five independent meters: the outer lines
 * are the calm edges of the shape and the centre carries the variation. It is
 * also what the owner described — "中间出现弯折".
 */
export function lineAmplitudes(
  levels: readonly number[],
  sensitivity = 0.75,
): readonly number[] {
  return Array.from({ length: LINE_COUNT }, (_, index) => {
    const level = levels[index] ?? 0;

    // Square root rather than a straight multiply: it lifts the quiet end of the
    // range, which is where speech spends most of its time.
    const lifted = Math.sqrt(Math.max(0, Math.min(1, level)));

    // A bell across the row: 0.55 at the edges, 1 at the centre. Enough
    // difference to read as a shape, not so much that the outer lines vanish.
    const distanceFromCentre = Math.abs(index - (LINE_COUNT - 1) / 2) / ((LINE_COUNT - 1) / 2);
    const weight = 1 - 0.45 * distanceFromCentre ** 2;

    return Math.min(1, lifted * weight * (sensitivity * 1.6));
  });
}

/**
 * How much of the frequency data one line represents.
 *
 * The band is chosen rather than averaged across the whole spectrum, because
 * whisper is listening to a voice and a voice lives in the lower bands. A line
 * driven by the top of the spectrum would sit still while somebody talks and
 * twitch at a door closing.
 *
 * Speech energy sits roughly from 85 Hz to 8 kHz of what a phone microphone
 * captures; taking the lower two-thirds of the analyser's range is a crude
 * version of that, and crude is honest here — the alternative is a filter bank,
 * for a decoration.
 */
export function bandLevels(spectrum: Uint8Array, lineCount = LINE_COUNT): readonly number[] {
  if (spectrum.length === 0) return [];

  const usable = Math.floor(spectrum.length * 0.66);

  return Array.from({ length: lineCount }, (_, index) => {
    const start = Math.floor((usable / lineCount) * index);
    const end = Math.max(start + 1, Math.floor((usable / lineCount) * (index + 1)));

    let peak = 0;
    for (let position = start; position < end && position < spectrum.length; position += 1) {
      peak = Math.max(peak, spectrum[position] ?? 0);
    }

    // The analyser hands back 0–255 bytes.
    return peak / 255;
  });
}

/**
 * Seconds left before the recording stops itself.
 *
 * The owner's limit, and it is enforced by the recorder rather than by a check
 * afterwards: a recording that is refused for being too long has already wasted
 * the thirty seconds it took to make.
 */
export function secondsLeft(elapsedMs: number, limitSeconds: number): number {
  return Math.max(0, limitSeconds - Math.floor(elapsedMs / 1000));
}
