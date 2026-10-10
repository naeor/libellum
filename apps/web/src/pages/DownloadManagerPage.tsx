import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { GearIcon } from "../components/Icons.js";
import { InnerPage } from "../components/Layouts.js";
import { useOfflineFillStatus } from "../lib/offline/fillContext.js";
import {
  cacheFootprint,
  forgetAllMonths,
  forgetStaleEntries,
  monthRows,
  readNeverMonths,
  storedMonthsIn,
  type CacheFootprint,
  type MonthRow,
} from "../lib/offline/downloadManager.js";
import { clearOfflineLog, logOffline, logTime, readOfflineLog, type LogEntry } from "../lib/offline/diagnostics.js";
import { readLocalTransactions } from "../lib/offline/localLedger.js";
import {
  canStoreOffline,
  formatBytes,
  requestPersistentStorage,
  storageBreakdown,
  type StorageBreakdown,
} from "../lib/offline/persistence.js";

/**
 * The download manager: what is on this device, month by month.
 *
 * The owner asked for this, and then asked for a second pass at it: "UI 界面完全保留
 * 永不下载和删除已下载也不太好看，建议每个月份右面显示一个齿轮图标……点击齿轮图标后会跳转
 * 到月份下载管理界面". He was right, and for a reason worth stating: two
 * destructive-looking controls beside each of sixty rows was ugly, but the deeper
 * problem is that **the two interact** — deleting a month that is still set to
 * download means it comes back — and that relationship is invisible when the
 * controls are separate buttons on a list.
 *
 * So this screen now only **states facts** and offers one way in. The decisions live
 * on the month's own screen, next to a description of what the month currently is.
 */
