import { useEffect, useRef } from "react";

import {
  advanceRipples,
  rippleProgress,
  type Ripple,
} from "../lib/voiceRipples.js";

/**
 * The recording symbol, and the ripples spreading from it.
 *
 * Replaces a first attempt that drew five horizontal lines whose shape came from
 * two sine waves at different frequencies. The owner's verdict on it was "那五根
 * 线条扭动的很诡异", and the reason is worth keeping: **the movement was invented
 * rather than derived.** Nothing about a sine three widths long says "recording".
 *
 * His replacement, which this draws: a round recording symbol in the middle, a
 * ring appearing around it **every half second**, travelling outwards and fading,
 * with the loudest ripples reaching furthest.
 *
 * What makes that better is not the shape. It is that every number means
 * something — the interval is real time, the reach comes from the microphone
 * level when the ripple was born, and the fade is the ripple's life. A quiet room
 * still pulses, which says "listening"; a loud word throws a ripple further,
 * which says "heard that".
 *
 * **A canvas, not elements.** Three rings animated at 60 fps as DOM nodes means
 * three style recalculation paths per frame on a phone; a canvas is one paint and
 * touches no layout. The ring in the middle is drawn too, so the whole thing
 * scales together with the canvas rather than needing two coordinate systems.
 *
 * The colours come from the theme's custom properties. **No literal fallback**,
 * deliberately: `lib/colors.test.ts` exists to stop a second definition of the
 * accent colour appearing in a component, and that guard caught this very file
 * when the first version had one.
 */
export function VoiceRipples({
  level,
  active,
  className = "",
}: {
  /** The current microphone level, 0–1. Sampled to decide how far a ripple goes. */
  readonly level: number;
  /** Whether recording. When false there are no ripples, just the symbol. */
  readonly active: boolean;
  readonly className?: string;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /** The newest props, read by a draw loop that is started once. */
  const levelRef = useRef(level);
  levelRef.current = level;
  const activeRef = useRef(active);
  activeRef.current = active;

  /**
   * The ripples in flight, and how long since the last one appeared.
   *
   * Held in refs rather than state: they change every frame, and routing that
   * through React would re-render the whole screen sixty times a second to move
   * three circles.
   */
  const ripplesRef = useRef<readonly Ripple[]>([]);
  const sinceLastRef = useRef(0);
  const lastFrameRef = useRef(0);

  /** Kept across frames so a recording that stops and restarts begins clean. */
  const wasActiveRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const context = canvas.getContext("2d");
    if (context === null) return;

    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue("--color-brand").trim();
    const soft = styles.getPropertyValue("--color-brand-soft").trim();
    const onAccent = styles.getPropertyValue("--color-surface").trim();

    let frame = 0;

    function draw(now: number): void {
      const element = canvasRef.current;
      if (element === null || context === null) {
        frame = requestAnimationFrame(draw);
        return;
      }

      const delta = lastFrameRef.current === 0 ? 16 : Math.min(now - lastFrameRef.current, 100);
      lastFrameRef.current = now;

      const isActive = activeRef.current;

      // Stopping clears the ripples, so a second recording does not inherit the
      // first one's rings mid-flight.
      if (!isActive && wasActiveRef.current) {
        ripplesRef.current = [];
        sinceLastRef.current = 0;
      }
      wasActiveRef.current = isActive;

      if (isActive) {
        const next = advanceRipples(ripplesRef.current, delta, sinceLastRef.current, levelRef.current);
        ripplesRef.current = next.ripples;
        sinceLastRef.current = next.sinceLastMs;
      }

      // Backing store matched to the display size and the device pixel ratio, or
      // the rings are soft on every phone made since 2015.
      const ratio = window.devicePixelRatio || 1;
      const width = element.clientWidth;
      const height = element.clientHeight;

      if (width === 0 || height === 0) {
        frame = requestAnimationFrame(draw);
        return;
      }

      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
        element.width = Math.round(width * ratio);
        element.height = Math.round(height * ratio);
      }

      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const centreX = width / 2;
      const centreY = height / 2;
      const symbolRadius = Math.min(width, height) * 0.17;

      /**
       * The rings behind the symbol, oldest first so the newest sits on top.
       *
       * `globalAlpha` for the fade: the ripple's own opacity already carries how
       * far through its life it is, and multiplying that into every stroke colour
       * by hand would mean parsing and rebuilding colour strings each frame.
       */
      for (const ripple of ripplesRef.current) {
        const { spread, opacity } = rippleProgress(ripple);
        const radius = symbolRadius + (ripple.reach - symbolRadius) * spread;

        context.beginPath();
        context.arc(centreX, centreY, radius, 0, Math.PI * 2);
        // Thinner as it travels: a ring that keeps its weight looks like it is
        // being drawn, where one that thins looks like it is dissipating.
        context.lineWidth = 2.5 - 1.5 * spread;
        context.strokeStyle = accent;
        context.globalAlpha = opacity * 0.55;
        context.stroke();
      }

      context.globalAlpha = 1;

      /**
       * The symbol itself.
       *
       * A filled disc with a white ring inside it, which reads as a recording
       * button at any size — the same shape the platform keyboards use, so it
       * needs no label to be understood.
       */
      context.beginPath();
      context.arc(centreX, centreY, symbolRadius, 0, Math.PI * 2);
      context.fillStyle = isActive ? accent : soft;
      context.fill();

      context.beginPath();
      context.arc(centreX, centreY, symbolRadius * 0.52, 0, Math.PI * 2);
      context.strokeStyle = onAccent;
      context.lineWidth = Math.max(2, symbolRadius * 0.16);
      context.stroke();

      frame = requestAnimationFrame(draw);
    }

    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className={`h-40 w-full ${className}`} />;
}
