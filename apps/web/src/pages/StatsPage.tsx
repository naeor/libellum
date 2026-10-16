import {
  CURRENCIES,
  RANGE_LABELS,
  STATS_RANGES,
  averagePerDay,
  bucketForPreset,
  comparisonRangeFor,
  daysBetween,
  endOfMonth,
  rangeForPreset,
  startOfMonth,
  type Currency,
  type DateRange,
  type StatsRangeKey,
  type TransactionKind,
} from "@libellum/shared";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { TabPageHeader } from "../components/TabPageHeader.js";
import { CalendarHeatmap } from "../components/charts/CalendarHeatmap.js";
import { CategoryDonut } from "../components/charts/CategoryDonut.js";
import { ComparisonPanel, YearOverview } from "../components/charts/SummaryPanel.js";
import { TrendChart } from "../components/charts/TrendChart.js";
import { TabPage } from "../components/Layouts.js";
import { Section } from "../components/Section.js";
import { SkeletonRows } from "../components/States.js";
import { useAuth } from "../auth/AuthProvider.js";
import { errorMessage } from "../lib/api.js";
import { toLocalDate } from "../lib/datetime.js";
import { currencyName, formatMoney } from "../lib/format.js";
import { useLedger, useStats } from "../lib/queries.js";

/** The heat map's own two views: the last week, or the current month. */
const HEAT_RANGES = ["7d", "month"] as const;
export type HeatRange = (typeof HEAT_RANGES)[number];

