import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * A width a chart can fall back on when nothing has been measured yet.
 *
 * 320px is the narrowest phone still in use and a realistic render target for
 * a static render (tests, server rendering) where no layout exists.
 */
export const DEFAULT_CHART_WIDTH = 320;

/**
 * Measure an element and keep the measurement current.
 *
 * Charts are drawn at **real pixel coordinates**, not scaled from a fixed
 * `viewBox`. Scaling would keep the drawing proportional but shrink the axis
 * labels with it, which is exactly the wrong trade on a phone: the text is the
 * part that must stay legible.
 *
 * Before the first measurement the default is used, so a chart always renders
 * something sensible — including in tests, where effects never run.
 */
export function useElementWidth<T extends HTMLElement>(
  fallbackWidth: number = DEFAULT_CHART_WIDTH,
): { readonly ref: RefObject<T | null>; readonly width: number } {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallbackWidth);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const measure = (): void => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();

    return () => {
      observer.disconnect();
    };
  }, []);

  return { ref, width };
}
