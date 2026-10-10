import { useEffect, useState } from "react";

import { useOfflineFillStatus } from "../lib/offline/fillContext.js";

/**
 * The download notice: while it is happening, and for ten seconds after.
 *
 * ⚠️ **Two corrections from the owner, and both were my mistakes.**
 *
 * **It used to appear again on every screen.** The ten seconds were owned by this
 * component, so every mount started a fresh countdown: open the ledger, see the
 * notice; go to the analysis screen, see it again; come back, see it again. He
 * described it exactly — "会在每一次打开账户和分析页面时出现，十秒后消失".
 *
 * The window belongs to the **download**, not to whoever happens to be looking at it,
 * so it is now computed from the moment the fill finished: "less than ten seconds
 * ago" is true on every screen at once and false on every screen at once.
 *
 * **And it was not on every screen.** He asked for it "在明细，分析，账户等所有页面都作为
 * 上方弹窗出现" — which is what `TabPage` already gave it, except that the timer bug
 * made it look like something else. With the timestamp it now behaves as he described:
 * a strip at the top of whatever page is open, for ten seconds, once.
 *
 * A failure is the exception: a fill that stopped early says so for the whole ten
 * seconds, because the user needs to know the month list is incomplete.
 *
 * It **reads** the fill rather than starting one — see `OfflineFillProvider` — and
 * takes whether anybody is signed in from that provider rather than from the auth
 * context, because a line about storage has no business requiring an `AuthProvider`.
 */
const LINGER_MS = 10_000;

export function OfflineStatus(): React.JSX.Element | null {
  const { fill, ready } = useOfflineFillStatus();

  /**
   * A ticking clock, so the strip disappears on its own.
   *
   * One interval for the whole component rather than a timeout per render: the state
   * it produces is exactly "what time is it", and every screen derives the same
   * answer from the same timestamp. When the window closes, `now` moves past it and
   * the strip stops rendering — no cleanup to get wrong, and nothing to reset.
   */
  const [now, setNow] = useState(() => Date.now());

  const running = fill?.running ?? false;
  const justFinishedAt = fill?.justFinishedAt ?? null;

  useEffect(() => {
    if (running || justFinishedAt === null) return;

    // Nothing to count down any more.
    if (Date.now() - justFinishedAt >= LINGER_MS) return;

    setNow(Date.now());

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 500);

    return () => {
      window.clearInterval(timer);
    };
  }, [running, justFinishedAt]);

  if (!ready || fill === null) return null;

  /**
   * ⚠️ **Derived, not stored.** A `lingering` boolean would be a second copy of the
   * same fact, and it would be the copy that goes stale — which is how the notice came
   * to reappear on every screen in the first place.
   */
  const lingering = !running && justFinishedAt !== null && now - justFinishedAt < LINGER_MS;
  const visible = running || lingering || fill.skippedMetered;

  if (!visible) return null;

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

      {lingering && fill.stopped === null ? (
        <>
          <p>
            历史记录已存到本机（{fill.total} 个月），离线时也能查看。
          </p>
          <p>可以在「账户 → 下载管理」里查看和调整。</p>
        </>
      ) : null}

      {lingering && fill.stopped !== null ? <p>{fill.stopped}</p> : null}

      {!running && !lingering && fill.skippedMetered ? (
        <p>当前是流量网络，暂时没有下载历史记录。连上 Wi-Fi 后会自动继续。</p>
      ) : null}
    </div>
  );
}