export function StatsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const ledger = useLedger();
  const { user } = useAuth();

  const [preset, setPreset] = useState<StatsRangeKey>("30d");
  const [currency, setCurrency] = useState<Currency | null>(null);
  const [kind, setKind] = useState<TransactionKind>("expense");
  const [heatRange, setHeatRange] = useState<HeatRange>("month");

  /**
   * Today, from this device's clock.
   *
   * The server is never asked what day it is: "today" is a fact about the
   * person holding the phone, and the whole point of storing a local date on
   * every entry is that the two can differ.
   */
  const today = useMemo(() => toLocalDate(new Date()), []);

  const currencyInUse: Currency = currency ?? user?.defaultCurrency ?? "CNY";

  // The four buttons are a shortcut; everything below deals in dates.
  const range = rangeForPreset(preset, today);
  const bucket = bucketForPreset(preset);
  const comparison = comparisonRangeFor(range);

  const year = today.slice(0, 4);
  const yearRange = { from: `${year}-01-01`, to: `${year}-12-31` };

  const heat = heatRangeFor(heatRange, today);

  const main = useStats({
    ...range,
    bucket,
    currency: currencyInUse,
    compareFrom: comparison.from,
    compareTo: comparison.to,
  });

  const yearStats = useStats({ ...yearRange, bucket: "month", currency: currencyInUse });

  const heatStats = useStats({ ...heat, bucket: "day", currency: currencyInUse });

  const currencies = useMemo(() => {
    const preferred = user?.defaultCurrency ?? "CNY";

    return [...CURRENCIES].sort((a, b) => {
      if (a === preferred) return -1;
      if (b === preferred) return 1;
      return 0;
    });
  }, [user?.defaultCurrency]);

  const categoryTotals = useMemo(
    () => (main.data?.byCategory ?? []).filter((total) => total.kind === kind),
    [main.data, kind],
  );

  return (
    <TabPage currentBookName={ledger.data?.book.name} active="stats" onNavigate={(to) => { navigate(to); }}>
      {/**
        * ⚠️ **The green heading area is `TabPageHeader`, shared with 账本／协作** (1.10.10). The owner
        * asked for the two to be aligned *by construction* rather than by eye: *"尽可能复用相同的标题区布局
        * 规则或共享样式，保证以后修改时不会再次出现差异."* **The title and subtitle are now literally
        * the same component**, so there is no second copy to drift.
        *
        * ⚠️ **⚠️ The 「当前账本：XXX」 row that used to sit here is gone, and that is the owner's
        * instruction**: *"分析页底部 Tab 导航栏上方已经有相同的当前账本提示，没有必要在顶部重复展示."*
        *
        * ⚠️ **It is safe to remove because the bottom one is real and unaffected** — `TabPage` renders
        * `CurrentBookCaption` from the `currentBookName` prop below, which is a **different element** at
        * a different layer. The reason the row existed (two ledgers' charts look identical) is still
        * answered, just once instead of twice.
        */}
      <TabPageHeader title="分析" subtitle="统计基于已记录的账目。" />

      {/**
        * ⚠️ **`pt-6`, to match the first block on 账本／协作** — the owner's 7th point:
        * *"与下方第一个内容模块之间的间距."* This one was `pt-5` (20px) while the ledger tab's first
        * card was `pt-6` (24px), so **the two headers ended 4 px apart even though the headers themselves
        * matched exactly.** A difference that small is invisible in a code review and visible when
        * switching tabs, which is precisely the kind the owner asked to be ruled out by construction.
        */}
        <section className="flex flex-col gap-3 px-6 pt-6">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {STATS_RANGES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setPreset(option);
              }}
              className={`shrink-0 rounded-full px-4 py-2 text-sm transition ${
                preset === option ? "bg-brand text-white" : "bg-surface text-muted hover:text-ink"
              }`}
            >
              {RANGE_LABELS[option]}
            </button>
          ))}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {currencies.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setCurrency(option);
              }}
              className={`shrink-0 rounded-full px-4 py-2 text-sm transition ${
                currencyInUse === option ? "bg-brand text-white" : "bg-surface text-muted hover:text-ink"
              }`}
            >
              {currencyName(option)}
            </button>
          ))}
        </div>

        <p className="text-helper-relaxed text-muted">
          {range.from} 至 {range.to}，币种为{currencyName(currencyInUse)}。
        </p>
      </section>

      {main.isError ? (
        <section className="px-6 pt-5">
          <Alert tone="error">{errorMessage(main.error)}</Alert>
        </section>
      ) : null}

      {main.isPending ? (
        <section className="px-6 pt-6">
          <SkeletonRows rows={4} />
        </section>
      ) : null}

      {main.data ? (
        <>
          <Section title="收支趋势">
            <TrendChart
              points={main.data.series}
              currency={currencyInUse}
              bucket={bucket}
              hasEntries={main.data.totals.count > 0}
            />
          </Section>

          <Section title="分类占比">
            <div className="mb-3 flex gap-2">
              {(["expense", "income"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    setKind(option);
                  }}
                  className={`rounded-full px-4 py-1.5 text-sm transition ${
                    kind === option ? "bg-brand text-white" : "bg-canvas text-muted hover:text-ink"
                  }`}
                >
                  {option === "expense" ? "支出" : "收入"}
                </button>
              ))}
            </div>
            <CategoryDonut
              totals={categoryTotals}
              currency={currencyInUse}
              onSelectCategory={(categoryId) => {
                // The number on its own is never the answer; the entries behind
                // it are. This opens the list already filtered.
                void navigate(`/?categoryId=${categoryId}&month=${range.to.slice(0, 7)}`);
              }}
            />
          </Section>

          <Section title="环比对比">
            <ComparisonPanel
              current={main.data.totals}
              previous={main.data.comparison?.totals ?? null}
              monthToDate={range.to < endOfMonth(range.to)}
              currentDays={daysBetween(range.from, range.to)}
              previousDays={
                main.data.comparison === null
                  ? 0
                  : daysBetween(main.data.comparison.range.from, main.data.comparison.range.to)
              }
              currency={currencyInUse}
            />
          </Section>

          <Section title="本期概览">
            <dl className="grid grid-cols-2 gap-3">
              <Stat label="日均支出" value={formatMoney(averagePerDay(main.data.totals, main.data.range.days), currencyInUse)} />
              <Stat label="最大单笔" value={formatMoney(main.data.totals.largestExpenseMinor, currencyInUse)} />
            </dl>
          </Section>
        </>
      ) : null}

      <Section title={`日历热力（${heatRange === "7d" ? "近 7 天" : "本月"}）`}>
        <div className="mb-3 flex gap-2">
          {HEAT_RANGES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setHeatRange(option);
              }}
              className={`rounded-full px-4 py-1.5 text-sm transition ${
                heatRange === option ? "bg-brand text-white" : "bg-canvas text-muted hover:text-ink"
              }`}
            >
              {option === "7d" ? "近 7 天" : "本月"}
            </button>
          ))}
        </div>
        {heatStats.data ? (
          <CalendarHeatmap
            days={heatStats.data.series}
            currency={currencyInUse}
            hasEntries={heatStats.data.totals.count > 0}
          />
        ) : (
          <SkeletonRows rows={2} />
        )}
      </Section>

      <Section title={`年度总览（${year}）`}>
        {yearStats.data ? (
          <YearOverview
            months={yearStats.data.series}
            totals={yearStats.data.totals}
            currency={currencyInUse}
          />
        ) : (
          <SkeletonRows rows={3} />
        )}
      </Section>
    </TabPage>
  );
}


function Stat({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="rounded-field bg-canvas px-4 py-3">
      <dt className="text-helper text-muted">{label}</dt>
      <dd className="mt-1 text-base font-medium tabular-nums text-ink">{value}</dd>
    </div>
  );
}

/**
 * The range the calendar heat map draws.
 *
 * Kept out of the component because the last day of a month is exactly the date
 * that is easy to build wrongly. The screen used to paste "-31" onto the month
 * string, so April asked for the 31st of April; JavaScript accepts that and
 * rolls it forward to the 1st of May, and the query then counted the next
 * month's first day towards this one. `endOfMonth` asks the calendar instead.
 */
export function heatRangeFor(heatRange: HeatRange, today: string): DateRange {
  return heatRange === "7d"
    ? rangeForPreset("7d", today)
    : { from: startOfMonth(today), to: endOfMonth(today) };
}
