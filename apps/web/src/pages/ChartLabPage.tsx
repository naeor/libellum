import { useState } from "react";

import { ChartFrame, type ChartLayout } from "../components/chart/ChartFrame.js";
import { Baseline, XAxis, YAxis } from "../components/chart/Axis.js";
import { Legend, type LegendItem } from "../components/chart/Legend.js";
import { areaPath, arcPath, linePath, polarToCartesian } from "../lib/chart/geometry.js";
import {
  bucketOf,
  bucketThresholds,
  createLinearScale,
  extentOf,
  niceDomain,
  ticksFor,
} from "../lib/chart/scales.js";
import { categoricalColor, heatColor, markerPoints } from "../lib/chart/theme.js";
import { emptyStateMessage, summariseSeries } from "../lib/chart/guards.js";
import { formatAxisAmount, formatExactAmount } from "../lib/chart/format.js";

/**
 * A development harness for the chart foundation — **not a shipped feature**.
 *
 * The route only exists under `import.meta.env.DEV`, so it is removed from a
 * production build. It draws each primitive with data chosen to be awkward on
 * purpose: a single huge value among ordinary ones, a month with empty days, an
 * all-zero series, one lone category. Those are the inputs that break charts,
 * and they are much cheaper to look at here than to discover on a phone.
 *
 * It needs no sign-in: every number below is a constant, and nothing here
 * touches an account.
 */

const MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

const EXPENSE = [820_00, 1_240_00, 660_00, 1_980_00, 910_00, 1_050_00, 1_430_00, 780_00, 1_120_00, 960_00, 1_310_00, 890_00];
const INCOME = [2_000_00, 2_000_00, 2_400_00, 2_000_00, 2_000_00, 2_600_00, 2_000_00, 2_000_00, 2_200_00, 2_000_00, 2_000_00, 3_000_00];

/** A month where one day is enormous — the case the heat scale exists for. */
const SPIKY_DAYS = [0, 12_00, 0, 8_00, 45_00, 0, 0, 30_00, 0, 15_00, 0, 22_00, 0, 0, 9_00, 18_00, 0, 0, 120_00, 0, 7_00, 26_00, 0, 11_00, 0, 0, 33_00, 0, 14_00, 0];

const CATEGORIES = [
  { label: "餐饮", value: 1_240_00 },
  { label: "购物", value: 860_00 },
  { label: "服务", value: 420_00 },
  { label: "娱乐", value: 310_00 },
  { label: "其它", value: 190_00 },
];

export function ChartLabPage(): React.JSX.Element {
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col gap-8 px-4 py-8">
      <header>
        <h1 className="text-xl font-semibold text-ink">图表基础组件 · 开发验证页</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          这个页面只在开发模式下存在，用来确认共用绘图组件在异常数据下仍然可读。它不是产品功能。
        </p>
      </header>

      <Section title="折线 + 面积（双系列）">
        <LineDemo />
      </Section>

      <Section title="柱状（单一分类的极端值）">
        <BarDemo />
      </Section>

      <Section title="环形（分类占比）">
        <DonutDemo />
      </Section>

      <Section title={`日历热力（${String(SPIKY_DAYS.length)} 天，含一个 10 倍极值）`}>
        <HeatDemo selected={selectedDay} onSelect={setSelectedDay} />
      </Section>

      <Section title="异常状态">
        <StateDemo />
      </Section>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-ink">{title}</h2>
      <div className="rounded-card border border-line bg-surface p-4">{children}</div>
    </section>
  );
}

