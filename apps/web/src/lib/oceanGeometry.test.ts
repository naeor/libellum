import { describe, expect, it } from "vitest";
import { oceanEdge, oceanPath } from "./oceanGeometry.js";

describe("ocean geometry", () => {
  it("keeps all three bands visible throughout motion and contraction", () => {
    let min = 1, max = 0, top = 1, bottom = 0;
    for (let step = 0; step <= 20; step++) {
      const p = step / 20;
      for (let t = 0; t < 240; t += 0.7) {
        for (let x = 0; x <= 1; x += 0.025) {
          for (let layer = 1; layer < 4; layer++) {
            const thickness = oceanEdge(layer, x, p, t) - oceanEdge(layer - 1, x, p, t);
            min = Math.min(min, thickness); max = Math.max(max, thickness);
          }
          top = Math.min(top, oceanEdge(0, x, p, t));
          bottom = Math.max(bottom, oceanEdge(3, x, p, t));
        }
      }
    }
    expect(min).toBeGreaterThanOrEqual(0.05);
    expect(max).toBeLessThanOrEqual(0.15);
    expect(top).toBeGreaterThan(0.5);
    expect(bottom).toBeLessThan(1.1);
  });
  it("uses continuous curves with a closed top and no invalid numbers", () => {
    const path = oceanPath(0, 0.5, 12);
    expect(path).toMatch(/^M-1,-2 H101/);
    expect(path).toMatch(/ Z$/);
    expect(path).not.toMatch(/NaN|Infinity/);
  });
  it("moves perceptibly at rest and reduces motion in the list state", () => {
    const movement = (p: number) => Math.abs(oceanEdge(0, 0.4, p, 0)-oceanEdge(0, 0.4, p, 4));
    expect(movement(0)).toBeGreaterThan(0.01);
    expect(movement(1)).toBeLessThan(movement(0));
  });
});
