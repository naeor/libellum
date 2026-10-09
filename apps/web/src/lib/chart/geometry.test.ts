import { describe, expect, it } from "vitest";

import { arcPath, areaPath, linePath, polarToCartesian } from "./geometry.js";

describe("linePath", () => {
  it("draws a polyline", () => {
    expect(
      linePath([
        { x: 0, y: 10 },
        { x: 10, y: 20 },
      ]),
    ).toBe("M 0 10 L 10 20");
  });

  it("returns nothing for an empty series", () => {
    expect(linePath([])).toBe("");
  });

  it("moves to a single point without drawing a segment", () => {
    expect(linePath([{ x: 5, y: 5 }])).toBe("M 5 5");
  });
});

describe("areaPath", () => {
  it("closes the line down to the baseline", () => {
    const path = areaPath(
      [
        { x: 0, y: 10 },
        { x: 10, y: 20 },
      ],
      30,
    );

    expect(path).toBe("M 0 10 L 10 20 L 10 30 L 0 30 Z");
  });

  it("returns nothing when a line cannot be drawn", () => {
    expect(areaPath([], 10)).toBe("");
    expect(areaPath([{ x: 1, y: 1 }], 10)).toBe("");
  });
});

describe("polarToCartesian", () => {
  it("starts at the top and turns clockwise", () => {
    const top = polarToCartesian(50, 50, 10, 0);
    expect(top.x).toBeCloseTo(50);
    expect(top.y).toBeCloseTo(40);

    const right = polarToCartesian(50, 50, 10, 90);
    expect(right.x).toBeCloseTo(60);
    expect(right.y).toBeCloseTo(50);
  });
});

describe("arcPath", () => {
  it("draws a pie slice from the centre", () => {
    const path = arcPath(50, 50, 40, 0, 0, 90);

    expect(path.startsWith("M 50 50")).toBe(true);
    expect(path).toContain("A 40 40");
    expect(path.endsWith("Z")).toBe(true);
  });

  it("draws a donut segment with an inner arc", () => {
    const path = arcPath(50, 50, 40, 20, 0, 90);

    expect(path).toContain("A 40 40");
    expect(path).toContain("A 20 20");
  });

  it("uses the large-arc flag past a half turn", () => {
    expect(arcPath(50, 50, 40, 0, 0, 200)).toContain("0 1 1");
    expect(arcPath(50, 50, 40, 0, 0, 90)).toContain("0 0 1");
  });

  it("draws a full circle as two halves rather than one impossible arc", () => {
    const path = arcPath(50, 50, 40, 30, 0, 360);

    // Two arcs for the outer edge and two for the inner.
    expect(path.match(/A /g)).toHaveLength(4);
  });

  it("returns nothing for a zero-width segment", () => {
    expect(arcPath(50, 50, 40, 0, 90, 90)).toBe("");
  });
});