function LineDemo(): React.JSX.Element {
  const items: LegendItem[] = [
    { label: "支出", color: categoricalColor(3), shape: "circle", value: formatExactAmount(11_150_00, "CNY") },
    { label: "收入", color: categoricalColor(0), shape: "square", value: formatExactAmount(24_200_00, "CNY") },
  ];

  return (
    <>
      <ChartFrame height={180} padding={{ top: 10, right: 10, bottom: 26, left: 40 }} title="最近 12 个月收支" notice={null}>
        {(layout) => {
          const all = [...EXPENSE, ...INCOME];
          const extent = extentOf(all) ?? [0, 1];
          const domain = niceDomain(extent[0], extent[1], 4);
          const y = createLinearScale(domain, [layout.padding.top + layout.innerHeight, layout.padding.top]);
          const slot = layout.innerWidth / MONTHS.length;
          const x = (index: number): number => layout.padding.left + slot * (index + 0.5);

          const toPoints = (values: number[]): { x: number; y: number }[] =>
            values.map((value, index) => ({ x: x(index), y: y(value) }));

          const expensePoints = toPoints(EXPENSE);
          const incomePoints = toPoints(INCOME);

          return (
            <>
              <YAxis
                layout={layout}
                ticks={ticksFor(domain, 4)}
                scale={y}
                format={(value) => formatAxisAmount(value, "CNY")}
              />
              <Baseline layout={layout} y={y(0)} />
              <path d={areaPath(expensePoints, y(0))} fill={categoricalColor(3)} fillOpacity={0.12} />
              <path d={linePath(expensePoints)} fill="none" stroke={categoricalColor(3)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <path d={linePath(incomePoints)} fill="none" stroke={categoricalColor(0)} strokeWidth={2} strokeDasharray="4 3" strokeLinejoin="round" />
              {incomePoints.map((point, index) => (
                <polygon
                  key={index}
                  points={markerPoints("square", 2.6)}
                  transform={`translate(${String(point.x)}, ${String(point.y)})`}
                  fill={categoricalColor(0)}
                />
              ))}
              <XAxis layout={layout} labels={MONTHS} slotWidth={slot} />
            </>
          );
        }}
      </ChartFrame>
      <Legend items={items} className="mt-3" />
    </>
  );
}

function BarDemo(): React.JSX.Element {
  const values = [...EXPENSE.slice(0, 11), 9_800_00];
  const summary = summariseSeries(values);

  return (
    <>
      <ChartFrame height={170} padding={{ top: 10, right: 10, bottom: 26, left: 40 }} title="某月支出，末月为极值" notice={emptyStateMessage(summary.state, "支出")}>
        {(layout) => {
          const domain = niceDomain(0, summary.max, 4);
          const y = createLinearScale(domain, [layout.padding.top + layout.innerHeight, layout.padding.top]);
          const slot = layout.innerWidth / values.length;
          const barWidth = Math.max(slot * 0.6, 2);

          return (
            <>
              <YAxis layout={layout} ticks={ticksFor(domain, 4)} scale={y} format={(value) => formatAxisAmount(value, "CNY")} />
              {values.map((value, index) => {
                const top = y(value);
                const base = y(0);
                const isOutlier = index === values.length - 1;

                return (
                  <rect
                    key={index}
                    x={layout.padding.left + slot * index + (slot - barWidth) / 2}
                    y={top}
                    width={barWidth}
                    height={Math.max(base - top, 1)}
                    rx={1.5}
                    fill={categoricalColor(0)}
                    fillOpacity={isOutlier ? 1 : 0.55}
                  />
                );
              })}
              <XAxis layout={layout} labels={MONTHS.slice(0, values.length)} slotWidth={slot} />
            </>
          );
        }}
      </ChartFrame>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        极值是中间的十倍，但纵轴仍然从 0 起——{summary.hasExtreme ? "已识别为极值" : "未识别为极值"}。
        普通月份的柱子依然分得出高低。
      </p>
    </>
  );
}

function DonutDemo(): React.JSX.Element {
  const total = CATEGORIES.reduce((sum, item) => sum + item.value, 0);
  const summary = summariseSeries(CATEGORIES.map((item) => item.value));

  return (
    <>
      <ChartFrame height={190} padding={{ top: 8, right: 8, bottom: 8, left: 8 }} title="分类占比" notice={emptyStateMessage(summary.state, "分类")}>
        {(layout) => {
          const cx = layout.width / 2;
          const cy = layout.height / 2;
          const outer = Math.min(cx, cy) - 6;
          const inner = outer * 0.58;

          let angle = 0;

          return (
            <>
              {CATEGORIES.map((item, index) => {
                const sweep = (item.value / total) * 360;
                const path = arcPath(cx, cy, outer, inner, angle + 0.6, angle + sweep - 0.6);
                angle += sweep;

                return <path key={item.label} d={path} fill={categoricalColor(index)} />;
              })}
              {CATEGORIES.map((item, index) => {
                const share = item.value / total;
                const mid = 360 * (CATEGORIES.slice(0, index).reduce((sum, entry) => sum + entry.value, 0) / total) + (share * 360) / 2;
                const anchor = polarToCartesian(cx, cy, outer - 14, mid);

                return share < 0.08 ? null : (
                  <text key={`label-${item.label}`} x={anchor.x} y={anchor.y} textAnchor="middle" dominantBaseline="middle" fontSize={10} fill="#ffffff">
                    {Math.round(share * 100)}%
                  </text>
                );
              })}
            </>
          );
        }}
      </ChartFrame>
      <Legend
        className="mt-3"
        items={CATEGORIES.map((item, index) => ({
          label: item.label,
          color: categoricalColor(index),
          shape: (["circle", "square", "triangle", "diamond", "circle"] as const)[index] ?? "circle",
          value: `${String(Math.round((item.value / total) * 100))}%`,
        }))}
      />
    </>
  );
}

function HeatDemo({
  selected,
  onSelect,
}: {
  readonly selected: number | null;
  readonly onSelect: (day: number | null) => void;
}): React.JSX.Element {
  const thresholds = bucketThresholds(SPIKY_DAYS, 4);
  const columns = 7;
  const rows = Math.ceil(SPIKY_DAYS.length / columns);
  const cell = 30;
  const gap = 3;

  return (
    <>
      <div className="flex flex-wrap gap-1">
        {SPIKY_DAYS.map((value, index) => {
          const level = bucketOf(value, thresholds);
          const isSelected = selected === index;

          return (
            <button
              key={index}
              type="button"
              onClick={() => {
                onSelect(isSelected ? null : index);
              }}
              aria-label={`第 ${String(index + 1)} 天 ${formatExactAmount(value, "CNY")} 元`}
              className={`flex h-8 w-8 items-center justify-center rounded text-[10px] transition ${
                isSelected ? "ring-2 ring-ink" : ""
              } ${level >= 3 ? "text-white" : "text-muted"}`}
              style={{ backgroundColor: heatColor(level) }}
            >
              {index + 1}
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted">
        {selected === null
          ? "点任意一天查看金额。颜色按「本期内的相对高低」分四档；某天 120 元，其余多为个位数到几十元，但便宜的日期仍然分得出深浅。"
          : `第 ${String(selected + 1)} 天：${formatExactAmount(SPIKY_DAYS[selected] ?? 0, "CNY")} 元（第 ${String(bucketOf(SPIKY_DAYS[selected] ?? 0, thresholds))} 档）`}
      </p>

      <div className="mt-3 flex items-center gap-2 text-[10px] text-muted">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className="inline-block h-3 w-6 rounded-sm" style={{ backgroundColor: heatColor(level) }} />
        ))}
        <span>多</span>
        <span className="ml-2">（最左＝无支出）</span>
      </div>
    </>
  );
}

function StateDemo(): React.JSX.Element {
  const cases: readonly { readonly title: string; readonly values: readonly number[] }[] = [
    { title: "没有任何数据", values: [] },
    { title: "有记录但全是 0", values: [0, 0, 0, 0] },
    { title: "只有一个分类", values: [0, 500, 0] },
    { title: "含负结余", values: [-200, 800, -150] },
  ];

  return (
    <div className="flex flex-col gap-4">
      {cases.map((item) => {
        const summary = summariseSeries(item.values);

        return (
          <div key={item.title}>
            <p className="mb-1.5 text-xs text-ink">{item.title}</p>
            <ChartFrame height={70} title={item.title} notice={emptyStateMessage(summary.state, "支出")}>
              {(layout: ChartLayout) => {
                const domain = niceDomain(summary.min, summary.max, 3);
                const y = createLinearScale(domain, [layout.padding.top + layout.innerHeight, layout.padding.top]);
                const zero = y(0);
                const slot = layout.innerWidth / item.values.length;

                return (
                  <>
                    <Baseline layout={layout} y={zero} />
                    {item.values.map((value, index) => {
                      const top = Math.min(y(value), zero);
                      const height = Math.abs(y(value) - zero);

                      return (
                        <rect
                          key={index}
                          x={layout.padding.left + slot * index + slot * 0.2}
                          y={top}
                          width={slot * 0.6}
                          height={Math.max(height, 1)}
                          rx={1.5}
                          fill={value < 0 ? categoricalColor(3) : categoricalColor(0)}
                        />
                      );
                    })}
                  </>
                );
              }}
            </ChartFrame>
          </div>
        );
      })}
    </div>
  );
}
