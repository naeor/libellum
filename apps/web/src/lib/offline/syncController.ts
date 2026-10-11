import { logOffline } from "./diagnostics.js";
import { drainOutbox, pendingIds, refreshPending } from "./write.js";

/**
 * When the device tries to deliver what it is holding.
 *
 * ⚠️ **This file exists because the queue had no one to drain it, and the owner found the symptom before the
 * cause**: "如果你确定已经给每个账单都已经赋予了特殊的变量。那样的话，你可以设计一个每次连上网的时候立刻
 * 核对一遍所有的账单，然后发现变量为零时，就把它上传到服务器上，然后把它的变量改成一，这样可以吗？"
 *
 * **The answer was yes, and the gap was worse than a design preference**: `drainOutbox` was written and
 * **never called from anywhere**, and nothing listened for the network coming back. **So a queued entry was
 * delivered only if the user happened to record something else while online** — which is why unsynced rows
 * accumulated and the pale red never went away, and why writing a new entry made old ones look wrong: they
 * genuinely were still waiting, and nobody was ever going to send them.
 *
 * ⚠️ **"Do it when the network comes back" is not enough on its own, and the owner's phrasing has the better
 * shape**: he asked for a **check**, not a retry. So there are four moments, and between them a device that
 * was offline gets emptied without the user doing anything:
 *
 * | Moment | Why it is needed |
 * |---|---|
 * | `online` fires | the network came back — the case he named |
 * | comes back to the foreground | a phone that was asleep never sees an event |
 * | the app starts | a reload with a queue already on disk |
 * | after a local write | the entry goes straight up if the server is reachable |
 *
 * ⚠️ **Foreground matters more than `online` on a phone.** A suspended page misses the event entirely, so a
 * design that only listens for `online` leaves a device that was locked overnight still holding its queue.
 */
export function startSyncTriggers(): () => void {
  if (typeof window === "undefined") return () => undefined;

  /**
   * ⚠️ **Guarded against running twice at once.** `online` and `visibilitychange` often fire together when a
   * phone wakes, and two concurrent drains would deliver the same entries and race on the queue file.
   */
  let running = false;

  const run = (reason: string): void => {
    if (running) return;

    running = true;

    void (async () => {
      try {
        /**
         * ⚠️ **Nothing is sent when the browser says the device is offline** — but that is a *hint*, not a
         * permission. The drain itself decides what succeeded, and a wrong hint costs one wasted request
         * rather than a delivery that never happens.
         */
        const delivered = await drainOutbox();

        if (delivered > 0) await logOffline("DIAGNOSTIC:sync", `${reason}：投递 ${String(delivered)} 条`);

        /**
         * ⚠️ **Republished even when nothing was delivered.** A stale colour is the symptom being fixed here,
         * so the colour is refreshed on every trigger rather than only when the queue changed — **a warning
         * that outlives its reason is the whole bug.**
         */
        await refreshPending();
      } finally {
        running = false;
      }
    })();
  };

  const onOnline = (): void => run("网络恢复");
  const onVisible = (): void => {
    if (document.visibilityState === "visible") run("回到前台");
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);

  /**
   * ⚠️ **On start-up too.** A reload with a queue on disk is the same situation as a network returning, and
   * **the user should never have to do something to make their own entries reach the server.**
   */
  run("启动");

  return () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/**
 * How many entries are waiting to be delivered.
 *
 * ⚠️ **Counted from the queue rather than from a stored flag**, so it cannot disagree with what will actually
 * be sent — see `pendingIds` in `write.ts` for why there is only one copy of this fact.
 */
export async function pendingCount(): Promise<number> {
  return (await pendingIds()).size;
}
