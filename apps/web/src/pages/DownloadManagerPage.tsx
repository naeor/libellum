import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { ChoiceDialog, type Choice } from "../components/ChoiceDialog.js";
import { GearIcon, MoreIcon } from "../components/Icons.js";
import { InnerPage } from "../components/Layouts.js";
import { logOffline } from "../lib/offline/diagnostics.js";
import {
  forgetAllMonths,
  monthRows,
  readNeverMonths,
  storedMonthsIn,
  type MonthRow,
} from "../lib/offline/downloadManager.js";
import { isMeteredConnection } from "../lib/offline/fill.js";
import { useOfflineFillStatus } from "../lib/offline/fillContext.js";
import { readLocalTransactions } from "../lib/offline/localLedger.js";
import { canStoreOffline, formatBytes, requestPersistentStorage } from "../lib/offline/persistence.js";

/**
 * The download manager: what is on this device, month by month.
 *
 * ⚠️ **The diagnostics moved out of here, at the owner's request**: "把下载记录和存储明细……
 * 都不显示在下载管理主页。主页右上角新增一个更多按钮（三个点图标），点击之后会进入'下载管理
 * -更多'页面." The log and the storage breakdown answer a question most people do not have, and
 * they were the largest thing on a screen whose subject is which months are available offline.
 *
 * **And the two explanatory paragraphs went too**: "我觉得大部分用户应该还是能看懂这俩按钮的."
 * He is right. 下载全部 above 删除全部已下载数据 does not need a sentence under each saying what it
 * does, and sentences nobody needs are sentences nobody reads — including the ones that matter.
 *
 * The list states facts and offers one way in: a gear per month. The decisions live on the
 * month's own screen, next to a description of what that month currently is, because the two
 * controls interact — deleting a month still set to download brings it straight back — and
 * that relationship is invisible when they are separate buttons on a list.
 */
export function DownloadManagerPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { fill } = useOfflineFillStatus();

  const [rows, setRows] = useState<readonly MonthRow[]>([]);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmCellular, setConfirmCellular] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const [transactions, never] = await Promise.all([readLocalTransactions(), readNeverMonths()]);

      /**
       * ⚠️ **Asked of the live query client, not the stored blob.** The blob says what was
       * saved at some point; memory is what the app is using, and memory is what gets written
       * over the blob next. See `storedMonthsIn`.
       */
      setRows(monthRows(transactions, never, storedMonthsIn(queryClient), new Date()));
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

  /**
   * What a full download is likely to cost, from the months already here.
   *
   * Measured rather than guessed, and it is the number the confirmation needs: "this will use
   * about 180 KB" is a decision somebody can make, where "continue?" is a prompt with nothing
   * in it.
   */
  const estimatedBytes = rows
    .filter((row) => row.state === "missing")
    .reduce((total, row) => total + row.bytes, 0);

  return (
    <InnerPage
      title="下载管理"
      subtitle="这些记录存在这台设备上，离线时也能查看。"
      backTo="/me"
      actions={
        <button
          type="button"
          onClick={() => void navigate("/downloads/more")}
          aria-label="更多"
          className="rounded-field p-2.5 text-muted transition hover:bg-brand-soft hover:text-ink"
        >
          <MoreIcon className="size-5" />
        </button>
      }
    >
      {error === null ? null : <Alert tone="error">{error}</Alert>}

      {canStoreOffline() ? null : (
        <Alert tone="info">这个浏览器不支持本机存储，离线时无法查看记录。</Alert>
      )}

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
        </p>

        {fillRunning ? (
          <p className="text-helper text-muted">
            正在下载（{fill?.done ?? 0}/{fill?.total ?? 0} 个月）…可以离开这一页，下载会在后台继续。
          </p>
        ) : (
          <Button
            onClick={() => {
              /**
               * ⚠️ **On a metered connection, ask — do not decide.**
               *
               * The owner asked for this: "如果用户正在使用流量，改成弹出弹窗提醒用户当前疑似
               * 使用流量，问是否要继续下载，并给出预估消耗多少流量."
               *
               * The earlier behaviour was worse in both directions. The automatic fill refuses
               * silently, so at home on Wi-Fi the button did nothing and looked broken; a
               * download that simply proceeds on cellular spends somebody's data without
               * asking. **A question with a number in it is the only one of the three that is
               * both honest and useful.**
               *
               * It says 疑似 because `effectiveType` is the browser's estimate, and the button
               * is never blocked on the strength of an estimate.
               */
              if (isMeteredConnection()) {
                setConfirmCellular(true);
                return;
              }

              void fill?.start(undefined, true);
            }}
            disabled={fill === null}
          >
            下载全部
          </Button>
        )}

        <Button
          variant="danger"
          disabled={fillRunning || storedCount === 0}
          onClick={() => {
            /**
             * ⚠️ **Through the query client, not by editing storage.** Clearing the stored
             * blob alone leaves the months in memory, and the persister writes memory back a
             * moment later — the bug that took two rounds to find, where a deletion looked
             * successful and undid itself.
             */
            const cleared = forgetAllMonths(queryClient);
            void logOffline("删除全部", `清除了 ${String(cleared)} 个月`);
            void load();
          }}
        >
          删除全部已下载数据
        </Button>
      </section>

      <ChoiceDialog
        open={confirmCellular}
        title="当前疑似使用流量"
        description={`继续下载大约会用掉 ${formatBytes(estimatedBytes)} 流量。也可以连上 Wi-Fi 再下载。`}
        choices={CELLULAR_CHOICES}
        onChoose={(choice) => {
          setConfirmCellular(false);
          if (choice === "download") void fill?.start(undefined, true);
        }}
      />

      {loading ? (
        <p className="text-body text-muted">正在读取…</p>
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
                  <span className="text-body text-ink">{row.label}</span>
                  <span className="text-micro text-muted">
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

/**
 * What to offer when the connection looks metered.
 *
 * 继续下载 rather than a bare 确定, because the choice is between two real things — data now or
 * data later — and the labels should name them. 等连上 Wi-Fi 再下载 is the dismissive option,
 * since doing nothing is what happens if the user closes the dialog.
 */
const CELLULAR_CHOICES: readonly Choice<"download" | "wait">[] = [
  { id: "download", label: "继续下载", hint: "现在就存到本机", primary: true },
  { id: "wait", label: "等连上 Wi-Fi 再下载", dismissive: true },
];
