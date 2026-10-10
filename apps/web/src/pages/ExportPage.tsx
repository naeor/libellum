import { CURRENCIES, type Currency, type ExportFormat } from "@libellum/shared";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { InnerPage } from "../components/Layouts.js";
import { useAuth } from "../auth/AuthProvider.js";
import { errorMessage } from "../lib/api.js";
import { currentMonth, formatMonthLabel, shiftMonth } from "../lib/datetime.js";
import { currencyName } from "../lib/format.js";
import { fetchExport, fetchTemplate, useExportLog, useLedger } from "../lib/queries.js";
import { canShareFiles, deliverFile, toFile } from "../lib/share.js";

/**
 * Export the ledger.
 *
 * The owner's design: the tool button on the detail screen leads here, the user
 * chooses what to take, and pressing 导出 hands the file over — **the share
 * sheet on an iPhone, an ordinary download everywhere else**. That difference is
 * not cosmetic. iOS has no downloads folder to speak of; a saved blob is a dead
 * end, whereas the share sheet offers 存储到文件, AirDrop and the rest.
 *
 * The screen is deliberately one page with no sub-dialogs: filters, format,
 * button. Everything on it is optional — pressing 导出 with the defaults exports
 * the whole ledger, which is the common case.
 */

type RangePreset = "all" | "thisMonth" | "lastMonth" | "last3" | "custom";

const RANGE_LABELS: Record<Exclude<RangePreset, "custom">, string> = {
  all: "全部",
  thisMonth: "本月",
  lastMonth: "上月",
  last3: "近三个月",
};

function rangeForPreset(preset: RangePreset, customFrom: string, customTo: string): {
  monthFrom?: string;
  monthTo?: string;
} {
  const thisMonth = currentMonth();

  switch (preset) {
    case "all":
      return {};
    case "thisMonth":
      return { monthFrom: thisMonth, monthTo: thisMonth };
    case "lastMonth": {
      const last = shiftMonth(thisMonth, -1);
      return { monthFrom: last, monthTo: last };
    }
    case "last3":
      return { monthFrom: shiftMonth(thisMonth, -2), monthTo: thisMonth };
    case "custom":
      return {
        ...(customFrom === "" ? {} : { monthFrom: customFrom }),
        ...(customTo === "" ? {} : { monthTo: customTo }),
      };
  }
}

/** A month input that falls back to the current month when first opened. */
function defaultMonth(offset: number): string {
  return shiftMonth(currentMonth(), offset);
}

