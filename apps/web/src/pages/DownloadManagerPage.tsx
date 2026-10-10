import { useCallback, useEffect, useState } from "react";

import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { InnerPage } from "../components/Layouts.js";
import { useOfflineFillStatus } from "../lib/offline/fillContext.js";
import {
  forgetMonth,
  monthRows,
  readNeverMonths,
  setNeverMonth,
  storedMonths,
  type MonthRow,
} from "../lib/offline/downloadManager.js";
import { readLocalTransactions } from "../lib/offline/localLedger.js";
import { formatBytes, canStoreOffline, storageReport } from "../lib/offline/persistence.js";

/**
 * The download manager: what is on this device, month by month.
 *
 * The owner asked for exactly this, and his reasoning is the one to keep:
 * "用户可以在里面看到已经下载内容的明细，颗粒度到月就可以……并且可以控制不同月份账本的
 * 下载设置（比如删除已下载的某月账本，设置为永不下载等等）."
 *
 * **Why a month is the right unit.** The list screen is per month, the download
 * walks months, and "九月已下载" means something to a person in a way that
 * "12.4 of 20.1 MB" does not. It also needs no new data: a month's weight is
 * measured from the entries already stored for it.
 *
 * **Three states, and the third is not a gap.** `已下载` / `未下载` / `永不下载` —
 * somebody may not want five years of old months on a phone, and "do not keep this"
 * is a decision the fill respects rather than a month it keeps re-fetching.
 */
export function DownloadManagerPage(): React.JSX.Element {
  const { fill } = useOfflineFillStatus();

  const [rows, setRows] = useState<readonly MonthRow[]>([]);
  const [usage, setUsage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyMonth, setBusyMonth] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const [transactions, never, stored, report] = await Promise.all([
        readLocalTransactions(),
        readNeverMonths(),
        storedMonths(),
        storageReport(),
      ]);

      /**
       * ⚠️ **`storedMonths()` decides "已下载", not the entry counts.**
       *
       * A month can be downloaded and empty — nothing was spent that month — and
       * calling it "未下载" would invite the user to fetch something that will never
       * have anything in it. Whether a month has been fetched is a fact about the
       * cache; how many entries it holds is a fact about the ledger.
       */
      const withStored = monthRows(transactions, never, new Date()).map((row) => {
        if (stored.has(row.month)) return { ...row, state: "stored" as const, bytesEstimated: false };
        if (row.state === "never") return row;

        return row;
      });

      setRows(withStored);
      setUsage(report.usageBytes);
    } catch {
      setError("读取本机数据时出错了。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const storedCount = rows.filter((row) => row.state === "stored").length;

  return (
    <InnerPage
      title="下载管理"
      subtitle="这些记录存在这台设备上，离线时也能查看。"
      backTo="/me"
    >
      {error === null ? null : <Alert tone="error">{error}</Alert>}

      {canStoreOffline() ? null : (
        <Alert tone="info">这个浏览器不支持本机存储，离线时无法查看记录。</Alert>
      )}

      <section className="flex flex-col gap-2 rounded-card border border-line bg-surface px-4 py-3 text-sm">
        <p className="text-ink">
          已下载 <span className="font-medium">{storedCount}</span> 个月，共 {rows.length} 个月
          {usage === null ? "" : `；本机共占用 ${formatBytes(usage)}`}
        </p>

        {fill?.running === true ? (
          <p className="text-xs text-muted">
            正在下载（{fill.done}/{fill.total} 个月）…可以离开这一页，下载会在后台继续。
          </p>
        ) : (
          <Button
            onClick={() => {
              void fill?.start();
            }}
            disabled={fill === null || fill.running}
          >
            把缺的月份下载下来
          </Button>
        )}

        <p className="text-xs text-muted">
          下载只会在 Wi-Fi 下自动进行；用流量时会跳过，避免悄悄消耗你的流量。
        </p>
      </section>

      {loading ? (
        <p className="text-sm text-muted">正在读取…</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li
              key={row.month}
              className="flex items-start justify-between gap-3 border-b border-line py-3 last:border-b-0"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-sm text-ink">
                  {row.label}
                  <span
                    className={`ml-2 text-[11px] ${row.state === "stored" ? "text-brand-dark" : "text-muted"}`}
                  >
                    {row.state === "stored" ? "已下载" : row.state === "never" ? "永不下载" : "未下载"}
                  </span>
                </span>

                <span className="text-[11px] text-muted">
                  {row.state === "stored"
                    ? `${String(row.entryCount)} 笔，占用 ${formatBytes(row.bytes)}`
                    : `预计 ${formatBytes(row.bytes)}`}
                </span>
              </span>

              <span className="flex shrink-0 flex-col items-end gap-1">
                {row.state === "stored" ? (
                  <button
                    type="button"
                    disabled={busyMonth === row.month}
                    onClick={() => {
                      setBusyMonth(row.month);
                      void forgetMonth(row.month)
                        .then(() => load())
                        .finally(() => {
                          setBusyMonth(null);
                        });
                    }}
                    className="text-[11px] text-danger underline"
                  >
                    删除已下载
                  </button>
                ) : null}

                {row.state === "never" ? (
                  <button
                    type="button"
                    onClick={() => {
                      void setNeverMonth(row.month, false).then(() => load());
                    }}
                    className="text-[11px] text-brand-dark underline"
                  >
                    改为下载
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      void setNeverMonth(row.month, true).then(() => load());
                    }}
                    className="text-[11px] text-muted underline"
                  >
                    永不下载
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-muted">
        删除后如果还想看，把「永不下载」改回「下载」再点上面的按钮就可以重新取回。
      </p>
    </InnerPage>
  );
}
