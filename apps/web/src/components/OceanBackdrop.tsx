import { useEffect, useRef } from "react";
import { oceanPath } from "../lib/oceanGeometry.js";

const OCEAN_COLORS = ["#3f7059", "#4f8a6d", "#6aa78a", "#96c4ac"] as const;

/** One drawing and one brand, continuously reshaped by the page's progress. */
export function OceanBackdrop(): React.JSX.Element {
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
    <div ref={host} className="space-ocean" aria-hidden="true">
      <svg viewBox="0 0 100 110" preserveAspectRatio="none" className="space-waves">
        {[3, 2, 1, 0].map((layer) => (
          <path key={layer} ref={(node) => { paths.current[layer] = node; }} fill={OCEAN_COLORS[layer]} d={oceanPath(layer, 0, 0)} />
        ))}
      </svg>
      <div className="space-brand">
        <p className="space-brand-name">Libellum</p>
        <p className="space-brand-tagline">记一本账，安静而长久。</p>
      </div>
    </div>
  );
}