export function DownloadManagerPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { fill } = useOfflineFillStatus();

  const [rows, setRows] = useState<readonly MonthRow[]>([]);
  const [usage, setUsage] = useState<number | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<readonly LogEntry[]>([]);
  const [footprint, setFootprint] = useState<CacheFootprint | null>(null);
  const [storage, setStorage] = useState<StorageBreakdown | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const [transactions, never, report] = await Promise.all([
        readLocalTransactions(),
        readNeverMonths(),
        storageBreakdown(),
      ]);

      /**
       * ⚠️ **`storedMonths()` decides "已下载", not the entry count.**
       *
       * A month can be downloaded and empty — nothing was spent that month — and
       * calling it "未下载" would invite the user to fetch something that will never
       * have anything in it. See `monthRows`.
       */
      /**
       * ⚠️ **Asked of the live query client, not the stored blob.** The blob says what
       * was saved at some point; memory is what the app is actually using, and memory is
       * what gets written over the blob next. See `storedMonthsIn`.
       */
      const stored = storedMonthsIn(queryClient);

      setRows(monthRows(transactions, never, stored, new Date()));
      setUsage(report.totalBytes);
      setStorage(report);
      setLog(await readOfflineLog());
      setFootprint(await cacheFootprint(queryClient));
    } catch {
      setError("读取本机数据时出错了。");
    } finally {
      setLoading(false);
    }
  }, [queryClient]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void requestPersistentStorage().then(setPersisted);
  }, []);

  // Reload when a fill finishes, so the list shows what it brought back.
  const fillDone = fill?.done ?? 0;
  const fillRunning = fill?.running ?? false;
  useEffect(() => {
    if (!fillRunning && fillDone > 0) void load();
  }, [fillRunning, fillDone, load]);

  const storedCount = rows.filter((row) => row.state === "stored").length;
  const missingCount = rows.filter((row) => row.state === "missing").length;

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

      {/*
        ⚠️ **Moved here from every screen**, as the owner asked: "把这个弹窗挪到下载管理
        界面以及下载管理的每个子界面." See `MonthDownloadPage` for the reasoning — a
        warning that follows the user everywhere stops being read.
      */}
      {persisted === false ? (
        <Alert tone="info">
          ⚠️ 浏览器没有承诺长期保留这些数据，长期不使用可能被清除。保持在 Wi-Fi
          下打开应用可以让它继续保留。
        </Alert>
      ) : null}

      <section className="flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3 text-sm">
        <p className="text-ink">
          已下载 <span className="font-medium">{storedCount}</span> 个月
          {missingCount === 0 ? "，全部月份都已下载" : `，还有 ${String(missingCount)} 个月没有下载`}
          {usage === null ? "" : `；本机共占用 ${formatBytes(usage)}`}
        </p>

        {/*
          ⚠️ **Why the stored cache is bigger than the months it holds.**

          The owner watched the figure climb across several rounds — "每次下载全部，占用的
          空间都会增加" — and there was nothing on screen to explain it, so the reasonable
          reading was that each download stacked more data on top of the last.

          Part of it was real, and part of it was **entries for query keys this version no
          longer reads**: when the key shape changed, the old entries stayed. They are
          invisible, never read again, and counted in the total. Showing the breakdown is
          what makes the number understandable; the button is what makes it fixable.
        */}
        {/*
          ⚠️ **The breakdown of the whole origin, not just our cache.**

          He saw 52.5 MB used against a 127 KB query cache — four hundred times the
          difference — and nothing on screen could explain it. Most of that figure is the
          browser's own accounting: the app shell, and data Chrome counts before writing it
          to disk. Saying so is better than letting the ledger take the blame.
        */}
        {storage === null ? null : (
          <p className="text-xs text-muted">
            占用构成：账本数据 {formatBytes(storage.queryCacheBytes)} · 应用本体{" "}
            {formatBytes(storage.shellCacheBytes)} · 运行记录 {formatBytes(storage.diagnosticsBytes)} ·
            浏览器其它 {formatBytes(storage.otherBytes)}
          </p>
        )}

        {footprint === null ? null : (
          <p className="text-xs text-muted">
            存储明细：缓存 {formatBytes(footprint.cacheBytes)}，其中{" "}
            {String(footprint.liveQueryCount)}/{String(footprint.queryCount)} 条是当前版本会读的
            {footprint.queryCount > footprint.liveQueryCount ? (
              <>
                {"；"}
                <button
                  type="button"
                  onClick={() => {
                    void forgetStaleEntries().then(() => load());
                  }}
                  className="underline"
                >
                  清理 {String(footprint.queryCount - footprint.liveQueryCount)} 条无效记录
                </button>
              </>
            ) : (
              "，没有多余的记录。"
            )}
          </p>
        )}

        {/*
          ⚠️ **The heaviest stored entries, measured rather than guessed.**
          
          The owner reported 44.5 MB on a ledger whose sixty months amount to roughly 2 MB
          of JSON. Explaining a five-fold difference needed looking inside the blob, and
          there was no way to do that — so every theory about it would have been another
          round of reasoning instead of measuring, which is the mistake this whole phase
          was about.
          
          If these lines are months, the figure is real data. If they are something else,
          that is the answer.
        */}
        {footprint === null || footprint.heaviest.length === 0 ? null : (
          <ul className="flex flex-col gap-0.5 text-[11px] text-muted">
            {footprint.heaviest.map((entry) => (
              <li key={entry.label} className="flex justify-between gap-3">
                <span className="min-w-0 truncate font-mono">{entry.label}</span>
                <span className="shrink-0">{formatBytes(entry.bytes)}</span>
              </li>
            ))}
          </ul>
        )}

        {fillRunning ? (
          <p className="text-xs text-muted">
            正在下载（{fill?.done ?? 0}/{fill?.total ?? 0} 个月）…可以离开这一页，下载会在后台继续。
          </p>
        ) : (
          <Button
            onClick={() => {
              /**
               * ⚠️ **This button used to do nothing, and the reason mattered.**
               *
               * The automatic fill skips itself on a metered connection — correct for
               * a download nobody asked for — and the same check applied to this
               * press, so the button silently did nothing while looking available.
               * An explicit call to `start()` now bypasses that check, because
               * somebody who pressed a button **has** asked.
               */
              void fill?.start(undefined, true);
            }}
            disabled={fill === null}
          >
            下载全部
          </Button>
        )}

        <p className="text-xs text-muted">
          只会在 Wi-Fi 下自动下载；用流量时会跳过，避免悄悄消耗你的流量。
        </p>

        {/*
          The owner asked for this beside "下载全部": "可以在下载管理的主页'下载全部'按钮下面
          加一个删除全部按钮，这个按钮用红底."

          ⚠️ **It goes through the query client rather than editing storage.** Clearing the
          stored blob alone leaves the months in memory, and the persister writes memory
          back a moment later — the bug that took two rounds to find, where a deletion
          looked successful and undid itself.

          Behind a confirmation, because it is the one action here that cannot be undone
          without downloading everything again.
        */}
        <Button
          variant="danger"
          disabled={fillRunning || storedCount === 0}
          onClick={() => {
            const cleared = forgetAllMonths(queryClient);
            void logOffline("删除全部", `清除了 ${String(cleared)} 个月`);
            void load();
          }}
        >
          删除全部已下载数据
        </Button>

        <p className="text-xs text-muted">
          「删除全部」会清空这台设备上的所有月份；需要时再点「下载全部」重新取回。
        </p>
      </section>

      {/*
        ⚠️ **The evidence panel.**
        
        Three rounds of reading the code produced three plausible defects and the
        symptom survived each time. What was missing was a record of what actually
        happened on the phone — so the fill writes one down, and this shows it. It is
        here rather than in a developer tool because the person who can reproduce the
        problem is the person holding the phone.
      */}
      <details className="rounded-card border border-line bg-surface px-4 py-3">
        <summary className="cursor-pointer text-sm text-ink">
          下载记录（{log.length} 条）
        </summary>

        {log.length === 0 ? (
          <p className="pt-2 text-xs text-muted">
            还没有记录。刷新页面后应该会出现「自动下载」一行。
          </p>
        ) : (
          <ul className="flex flex-col gap-1 pt-2">
            {log.map((entry, index) => (
              <li key={`${String(entry.at)}-${String(index)}`} className="text-[11px] leading-relaxed">
                <span className="font-mono text-muted">{logTime(entry.at)}</span>{" "}
                <span className="text-ink">{entry.what}</span>
                {entry.detail === undefined ? null : (
                  <span className="text-muted"> — {entry.detail}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={() => {
            void clearOfflineLog().then(() => load());
          }}
          className="mt-2 text-[11px] text-muted underline"
        >
          清空记录
        </button>
      </details>

      {loading ? (
        <p className="text-sm text-muted">正在读取…</p>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-card border border-line bg-surface">
          {rows.map((row) => (
            <li key={row.month} className="border-b border-line last:border-b-0">
              <button
                type="button"
                onClick={() => void navigate(`/downloads/${row.month}`)}
                aria-label={`${row.label}的下载设置`}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm text-ink">{row.label}</span>
                  <span className="text-[11px] text-muted">
                    {row.state === "stored"
                      ? `已下载 · ${String(row.entryCount)} 笔 · ${formatBytes(row.bytes)}`
                      : row.state === "never"
                        ? "永不下载"
                        : `未下载 · 预计 ${formatBytes(row.bytes)}`}
                  </span>
                </span>

                <GearIcon className="size-4 shrink-0 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </InnerPage>
  );
}
