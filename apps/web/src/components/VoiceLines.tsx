import { useEffect, useRef } from "react";

import { LINE_COUNT } from "../lib/voiceBars.js";

/**
 * The lines that move while recording.
 *
 * The owner's description: "几条横线……点击之后线就开始跟着动了，用来提示用户现在在
 * 录音状态", with a fold in the middle. What he asked for as a recording indicator
 * is better than that, because the numbers driving it are the real microphone
 * levels — so the lines answer a question a spinner cannot: **is it actually
 * hearing me?** Somebody who sees flat lines knows to speak up or check their
 * microphone before they finish talking and wait for a transcription of silence.
 *
 * Three decisions:
 *
 *  * **A canvas, not five divs.** Five elements animated at 60 fps means five
 *    style recalculation paths per frame on a phone; a canvas is one paint and
 *    does not touch layout at all.
 *  * **The middle line folds, the outer ones stay calm.** That is the shape the
 *    owner described, and it also reads as one responsive object rather than five
 *    separate meters — the weights come from `lineAmplitudes`.
 *  * **Nothing is drawn when the levels are all zero.** At rest the row is five
 *    straight lines, which is what "not recording" should look like.
 *
 * The colour comes from the theme rather than a literal, so the accent-colour work
 * still holds: a second hard-coded green here would be the thing that gets missed
 * the day the theme changes. Read from the document because a canvas cannot use a
 * CSS class, with the theme's own value as the fallback.
 */
export function VoiceLines({
  amplitudes,
  active,
  className = "",
}: {
  readonly amplitudes: readonly number[];
  /** Whether recording. Drives the colour; the shape is driven by the levels. */
  readonly active: boolean;
  readonly className?: string;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef(0);

  /**
   * The newest amplitudes, in a ref.
   *
   * The draw loop is started once and reads this each frame; restarting it per
   * level change would run at the rate React re-renders rather than at the
   * screen's rate, and would leave the animation stuttering exactly when somebody
   * is speaking.
   */
  const levelsRef = useRef(amplitudes);
  levelsRef.current = amplitudes;

  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const context = canvas.getContext("2d");
    if (context === null) return;

    /**
     * The colours come from the theme, read off the document.
     *
     * A canvas cannot use a class, so the values are fetched from the same custom
     * properties everything else uses — there is no second palette to keep in
     * step.
     *
     * ⚠️ **No literal fallback, deliberately**, and the colour guard in
     * `lib/colors.test.ts` is the reason. A `|| "#55997a"` here would be a second
     * definition of the accent colour, and it would be the one somebody forgets
     * the day the theme changes. If the variable is missing the line draws in
     * nothing, which is visible at a glance and points straight at the cause —
     * where a wrong-but-plausible green would look deliberate.
     */
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue("--color-brand").trim();
    const muted = styles.getPropertyValue("--color-line").trim();

    /** Time, so the fold travels instead of standing still. */
    let phase = 0;

    function draw(): void {
      const element = canvasRef.current;
      if (element === null || context === null) return;

      // Backing store matched to the display size and the device's pixel ratio,
      // or the lines are soft on every phone made since 2015.
      const ratio = window.devicePixelRatio || 1;
      const width = element.clientWidth;
      const height = element.clientHeight;

      if (width === 0 || height === 0) {
        frameRef.current = requestAnimationFrame(draw);
        return;
      }

      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
        element.width = Math.round(width * ratio);
        element.height = Math.round(height * ratio);
      }

      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const levels = levelsRef.current;
      const isActive = activeRef.current;
      const spacing = height / (LINE_COUNT + 1);
      const lineWidth = width - 16;
      const left = 8;

      // A slow drift, so the fold is visibly travelling rather than a static
      // squiggle. Not tied to the levels: movement that stops when somebody
      // pauses would look like the recording had stopped.
      phase += 0.05;

      for (let index = 0; index < LINE_COUNT; index += 1) {
        const level = levels[index] ?? 0;
        const centreY = spacing * (index + 1);

        /**
         * The wave's amplitude, with a floor while recording.
         *
         * The floor is what makes the row read as *alive* between words: speech
         * has gaps, and lines that go perfectly flat in a pause look like the
         * microphone dropped out. Two pixels of movement says "still listening".
         */
        const wave = isActive ? 1.5 + level * spacing * 1.15 : 0;

        context.beginPath();
        context.lineWidth = index === Math.floor(LINE_COUNT / 2) ? 2.5 : 1.5;
        context.lineCap = "round";
        context.strokeStyle = isActive ? accent : muted;

        for (let x = 0; x <= lineWidth; x += 3) {
          const progress = x / lineWidth;

          /**
           * Two sine terms rather than one.
           *
           * One sine is a smooth curve and reads as a wave; adding a slower one at
           * a different frequency makes the shape bend unevenly, which is the
           * "弯折" the owner asked for. The window keeps the fold in the middle and
           * the ends flat, so the row still looks like lines rather than a ribbon.
           */
          const fold = Math.sin(progress * Math.PI * 3 + phase + index * 0.7);
          const bend = Math.sin(progress * Math.PI * 1.3 - phase * 0.6) * 0.6;
          const window_ = Math.sin(progress * Math.PI);

          const y = centreY + (fold + bend) * wave * window_;

          if (x === 0) context.moveTo(left + x, y);
          else context.lineTo(left + x, y);
        }

        context.stroke();
      }

      frameRef.current = requestAnimationFrame(draw);
    }

    frameRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frameRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`h-32 w-full ${className}`}
    />
  );
}
