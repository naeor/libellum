import { useEffect, useRef } from "react";
import { oceanPath } from "../lib/oceanGeometry.js";

const OCEAN_COLORS = ["#3f7059", "#4f8a6d", "#6aa78a", "#96c4ac"] as const;

/**
 * One drawing and one brand, continuously reshaped by the page's progress.
 *
 * ⚠️ **`children` are laid out in the ocean's own coordinate space, and that is the point.** The
 * account avatar has to line up with the wordmark's centre line — *"纵轴方向上跟左边的 logo 对齐"* — and
 * the wordmark is positioned here with an interpolation between the two states (`.space-brand` in
 * `index.css`). **Anything placed in this same box can use the same expression**, so the alignment
 * holds at every point of the drag instead of only at the two ends.
 *
 * ⚠️ **⚠️ The wrapper is `aria-hidden` and `pointer-events: none` — unless `interactive`.**
 * Both were right while this was a pure drawing: it must not swallow taps meant for the list, and it
 * has nothing to announce. **Putting a real button inside it made both of those wrong**, and neither
 * fails loudly: `aria-hidden` would hide the account button from every screen reader, and
 * `pointer-events: none` would leave it untappable **while still looking perfectly normal.** So the
 * flag is explicit, and the caller has to ask for it.
 */
export function OceanBackdrop({
  interactive = false,
  children,
}: {
  readonly interactive?: boolean;
  readonly children?: React.ReactNode;
} = {}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const paths = useRef<(SVGPathElement | null)[]>([]);
  useEffect(() => {
    const root = host.current?.closest<HTMLElement>(".ledger-space");
    if (!root) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let elapsed = 0;
    let previous = performance.now();
    const draw = (): void => {
      const p = Number(root.style.getPropertyValue("--p")) || 0;
      paths.current.forEach((path, layer) => path?.setAttribute("d", oceanPath(layer, p, elapsed)));
    };
    const tick = (now: number): void => {
      elapsed += Math.min(now - previous, 50) / 1000;
      previous = now;
      draw();
      frame = requestAnimationFrame(tick);
    };
    const resume = (): void => {
      cancelAnimationFrame(frame);
      draw();
      previous = performance.now();
      if (!document.hidden && !reduced.matches) frame = requestAnimationFrame(tick);
    };
    // Reduced motion still follows dragging, but has no ambient animation.
    const observer = new MutationObserver(() => { if (reduced.matches) draw(); });
    observer.observe(root, { attributes: true, attributeFilter: ["style"] });
    document.addEventListener("visibilitychange", resume);
    reduced.addEventListener("change", resume);
    resume();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", resume);
      reduced.removeEventListener("change", resume);
    };
  }, []);
  return (
    <div
      ref={host}
      className={`space-ocean${interactive ? " space-ocean-live" : ""}`}
      {...(interactive ? {} : { "aria-hidden": true })}
    >
      <svg viewBox="0 0 100 110" preserveAspectRatio="none" className="space-waves">
        {[3, 2, 1, 0].map((layer) => (
          <path key={layer} ref={(node) => { paths.current[layer] = node; }} fill={OCEAN_COLORS[layer]} d={oceanPath(layer, 0, 0)} />
        ))}
      </svg>
      <div className="space-brand">
        <p className="space-brand-name">Libevra</p>
        <p className="space-brand-tagline">记一本账，安静而长久。</p>
      </div>
      {children}
    </div>
  );
}
