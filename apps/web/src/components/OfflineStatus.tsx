import { useEffect, useMemo, useState } from "react";

import { useOfflineFillStatus } from "../lib/offline/fillContext.js";
import { formatBytes, requestPersistentStorage, storageReport } from "../lib/offline/persistence.js";

/**
 * The download notice: while it is happening, and for ten seconds after.
 *
 * ⚠️ **It used to be permanent**, and the owner was right that this was wrong on
 * two counts: "不仅不太美观，用户平时也可能看不见" — a bar that is always there stops
 * being read, so the one time it matters it is invisible. His design is a notice
 * that appears when there is news, lingers briefly so it can be read, and then gets
 * out of the way, with the details living somewhere the user chooses to look.
 *
 * So:
 *
 *  * **while downloading** it stays, on every screen, with the month count;
 *  * **for ten seconds after finishing** it stays, showing what was stored;
 *  * then it withdraws;
 *  * and it says where the detail is — the download manager on the account screen.
 *
 * A failure is the exception: "the browser will not keep this" is not news that
 * expires, so that line stays until it is no longer true.
 *
 * It **reads** the fill rather than starting one — see `OfflineFillProvider` — and
 * takes whether anybody is signed in from that provider rather than from the auth
 * context, because a line about storage has no business requiring an `AuthProvider`.
 */
const LINGER_MS = 10_000;

export function OfflineStatus(): React.JSX.Element | null {
  const { fill, ready } = useOfflineFillStatus();

  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<number | null>(null);

  /**
   * Whether the finishing summary is still on screen.
   *
   * Held separately from the fill's own state because the fill is finished the
   * moment it is finished, and this is about how long the *news* stays. Copying
   * "done" into a second piece of state would be the bug where the bar never goes
   * away because something keeps re-setting it.
   */
  const [lingering, setLingering] = useState(false);

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

  const running = fill?.running ?? false;

  /**
   * ⚠️ **Counted from the moment it stops running**, not from a mount.
   *
   * A timer started when the component first rendered would withdraw the notice
   * while the download was still going — the one thing it exists to show. The
   * effect depends on `running`, so each transition into "finished" starts its own
   * ten seconds.
   */
  useEffect(() => {
    if (!running) return;

    // Downloading again: the summary from the last run is no longer the news.
    setLingering(false);

    return undefined;
  }, [running]);

  useEffect(() => {
    const stopped = fill?.stopped ?? null;
    const done = fill?.done ?? 0;

    if (running || (done === 0 && stopped === null) || fill?.skippedMetered === true) return;

    setLingering(true);
    const timer = window.setTimeout(() => {
      setLingering(false);
    }, LINGER_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [running, fill?.done, fill?.stopped, fill?.skippedMetered]);

  /**
   * ⚠️ **The "the browser will not keep this" line used to live here, and no
   * longer does.** The owner asked for it to move: "把这个弹窗挪到下载管理界面以及下载
   * 管理的每个子界面." He is right, and for the same reason the download notice itself
   * was cut back — a warning that follows the user everywhere stops being read. It is
   * a fact about storage, so it belongs where storage is the subject.
   */

  const visible = useMemo(() => {
    if (fill === null) return false;
    if (running || lingering) return true;

    return fill.skippedMetered;
  }, [fill, running, lingering]);

  if (!ready || fill === null || !visible) return null;

  return (
    <div
      role="status"
      className="flex flex-col gap-0.5 border-b border-line bg-canvas px-5 py-2 text-[11px] leading-relaxed text-muted"
    >
      {running ? (
        <>
          <p>
            正在把历史记录存到本机，离线时也能查看（{fill.done}/{fill.total} 个月）…
          </p>
          <p>可以在「账户 → 下载管理」里查看和调整。</p>
        </>
      ) : null}

      {!running && lingering && fill.stopped === null ? (
        <>
          <p>
            历史记录已存到本机（{fill.total} 个月
            {usage === null ? "" : `，占用 ${formatBytes(usage)}`}），离线时也能查看。
          </p>
          <p>可以在「账户 → 下载管理」里查看和调整。</p>
        </>
      ) : null}

      {!running && lingering && fill.stopped !== null ? <p>{fill.stopped}</p> : null}

      {fill.skippedMetered ? (
        <p>当前是流量网络，暂时没有下载历史记录。连上 Wi-Fi 后会自动继续。</p>
      ) : null}
    </div>
  );
}