export function ExportPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuth();
  const ledger = useLedger();
  const exportLog = useExportLog();

  const [format, setFormat] = useState<ExportFormat>("csv");
  const [range, setRange] = useState<RangePreset>("all");
  const [customFrom, setCustomFrom] = useState(defaultMonth(-1));
  const [customTo, setCustomTo] = useState(currentMonth());
  const [kind, setKind] = useState<"all" | "expense" | "income">("all");
  const [currency, setCurrency] = useState<Currency | "all">("all");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const categories = useMemo(
    () => (ledger.data?.categories ?? []).filter((category) => !category.isSystem),
    [ledger.data],
  );
  const [categoryId, setCategoryId] = useState<string>("all");

  /**
   * What the button will do, said plainly before it is pressed.
   *
   * Telling someone "this will use the share sheet" in advance is the difference
   * between a welcome surprise and a confusing one — and on a desktop it warns
   * that a file is about to appear in their downloads.
   */
  const deliveryHint = useMemo(() => {
    // A throwaway file of the same shape: `canShare` only inspects the file.
    const probe = new File([new Uint8Array(1)], "probe.csv", { type: "text/csv" });
    return canShareFiles(probe)
      ? "导出后会打开系统分享菜单，可存到「文件」、用 AirDrop 发送或发给其他应用。"
      : "导出后文件会直接下载到本机。";
  }, []);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setDone(null);

    try {
      const bounds = rangeForPreset(range, customFrom, customTo);

      const file = await fetchExport({
        format,
        ...bounds,
        ...(kind === "all" ? {} : { kind }),
        ...(currency === "all" ? {} : { currency }),
        ...(categoryId === "all" ? {} : { categoryId }),
      });

      const outcome = await deliverFile(file.fileName, file.mimeType, file.bytes);

      if (outcome.cancelled) {
        setDone("已取消。文件没有导出。");
        return;
      }

      setDone(
        outcome.method === "share"
          ? `已导出 ${String(file.rowCount)} 条记录（${file.fileRef}），并打开分享菜单。`
          : `已导出 ${String(file.rowCount)} 条记录（${file.fileRef}），文件已下载。`,
      );
      void exportLog.refetch();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function downloadTemplate(): Promise<void> {
    setBusy(true);
    setError(null);
    setDone(null);

    try {
      const file = await fetchTemplate();
      const outcome = await deliverFile(file.fileName, file.mimeType, file.bytes);
      if (!outcome.cancelled) setDone("模板已导出，可在表头下逐行填写。");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <InnerPage
      title="导出账目"
      subtitle="选择要导出的范围与格式。导出的文件会带一个编号，日后可以对照。"
      backTo="/"
    >
      {error === null ? null : <Alert>{error}</Alert>}
      {done === null ? null : <Alert tone="success">{done}</Alert>}

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <h2 className="text-xs text-muted">时间范围</h2>

        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(RANGE_LABELS) as Exclude<RangePreset, "custom">[]).map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={range === preset}
              onClick={() => {
                setRange(preset);
              }}
              className={`rounded-field px-4 py-3 text-sm transition ${
                range === preset ? "bg-brand text-white" : "bg-brand-soft text-brand-dark"
              }`}
            >
              {RANGE_LABELS[preset]}
            </button>
          ))}

          <button
            type="button"
            aria-pressed={range === "custom"}
            onClick={() => {
              setRange("custom");
            }}
            className={`col-span-2 rounded-field px-4 py-3 text-sm transition ${
              range === "custom" ? "bg-brand text-white" : "bg-brand-soft text-brand-dark"
            }`}
          >
            自定义月份
          </button>
        </div>

        {range === "custom" ? (
          <div className="flex items-center gap-3">
            <label className="flex-1">
              <span className="sr-only">起始月份</span>
              <input
                type="month"
                value={customFrom}
                onChange={(event) => {
                  setCustomFrom(event.target.value);
                }}
                className="w-full rounded-field border border-line bg-surface px-3 py-3 text-[16px] text-ink"
              />
            </label>
            <span className="text-sm text-muted">至</span>
            <label className="flex-1">
              <span className="sr-only">结束月份</span>
              <input
                type="month"
                value={customTo}
                onChange={(event) => {
                  setCustomTo(event.target.value);
                }}
                className="w-full rounded-field border border-line bg-surface px-3 py-3 text-[16px] text-ink"
              />
            </label>
          </div>
        ) : null}

        <p className="text-xs leading-relaxed text-muted">
          当前选择：{range === "custom"
            ? `${formatMonthLabel(customFrom)} 至 ${formatMonthLabel(customTo)}`
            : range === "all"
              ? "全部记录"
              : RANGE_LABELS[range]}
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <h2 className="text-xs text-muted">文件格式</h2>

        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["csv", "CSV", "任何表格软件都能打开，导入也用这个格式"],
              ["xlsx", "Excel", "Excel / WPS 可直接打开，金额是数字可求和"],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              aria-pressed={format === value}
              onClick={() => {
                setFormat(value);
              }}
              className={`flex flex-col items-start gap-1 rounded-field px-4 py-3 text-left transition ${
                format === value ? "bg-brand text-white" : "bg-brand-soft text-brand-dark"
              }`}
            >
              <span className="text-sm font-medium">{label}</span>
              <span className={`text-xs leading-snug ${format === value ? "text-white/80" : "text-brand-dark/70"}`}>
                {hint}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <h2 className="text-xs text-muted">筛选（可不选）</h2>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink">收支类型</span>
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as typeof kind);
            }}
            className="rounded-field border border-line bg-surface px-3 py-3 text-[16px] text-ink"
          >
            <option value="all">支出和收入</option>
            <option value="expense">只看支出</option>
            <option value="income">只看收入</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink">币种</span>
          <select
            value={currency}
            onChange={(event) => {
              setCurrency(event.target.value as typeof currency);
            }}
            className="rounded-field border border-line bg-surface px-3 py-3 text-[16px] text-ink"
          >
            <option value="all">全部币种</option>
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {currencyName(code)}（{code}）
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink">分类</span>
          <select
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
            }}
            className="rounded-field border border-line bg-surface px-3 py-3 text-[16px] text-ink"
          >
            <option value="all">全部分类</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.kind === "expense" ? "支出" : "收入"} · {category.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <Button
          onClick={() => {
            void run();
          }}
          disabled={busy || ledger.isLoading}
        >
          {busy ? "正在准备…" : "导出"}
        </Button>

        <p className="text-xs leading-relaxed text-muted">{deliveryHint}</p>

        <Button
          variant="secondary"
          onClick={() => {
            void downloadTemplate();
          }}
          disabled={busy}
        >
          下载导入模板
        </Button>
        <p className="text-xs leading-relaxed text-muted">
          模板只有表头，没有数据。它和导出的文件是同一套列，可以在里面逐行填写。
        </p>

        <Button
          variant="ghost"
          onClick={() => {
            void navigate("/import");
          }}
        >
          导入历史账 →
        </Button>
      </section>

      {/* ------------------------------------------------------------------ */}
      {(exportLog.data?.entries.length ?? 0) > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs text-muted">导出记录</h2>
          <p className="text-xs leading-relaxed text-muted">
            只记录谁在什么时候导出了多少条，不保存导出的内容。
          </p>

          <ul className="overflow-hidden rounded-field border border-line bg-surface">
            {exportLog.data?.entries.slice(0, 5).map((entry) => (
              <li
                key={entry.fileRef}
                className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <span className="font-mono text-xs text-ink">{entry.fileRef}</span>
                <span className="text-xs text-muted">
                  {entry.format.toUpperCase()} · {String(entry.rowCount)} 条 ·{" "}
                  {new Date(entry.createdAt).toLocaleDateString("zh-CN")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-xs leading-relaxed text-muted">
        导出默认币种：{currencyName(user?.defaultCurrency ?? "CNY")}。不同币种分开统计，不做汇率换算。
      </p>
    </InnerPage>
  );
}
