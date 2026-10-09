import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChartFrame, type ChartLayout } from "./ChartFrame.js";
import { Legend } from "./Legend.js";
import { XAxis, labelStep } from "./Axis.js";

/**
 * Component checks.
 *
 * Rendered to static markup rather than into a DOM: it needs no jsdom and no
 * testing library, and it still catches the failures worth catching here — a
 * chart that draws nothing when it should, one that draws when it should not,
 * labels that pile up on top of each other, a legend that leans on colour.
 */

describe("ChartFrame", () => {
  it("explains itself instead of drawing an empty plot", () => {
    const html = renderToStaticMarkup(
      <ChartFrame height={160} title="趋势" notice="这个时间段还没有支出记录。">
        {() => <text>x</text>}
      </ChartFrame>,
    );

    expect(html).toContain("这个时间段还没有支出记录。");
    expect(html).not.toContain("<svg");
  });

  it("draws when there is something to draw", () => {
    const html = renderToStaticMarkup(
      <ChartFrame height={160} title="趋势" notice={null}>
        {() => <text>plot</text>}
      </ChartFrame>,
    );

    expect(html).toContain("<svg");
    expect(html).toContain("plot");
  });

  it("hands the plot a box smaller than the frame by its padding", () => {
    let seen: ChartLayout | null = null;

    renderToStaticMarkup(
      <ChartFrame
        height={200}
        padding={{ top: 10, right: 20, bottom: 30, left: 40 }}
        title="趋势"
        notice={null}
      >
        {(layout) => {
          seen = layout;
          return null;
        }}
      </ChartFrame>,
    );

    const layout = seen as ChartLayout | null;
    expect(layout).not.toBeNull();
    expect(layout!.innerWidth).toBe(layout!.width - 60);
    expect(layout!.innerHeight).toBe(200 - 40);
  });

  it("describes itself for a screen reader", () => {
    const html = renderToStaticMarkup(
      <ChartFrame height={160} title="最近 30 天支出趋势" notice={null}>
        {() => null}
      </ChartFrame>,
    );

    expect(html).toContain('role="img"');
    expect(html).toContain("最近 30 天支出趋势");
  });
});

describe("labelStep", () => {
  it("shows every label when there is room", () => {
    expect(labelStep(4, 300, 28)).toBe(1);
  });

  it("thins labels rather than overlapping them", () => {
    // Twelve months on a narrow phone: not all of them can be printed.
    expect(labelStep(12, 150, 28)).toBeGreaterThan(1);
  });

  it("always keeps at least one label", () => {
    expect(labelStep(12, 0, 28)).toBe(12);
    expect(labelStep(0, 100, 28)).toBe(1);
  });
});

describe("XAxis", () => {
  const layout: ChartLayout = {
    width: 320,
    height: 160,
    innerWidth: 280,
    innerHeight: 120,
    padding: { top: 10, right: 20, bottom: 30, left: 20 },
  };

  it("omits labels that would collide", () => {
    const labels = Array.from({ length: 12 }, (_, index) => `M${String(index + 1)}`);

    const html = renderToStaticMarkup(
      <svg>
        <XAxis layout={layout} labels={labels} slotWidth={layout.innerWidth / labels.length} />
      </svg>,
    );

    const printed = (html.match(/<text/g) ?? []).length;
    expect(printed).toBeLessThan(labels.length);
    expect(printed).toBeGreaterThan(0);
    // The first label survives: a thinned axis still has to say where it starts.
    expect(html).toContain("M1");
  });
});

describe("Legend", () => {
  it("gives every entry a shape as well as a colour", () => {
    const html = renderToStaticMarkup(
      <Legend
        items={[
          { label: "支出", color: "#b8574f", shape: "circle", value: "¥120.00" },
          { label: "收入", color: "#55997a", shape: "square", value: "¥30.00" },
        ]}
      />,
    );

    expect(html).toContain("支出");
    expect(html).toContain("收入");
    expect(html).toContain("¥120.00");
    // One circle and one polygon: colour is not the only difference.
    expect(html).toContain("<circle");
    expect(html).toContain("<polygon");
  });
});
