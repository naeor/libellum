import type { CategoryTotal, PeriodTotals, StatsSeriesPoint } from "@libellum/shared";
import { useState } from "react";

import { CalendarHeatmap } from "../components/charts/CalendarHeatmap.js";
import { CategoryDonut } from "../components/charts/CategoryDonut.js";
import { ComparisonPanel, YearOverview } from "../components/charts/SummaryPanel.js";
import { TrendChart } from "../components/charts/TrendChart.js";

/**
 * A development harness — **not a shipped feature**.
 *
 * The route exists only under `import.meta.env.DEV`, so it is removed from a
 * production build. It renders the **real chart components** against data
 * chosen to be awkward on purpose: a month with one enormous day, days with
 * nothing at all, an all-zero period, a single category, a period with no
 * comparison. Those are the inputs that break charts, and they are far cheaper
 * to look at here than to discover on a phone.
 *
 * No session is needed: every number below is a constant.
 */

const CURRENCY = "CNY";

function monthSeries(values: readonly number[], year = "2026"): StatsSeriesPoint[] {
  return values.map((expenseMinor, index) => ({
    bucket: `${year}-${String(index + 1).padStart(2, "0")}`,
    expenseMinor,
    incomeMinor: 200_000,
  }));
}

/** One enormous day among ordinary ones — the case the heat scale exists for. */
const SPIKY_MONTH = [
  0, 1_200, 0, 800, 4_500, 0, 0, 3_000, 0, 1_500, 0, 2_200, 0, 0, 900, 1_800, 0, 0, 12_000, 0,
  700, 2_600, 0, 1_100, 0, 0, 3_300, 0, 1_400, 0,
];

const SPIKY_DAYS: StatsSeriesPoint[] = SPIKY_MONTH.map((expenseMinor, index) => ({
  bucket: `2026-10-${String(index + 1).padStart(2, "0")}`,
  expenseMinor,
  incomeMinor: 0,
}));

const MONTHS = monthSeries([82_000, 124_000, 66_000, 198_000, 91_000, 105_000, 143_000, 78_000, 112_000, 96_000, 131_000, 89_000]);

const CATEGORIES: CategoryTotal[] = [
  { categoryId: "1", name: "餐饮", kind: "expense", minor: 124_000, share: 0.41 },
  { categoryId: "2", name: "购物", kind: "expense", minor: 86_000, share: 0.28 },
  { categoryId: "3", name: "服务", kind: "expense", minor: 42_000, share: 0.14 },
  { categoryId: "4", name: "娱乐", kind: "expense", minor: 31_000, share: 0.1 },
  { categoryId: "5", name: "其它", kind: "expense", minor: 19_000, share: 0.07 },
];

const TOTALS: PeriodTotals = {
  expenseMinor: 302_000,
  incomeMinor: 600_000,
  netMinor: 298_000,
  count: 42,
  largestExpenseMinor: 68_000,
};

const EMPTY_TOTALS: PeriodTotals = {
  expenseMinor: 0,
  incomeMinor: 0,
  netMinor: 0,
  count: 0,
  largestExpenseMinor: 0,
};

export function ChartLabPage(): React.JSX.Element {
  const [range, setRange] = useState<"7d" | "month">("month");

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col gap-8 px-4 py-8">
      <header>
        <h1 className="text-xl font-semibold text-ink">图表组件 · 开发验证页</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          这个页面只在开发模式下存在，用来确认图表在异常数据下仍然可读。它不是产品功能，也不需要登录。
        </p>
      </header>

      <Section title="趋势折线（双系列，可触摸）">
        <TrendChart points={MONTHS} currency={CURRENCY} bucket="month" />
      </Section>

      <Section title="分类占比（点分类下钻）">
        <CategoryDonut totals={CATEGORIES} currency={CURRENCY} />
      </Section>

      <Section title="环比对比（月未结束，对比上月同期）">
        <ComparisonPanel
          current={TOTALS}
          previous={{ ...TOTALS, expenseMinor: 268_000 }}
          monthToDate
          currentDays={9}
          previousDays={9}
          currency={CURRENCY}
        />
      </Section>

      <Section title="环比对比（没有可对比的数据）">
        <ComparisonPanel
          current={TOTALS}
          previous={null}
          monthToDate={false}
          currentDays={30}
          previousDays={0}
          currency={CURRENCY}
        />
      </Section>

      <Section title="年度总览">
        <YearOverview months={MONTHS} totals={TOTALS} currency={CURRENCY} />
      </Section>

      <Section title="日历热力（含一个 10 倍极值）">
        <div className="mb-3 flex gap-2">
          {(["7d", "month"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setRange(option);
              }}
              className={`rounded-full px-4 py-1.5 text-sm transition ${
                range === option ? "bg-brand text-white" : "bg-canvas text-muted"
              }`}
            >
              {option === "7d" ? "近 7 天" : "本月"}
            </button>
          ))}
        </div>
        <CalendarHeatmap
          days={range === "7d" ? SPIKY_DAYS.slice(-7) : SPIKY_DAYS}
          currency={CURRENCY}
        />
      </Section>

      <Section title="异常状态">
        <div className="flex flex-col gap-6">
          <div>
            <p className="mb-2 text-xs text-ink">没有任何数据</p>
            <TrendChart points={[]} currency={CURRENCY} bucket="day" />
          </div>
          <div>
            <p className="mb-2 text-xs text-ink">有记录但全为零</p>
            <TrendChart
              points={[{ bucket: "2026-10-01", expenseMinor: 0, incomeMinor: 0 }]}
              currency={CURRENCY}
              bucket="day"
            />
          </div>
          <div>
            <p className="mb-2 text-xs text-ink">只有一个分类</p>
            <CategoryDonut
              totals={[{ categoryId: "1", name: "餐饮", kind: "expense", minor: 5_000, share: 1 }]}
              currency={CURRENCY}
            />
          </div>
          <div>
            <p className="mb-2 text-xs text-ink">全零的年度总览</p>
            <YearOverview
              months={monthSeries(Array.from({ length: 12 }, () => 0))}
              totals={EMPTY_TOTALS}
              currency={CURRENCY}
            />
          </div>
          <div>
            <p className="mb-2 text-xs text-ink">含负结余的年度总览</p>
            <YearOverview
              months={monthSeries([120_000, 300_000, 480_000, 90_000, 210_000, 260_000, 150_000, 88_000, 300_000, 190_000, 240_000, 420_000])}
              totals={{ ...TOTALS, incomeMinor: 100_000, netMinor: -202_000 }}
              currency={CURRENCY}
            />
          </div>
          <div>
            <p className="mb-2 text-xs text-ink">日元（没有小数位）</p>
            <TrendChart
              points={[
                { bucket: "2026-08", expenseMinor: 12_000, incomeMinor: 30_000 },
                { bucket: "2026-09", expenseMinor: 48_000, incomeMinor: 30_000 },
                { bucket: "2026-10", expenseMinor: 26_000, incomeMinor: 30_000 },
              ]}
              currency="JPY"
              bucket="month"
            />
          </div>
        </div>
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
