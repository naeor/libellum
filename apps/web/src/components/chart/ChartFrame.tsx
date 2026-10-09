import { useElementWidth } from "./useElementWidth.js";

export interface ChartPadding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Everything a chart needs to know about the box it is drawing into. */
export interface ChartLayout {
  readonly width: number;
  readonly height: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly padding: ChartPadding;
}

const DEFAULT_PADDING: ChartPadding = { top: 12, right: 12, bottom: 24, left: 40 };

/**
 * The container every chart is drawn inside.
 *
 * It owns three things so no individual chart has to:
 *
 *  * **responsive width** — measured from the parent, so the SVG uses real
 *    pixels and text stays at its designed size on a narrow phone
 *  * **the plot area** — the inner box that axes and series are laid out in
 *  * **the "cannot draw this" branch** — an empty, all-zero or single-category
 *    series gets an explanation where the plot would be, rather than an empty
 *    frame or a misleading flat line
 */
export function ChartFrame({
  height,
  padding,
  title,
  notice,
  children,
}: {
  readonly height: number;
  readonly padding?: Partial<ChartPadding>;
  /** Describes the chart for screen readers; also used as the SVG title. */
  readonly title: string;
  /** When set, this text is shown instead of the plot. */
  readonly notice?: string | null;
  readonly children: (layout: ChartLayout) => React.ReactNode;
}): React.JSX.Element {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const resolved: ChartPadding = { ...DEFAULT_PADDING, ...padding };

  const layout: ChartLayout = {
    width,
    height,
    innerWidth: Math.max(width - resolved.left - resolved.right, 1),
    innerHeight: Math.max(height - resolved.top - resolved.bottom, 1),
    padding: resolved,
  };

  if (notice !== null && notice !== undefined && notice !== "") {
    return (
      <div
        ref={ref}
        style={{ minHeight: height }}
        className="flex items-center justify-center rounded-field bg-canvas px-4 text-center text-xs leading-relaxed text-muted"
      >
        {notice}
      </div>
    );
  }

  return (
    <div ref={ref} className="w-full">
      <svg
        role="img"
        aria-label={title}
        width="100%"
        height={height}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        // The viewBox matches the measured width, so this scales only in the
        // moment between a resize and the next measurement.
        preserveAspectRatio="xMidYMid meet"
      >
        <title>{title}</title>
        {children(layout)}
      </svg>
    </div>
  );
}
