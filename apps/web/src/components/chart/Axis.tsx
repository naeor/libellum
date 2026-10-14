import type { ChartLayout } from "./ChartFrame.js";

const LABEL_SIZE = 10;
/**
 * ⚠️ **Two colours, because these are two jobs.**
 *
 * `RULE_COLOR` draws the grid and the baseline — reference marks that must stay **behind** the data.
 * `AXIS_COLOR` fills the tick and category labels, which are **read** and therefore have to reach AA.
 *
 * ⚠️ **They used to be one constant.** Darkening it for the sake of the labels also darkened the
 * grid, and a 0.22-opacity dark grid reads as *in front of* the bars — so the fix for one job would
 * have damaged the other. **A shared constant is not the same thing as a shared meaning.**
 */
const RULE_COLOR = "var(--color-chart-rule)";
const AXIS_COLOR = "var(--color-accent-ink)";

/**
 * How many labels to skip so they do not collide.
 *
 * Exported because it is arithmetic, not rendering, and the crowding rule is
 * worth testing: a chart with twelve months on a narrow phone must thin its
 * labels rather than overlap them into an unreadable smear.
 */
export function labelStep(
  count: number,
  availableWidth: number,
  labelWidth: number,
): number {
  if (count <= 0) return 1;

  const fits = Math.max(Math.floor(availableWidth / Math.max(labelWidth, 1)), 1);

  return Math.max(Math.ceil(count / fits), 1);
}

/** Horizontal guides and the value scale down the left edge. */
export function YAxis({
  layout,
  ticks,
  scale,
  format,
  grid = true,
}: {
  readonly layout: ChartLayout;
  readonly ticks: readonly number[];
  readonly scale: (value: number) => number;
  readonly format: (value: number) => string;
  readonly grid?: boolean;
}): React.JSX.Element {
  return (
    <g>
      {ticks.map((tick) => {
        const y = scale(tick);

        return (
          <g key={tick}>
            {grid ? (
              <line
                x1={layout.padding.left}
                x2={layout.padding.left + layout.innerWidth}
                y1={y}
                y2={y}
                stroke={RULE_COLOR}
                strokeOpacity={0.22}
                strokeWidth={1}
              />
            ) : null}
            <text
              x={layout.padding.left - 6}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={LABEL_SIZE}
              fill={AXIS_COLOR}
            >
              {format(tick)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Labels along the bottom, thinned to fit.
 *
 * `slotWidth` is the space one label owns; the step is derived from it, so the
 * same chart thins differently on a phone and on a laptop without any chart
 * needing to know which it is on.
 */
export function XAxis({
  layout,
  labels,
  slotWidth,
  y,
  approxLabelWidth = 28,
}: {
  readonly layout: ChartLayout;
  readonly labels: readonly string[];
  readonly slotWidth: number;
  readonly y?: number;
  readonly approxLabelWidth?: number;
}): React.JSX.Element {
  const baseline = y ?? layout.padding.top + layout.innerHeight;
  const step = labelStep(labels.length, slotWidth * labels.length, approxLabelWidth);

  return (
    <g>
      {labels.map((label, index) => {
        if (index % step !== 0) return null;

        const x = layout.padding.left + slotWidth * (index + 0.5);

        return (
          <text
            key={`${label}-${String(index)}`}
            x={x}
            y={baseline + 14}
            textAnchor="middle"
            fontSize={LABEL_SIZE}
            fill={AXIS_COLOR}
          >
            {label}
          </text>
        );
      })}
    </g>
  );
}

/** The baseline a bar or area chart sits on. */
export function Baseline({
  layout,
  y,
}: {
  readonly layout: ChartLayout;
  readonly y: number;
}): React.JSX.Element {
  return (
    <line
      x1={layout.padding.left}
      x2={layout.padding.left + layout.innerWidth}
      y1={y}
      y2={y}
      stroke={RULE_COLOR}
      strokeOpacity={0.5}
      strokeWidth={1}
    />
  );
}
