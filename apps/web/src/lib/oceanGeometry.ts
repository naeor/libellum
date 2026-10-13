import { clamp01 } from "./transitionPhysics.js";


/** Broad, staggered swells in the presentation state converge to a quiet header.
 * Layer detail is bounded to ±2.2% (±0.3% in the header), so neighbouring
 * boundaries stay separated without clamping or flattening their curves. */
export function oceanEdge(layer: number, x: number, progress: number, seconds: number): number {
  const p = clamp01(progress);
  const settle = p * p * (3 - 2 * p);
  const phase = seconds * Math.PI * 2 / 14;
  const shared = (0.022 - settle * 0.014) * (0.5 - x)
    + (0.010 - settle * 0.005) * Math.sin(x * Math.PI * 1.5 + 0.6 + Math.sin(phase) * 0.35);
  // Deliberate low-frequency differences, not random noise or translated copies.
  const frequency = [0.72, 0.88, 0.66, 0.81][layer] ?? 0.72;
  const offset = [0.25, 1.35, 2.55, 3.65][layer] ?? 0.25;
  const rhythm = [1, 0.83, 1.09, 0.91][layer] ?? 1;
  const detail = (0.022 - settle * 0.019)
    * Math.sin(x * Math.PI * 2 * frequency + offset
      + Math.sin(phase * rhythm + layer * 1.4) * (0.7 - settle * 0.5));
  // Less light-coloured area at the top keeps the working state unobtrusive.
  return 0.70 + 0.045 * settle + layer * (0.10 - 0.015 * settle) + shared + detail;
}

/** Cubic Hermite segments preserve smooth tangents without a dense polygon. */
export function oceanPath(layer: number, progress: number, seconds: number): string {
  const y = (x: number): number => oceanEdge(layer, x, progress, seconds) * 100;
  const slope = (x: number): number => (y(x + 0.0001) - y(x - 0.0001)) / 0.0002;
  let path = `M-1,-2 H101 L101,${y(1.01).toFixed(4)}`;
  const segments = 24;
  for (let i = 0; i < segments; i++) {
    const a = 1.01 - i * 1.02 / segments;
    const b = 1.01 - (i + 1) * 1.02 / segments;
    const d = (b - a) / 3;
    path += ` C${((a + d) * 100).toFixed(4)},${(y(a) + slope(a) * d).toFixed(4)} ${((b - d) * 100).toFixed(4)},${(y(b) - slope(b) * d).toFixed(4)} ${(b * 100).toFixed(4)},${y(b).toFixed(4)}`;
  }
  return path + " Z";
}
