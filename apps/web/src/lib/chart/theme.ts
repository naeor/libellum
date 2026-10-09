/**
 * Colours and markers for charts.
 *
 * Two rules, both from the accessibility requirement:
 *  * **the palette is low-saturation**, matching the rest of the application —
 *    these are family accounts, not a trading terminal
 *  * **colour is never the only signal** — every series also gets a marker
 *    shape, so a legend and a chart stay readable for someone who cannot
 *    separate the hues, or is looking at a washed-out screen in daylight.
 */

/** Eight hues, ordered so neighbouring entries differ in both hue and lightness. */
export const CATEGORICAL_COLORS: readonly string[] = [
  "#55997a",
  "#4a7fb5",
  "#c08a3e",
  "#b8574f",
  "#7a6bb0",
  "#5d8c8c",
  "#8a8f5c",
  "#a86f9a",
];

export function categoricalColor(index: number): string {
  const size = CATEGORICAL_COLORS.length;
  // Negative indices are a caller bug, but wrapping is friendlier than
  // undefined and keeps a chart drawing instead of vanishing.
  const safe = ((index % size) + size) % size;

  return CATEGORICAL_COLORS[safe] ?? CATEGORICAL_COLORS[0]!;
}

/**
 * Heat ramp for the calendar, lightest first.
 *
 * Index 0 means "nothing recorded" and is a neutral grey rather than the
 * lightest green — an empty day and a very cheap day are different facts and
 * should not look the same.
 */
export const HEAT_COLORS: readonly string[] = [
  "#eef1ef",
  "#d7e8dd",
  "#a9d0ba",
  "#79b596",
  "#4b8a6d",
];

export function heatColor(level: number): string {
  const clamped = Math.min(Math.max(Math.trunc(level), 0), HEAT_COLORS.length - 1);

  return HEAT_COLORS[clamped] ?? HEAT_COLORS[0]!;
}

export type MarkerShape = "circle" | "square" | "triangle" | "diamond";

const MARKER_SHAPES: readonly MarkerShape[] = ["circle", "square", "triangle", "diamond"];

export function markerShape(index: number): MarkerShape {
  const size = MARKER_SHAPES.length;
  const safe = ((index % size) + size) % size;

  return MARKER_SHAPES[safe] ?? "circle";
}

/**
 * Points of a marker shape, centred on the origin at a given radius.
 *
 * A circle is drawn with `<circle>`; the rest are polygons whose points come
 * from here, so a legend and a chart marker are guaranteed to match.
 */
export function markerPoints(shape: MarkerShape, radius: number): string {
  switch (shape) {
    case "square":
      return [
        [-radius, -radius],
        [radius, -radius],
        [radius, radius],
        [-radius, radius],
      ]
        .map(([x, y]) => `${String(x)},${String(y)}`)
        .join(" ");

    case "triangle":
      return [
        [0, -radius * 1.15],
        [radius, radius * 0.85],
        [-radius, radius * 0.85],
      ]
        .map(([x, y]) => `${String(x)},${String(y)}`)
        .join(" ");

    case "diamond":
      return [
        [0, -radius * 1.2],
        [radius * 1.2, 0],
        [0, radius * 1.2],
        [-radius * 1.2, 0],
      ]
        .map(([x, y]) => `${String(x)},${String(y)}`)
        .join(" ");

    case "circle":
    default:
      return "";
  }
}
