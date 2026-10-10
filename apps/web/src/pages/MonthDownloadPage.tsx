import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { InnerPage } from "../components/Layouts.js";
import { useOfflineFillStatus } from "../lib/offline/fillContext.js";
import {
  bytesForMonth,
  forgetMonth,
  monthLabel,
  readNeverMonths,
  setNeverMonth,
  storedMonths,
} from "../lib/offline/downloadManager.js";
import { readLocalTransactions } from "../lib/offline/localLedger.js";
import { formatBytes, requestPersistentStorage, storageReport } from "../lib/offline/persistence.js";

/**
 * One month's download settings.
 *
 * The owner's design: "每个月份右面显示一个齿轮图标，点击齿轮图标后会跳转到月份下载管理
 * 界面，其中能看到对应月份的当前下载状态，占用空间等数据，并且可以管理（开关做成明细页的
 * 支出收入那种按钮好，左侧是文字标题「联网时自动下载」，右侧是两个按钮）."
 *
 * **Why a page rather than two inline buttons.** The list had "删除已下载" and
 * "永不下载" beside every row, and he was right that it was ugly — but the deeper
 * problem is that those two controls *interact*: deleting a month that is set to
 * download for ever means it comes straight back. Putting them on one screen, next
 * to a description of what the month currently is, is what lets the relationship be
 * visible instead of surprising.
 *
 * The toggle is the spending/income switch from the entry form, deliberately: the
 * same shape for the same idea — a setting with exactly two states, where one is
 * already chosen.
 */
export function MonthDownloadPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { month = "" } = useParams<{ month: string }>();
  const { fill } = useOfflineFillStatus();

  const [stored, setStored] = useState(false);
  const [entryCount, setEntryCount] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [never, setNever] = useState(false);
  const [usage, setUsage] = useState<number | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (month === "") return;

    setLoading(true);

    try {
      const [transactions, storedSet, neverList, report] = await Promise.all([
        readLocalTransactions(),
        storedMonths(),
        readNeverMonths(),
        storageReport(),
      ]);

      setStored(storedSet.has(month));
      setEntryCount(transactions.filter((entry) => entry.occurredLocalDate.slice(0, 7) === month).length);
      setBytes(bytesForMonth(transactions, month));
      setNever(neverList.includes(month));
      setUsage(report.usageBytes);
    } catch {
      setError("读取本机数据时出错了。");
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void requestPersistentStorage().then(setPersisted);
  }, []);

  const label = monthLabel(month);
  const running = fill?.running ?? false;

  return (
    <InnerPage title={label} subtitle="这一个月的离线保存设置。" backTo="/downloads">
      {error === null ? null : <Alert tone="error">{error}</Alert>}

      {/*
        ⚠️ **The "will not be kept" warning lives here now**, not on every screen.

        The owner asked for it to be moved: "把这个弹窗挪到下载管理界面以及下载管理的每个
        子界面." He is right, and for the reason the download notice was already cut
        back — a line that follows the user everywhere stops being read. This is a
        fact about *storage*, so it belongs on the screens about storage, which are
        the two the user opens on purpose.
      */}
      {persisted === false ? (
        <Alert tone="info">
          ⚠️ 浏览器没有承诺长期保留这些数据，长期不使用可能被清除。保持在 Wi-Fi
          下打开应用可以让它继续保留。
        </Alert>
      ) : null}

      <section className="flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-4 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-muted">当前状态</span>
          <span className="text-ink">
            {loading ? "读取中…" : stored ? "已下载" : "未下载"}
          </span>
        </div>

        <div className="flex items-baseline justify-between">
          <span className="text-muted">这个月的记录</span>
          <span className="text-ink">{loading ? "…" : `${String(entryCount)} 笔`}</span>
        </div>

        <div className="flex items-baseline justify-between">
          <span className="text-muted">占用空间</span>
          <span className="text-ink">
            {loading ? "…" : stored ? formatBytes(bytes) : `预计 ${formatBytes(bytes)}`}
          </span>
        </div>

        <div className="flex items-baseline justify-between">
          <span className="text-muted">本机共占用</span>
          <span className="text-ink">{usage === null ? "…" : formatBytes(usage)}</span>
        </div>
      </section>

      {/*
        The toggle, built like the spending/income switch: a label on the left, two
        buttons on the right, one of them already chosen.
      */}
      <section className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3">
        <span className="text-sm text-ink">联网时自动下载</span>

        <span className="flex shrink-0 gap-2">
          {([true, false] as const).map((auto) => (
            <button
              key={String(auto)}
              type="button"
              aria-pressed={!never === auto}
              disabled={loading}
              onClick={() => {
                setNever(!auto);
                void setNeverMonth(month, !auto).then(() => load());
              }}
              className={`rounded-field px-4 py-2 text-sm font-medium transition ${
                !never === auto ? "bg-brand text-white" : "bg-canvas text-muted"
              }`}
            >
              {auto ? "自动下载" : "永不下载"}
            </button>
          ))}
        </span>
      </section>

      <p className="text-xs leading-relaxed text-muted">
        {never
          ? "这个月不会被自动取回。想离线看它的时候，改回「自动下载」再点下面的按钮即可。"
          : "联网时应用会自动把这个月取回到本机，离线时也能查看。"}
      </p>

      <section className="flex flex-col gap-2">
        {stored ? (
          <Button
            variant="danger"
            disabled={working || running}
            onClick={() => {
              setWorking(true);
              void forgetMonth(month)
                .then(() => load())
                .finally(() => {
                  setWorking(false);
                });
            }}
          >
            {working ? "正在删除…" : "删除这个月已下载的数据"}
          </Button>
        ) : (
          <Button
            disabled={working || running}
            onClick={() => {
              /**
               * ⚠️ **The metered check is skipped for a request the user made.**
               *
               * The automatic fill waits for Wi-Fi because it is a download nobody
               * asked for. This one *was* asked for, and silently doing nothing is
               * the worst answer — which is exactly how the "下载全部" button came
               * to look broken.
               */
              setWorking(true);
              void fill
                ?.start([month])
                .then(() => load())
                .finally(() => {
                  setWorking(false);
                });
            }}
          >
            {running ? "正在下载…" : "现在下载这个月"}
          </Button>
        )}

        <p className="text-xs leading-relaxed text-muted">
          {stored
            ? "删除后空间会真正释放。如果这个月还是「自动下载」，下次联网时它会自己回来——不想让它回来，就先改成「永不下载」。"
            : "下载这个月之后，即使没有网络也能翻看它的每一笔。"}
        </p>
      </section>

      <button
        type="button"
        onClick={() => void navigate("/downloads")}
        className="text-xs text-muted underline"
      >
        返回下载管理
      </button>
    </InnerPage>
  );
}
