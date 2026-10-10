import { useEffect, useMemo, useState } from "react";

import { useOfflineFillStatus } from "../lib/offline/fillContext.js";
import {
  canStoreOffline,
  formatBytes,
  requestPersistentStorage,
  storageReport,
} from "../lib/offline/persistence.js";

/**
 * A quiet line about what this device has, and what it is still fetching.
 *
 * ⚠️ **It exists because "offline doesn't work" was partly true and could not be
 * seen.** The detail screen loads one month at a time, so only the months somebody
 * had opened were ever available without a network. The owner found exactly that on
 * a plane — "曾经打开过的数据" and nothing else — and there was nothing on screen to
 * explain it or to show it being fixed. A fill that runs invisibly leaves the user
 * unable to tell "still downloading" from "not supported".
 *
 * **Only shown when it has something to say.** A permanent "offline ready" badge
 * would be noise on a screen whose job is somebody's spending. It appears while
 * history is still being fetched, when the browser is on a metered connection and
 * the download has been left alone, and when the browser has declined to keep
 * anything — that last one because it is a fact worth learning here rather than on
 * a plane.
 *
 * It **reads** the fill rather than starting one, and reads the session's state from
 * the provider rather than from the auth context — this line is rendered by
 * `TabPage`, which screens render directly, and a component about storage has no
 * business requiring an `AuthProvider` to exist.
 */
export function OfflineStatus(): React.JSX.Element | null {
  const { fill, ready } = useOfflineFillStatus();

  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<number | null>(null);

  useEffect(() => {
    if (!ready) return;

    let cancelled = false;

    void (async () => {
      await requestPersistentStorage();
      const report = await storageReport();
      if (cancelled) return;

      setPersisted(report.persisted);
      setUsage(report.usageBytes);
    })();

    return () => {
      cancelled = true;
    };
  }, [ready]);

  /**
   * Whether there is anything worth a line.
   *
   * Computed before the early return so the component has one exit rather than
   * three, and so the condition reads as one sentence: "say something when work is
   * happening, when work stopped early, when it was skipped, or when something is
   * already stored and the browser has not promised to keep it".
   */
  const worthSaying = useMemo(() => {
    if (fill === null) return false;
    if (fill.running || fill.stopped !== null || fill.skippedMetered) return true;

    return fill.done > 0;
  }, [fill]);

  if (!ready || fill === null || !canStoreOffline() || !worthSaying) return null;

  return (
    <div
      role="status"
      className="flex flex-col gap-1 border-b border-line bg-canvas px-5 py-2 text-[11px] leading-relaxed text-muted"
    >
      {fill.running ? (
        <p>
          正在把历史记录存到本机，离线时也能查看（{fill.done}/{fill.total} 个月）…
        </p>
      ) : null}

      {fill.skippedMetered ? (
        <p>当前是流量网络，暂时没有下载历史记录。连上 Wi-Fi 后会自动继续。</p>
      ) : null}

      {fill.stopped === null ? null : <p>{fill.stopped}</p>}

      {fill.done > 0 && !fill.running ? (
        <p>
          历史记录已存到本机（{fill.total} 个月
          {usage === null ? "" : `，占用 ${formatBytes(usage)}`}）
          {persisted === false ? "。⚠️ 浏览器未承诺长期保留，长期不使用可能被清除。" : "。"}
        </p>
      ) : null}
    </div>
  );
}
