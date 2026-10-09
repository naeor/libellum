import {
  CURRENCIES,
  RANGE_LABELS,
  STATS_RANGES,
  averagePerDay,
  bucketForPreset,
  comparisonRangeFor,
  daysBetween,
  rangeForPreset,
  type Currency,
  type StatsRangeKey,
  type TransactionKind,
} from "@libellum/shared";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { CalendarHeatmap } from "../components/charts/CalendarHeatmap.js";
import { CategoryDonut } from "../components/charts/CategoryDonut.js";
import { ComparisonPanel, YearOverview } from "../components/charts/SummaryPanel.js";
import { TrendChart } from "../components/charts/TrendChart.js";
import { TabPage } from "../components/Layouts.js";
import { SkeletonRows } from "../components/States.js";
import { useAuth } from "../auth/AuthProvider.js";
import { errorMessage } from "../lib/api.js";
import { toLocalDate } from "../lib/datetime.js";
import { currencyName, formatMoney } from "../lib/format.js";
import { useLedger, useStats } from "../lib/queries.js";

/** The heat map's own two views: the last week, or the current month. */
const HEAT_RANGES = ["7d", "month"] as const;
type HeatRange = (typeof HEAT_RANGES)[number];

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

  const heatStart =
    heatRange === "7d" ? rangeForPreset("7d", today).from : `${today.slice(0, 7)}-01`;
  const monthEnd = `${today.slice(0, 7)}-31`;

  const main = useStats({
    ...range,
    bucket,
    currency: currencyInUse,
    compareFrom: comparison.from,
    compareTo: comparison.to,
  });

  const yearStats = useStats({ ...yearRange, bucket: "month", currency: currencyInUse });

  const heatStats = useStats({
    from: heatStart,
    to: heatRange === "7d" ? today : monthEnd,
    bucket: "day",
    currency: currencyInUse,
  });

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
    <TabPage active="stats" onNavigate={(to) => { navigate(to); }}>
      <header className="bg-brand px-6 pt-8 pb-6 text-white">
        <h1 className="text-xl font-semibold tracking-tight">分析</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-white/80">
          把账目变成看得懂的图。
        </p>
      </header>

      <section className="flex flex-col gap-3 px-6 pt-5">
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

        <p className="text-xs leading-relaxed text-muted">
          {range.from} 至 {range.to}，按{currencyName(currencyInUse)}统计。不同币种分开统计，不进行汇率换算。
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
            <TrendChart points={main.data.series} currency={currencyInUse} bucket={bucket} />
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
              monthToDate={range.to < monthEndOf(range.to)}
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
          <CalendarHeatmap days={heatStats.data.series} currency={currencyInUse} />
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

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col px-6 pt-7">
      <h2 className="mb-3 text-sm font-medium text-ink">{title}</h2>
      <div className="rounded-card border border-line bg-surface p-4">{children}</div>
    </section>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="rounded-field bg-canvas px-4 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-base font-medium tabular-nums text-ink">{value}</dd>
    </div>
  );
}

/** Last day of the month a date falls in, as a string. */
function monthEndOf(date: string): string {
  const [year, month] = date.split("-").map(Number) as [number, number];

  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
