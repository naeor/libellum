import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Which of the two layouts the ledger screen is showing.
 *
 * `hero` — the tall green financial summary, the state the screen opens in.
 * `list`  — the summary has scrolled away and the entries are the page.
 */
export type DetailMode = "hero" | "list";

/**
 * How long the list must be still before the island expands again.
 *
 * Long enough that the island does not flicker between shapes during a slow
 * drag, short enough that it is back before the user reaches for it.
 */
const SCROLL_IDLE_MS = 260;

/**
 * Follow the list's scroll position, cheaply.
 *
 * Deliberately **not** React state on every scroll event: a phone fires those
 * at 60–120 Hz and re-rendering the ledger that often is how a scroll starts
 * to stutter. The listener writes to refs and calls `setState` only when a
 * value actually changes — twice per gesture for `isScrolling`, once per
 * crossing for the mode.
 *
 * The mode boundary is a **sentinel element** rather than a pixel offset: the
 * summary's height depends on how many currencies are on screen, and measuring
 * a fixed number would be wrong for anyone with more than one.
 */
export function useDetailScroll(
  container: RefObject<HTMLElement | null>,
  sentinel: RefObject<HTMLElement | null>,
): { readonly mode: DetailMode; readonly isScrolling: boolean; readonly expandedByUser: boolean; expand: () => void } {
  const [mode, setMode] = useState<DetailMode>("hero");
  const [isScrolling, setIsScrolling] = useState(false);
  const [expandedByUser, setExpandedByUser] = useState(false);

  const idleTimer = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const scrolling = useRef(false);
  const currentMode = useRef<DetailMode>("hero");

  useEffect(() => {
    const element = container.current;
    if (element === null) return;

    // A little hysteresis either side of the sentinel. Without it, a scroll
    // resting exactly on the boundary flips the whole layout back and forth
    // with every small movement.
    const ENTER_LIST = 8;
    const LEAVE_LIST = 32;

    const measure = (): void => {
      frame.current = null;

      const boundary = sentinel.current?.offsetTop ?? 0;
      const position = element.scrollTop;

      const next: DetailMode =
        currentMode.current === "hero"
          ? position > boundary - ENTER_LIST
            ? "list"
            : "hero"
          : position > boundary - LEAVE_LIST
            ? "list"
            : "hero";

      if (next !== currentMode.current) {
        currentMode.current = next;
        setMode(next);
      }

      if (!scrolling.current) {
        scrolling.current = true;
        setIsScrolling(true);
        // Returning to the top means the user is looking at the summary, so a
        // manual expansion no longer applies.
        if (next === "hero") setExpandedByUser(false);
      }

      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => {
        scrolling.current = false;
        setIsScrolling(false);
      }, SCROLL_IDLE_MS);
    };

    const onScroll = (): void => {
      // Coalesce to one measurement per frame; scroll events can arrive in
      // bursts and only the last position matters.
      if (frame.current === null) frame.current = window.requestAnimationFrame(measure);
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    measure();

    return () => {
      element.removeEventListener("scroll", onScroll);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    };
  }, [container, sentinel]);

  return {
    mode,
    isScrolling,
    expandedByUser,
    expand: () => {
      setExpandedByUser(true);
    },
  };
}

/**
 * Whether the reader has asked for less motion.
 *
 * Honoured so the layout still works without the transitions — every animation
 * here moves something the user needs to see, not decoration for its own sake.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);

    const listener = (event: MediaQueryListEvent): void => {
      setReduced(event.matches);
    };

    query.addEventListener("change", listener);

    return () => {
      query.removeEventListener("change", listener);
    };
  }, []);

  return reduced;
}
