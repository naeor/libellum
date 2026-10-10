/**
 * Try the network; use what is on the device when it does not answer.
 *
 * ⚠️ **The owner described this rule better than the code did**: "先去读网络数据，被拒绝/
 * 超过一秒没有收到数据然后直接改成用本地数据就可以了吧？"
 *
 * **He is right, and the previous version was wrong in a way that only shows on a phone.**
 * It asked `navigator.onLine` first and only used the local copy when the browser admitted
 * to being offline. But a phone reports itself online in a lift, on a train, on a captive
 * portal, and on a Wi-Fi network whose router has stopped forwarding — and in every one of
 * those cases the app would wait, fail, and show nothing, with a perfectly good copy of the
 * ledger sitting on the device.
 *
 * **The right question is not "does the browser think we are online" but "did the answer
 * arrive".** So: try the network, and on *any* failure — refused, timed out, server error —
 * read the local copy instead.
 *
 * **One second, and his reasoning is the measurement**: "一般健康的网络情况下，服务器返回的
 * 速度可能就几十毫秒". A healthy answer arrives in tens of milliseconds, so a second is
 * already an order of magnitude of slack — and the fallback is cheap, because the data is
 * already on the device. **The wait is the user's; the answer is not.**
 *
 * ⚠️ **Every attempt updates the shared connectivity state**, which is what lets the app say
 * "you are offline" on the strength of an actual failed request rather than on the browser's
 * guess — see `connectivity.ts`.
 *
 * ⚠️ **And it is logged with a unique marker**, so "was it offline or was the server
 * unhappy" is answerable from the record rather than from another round of guessing — the
 * rule the owner set out in DEVLOG §9.1.
 */
import { reportReachability } from "./connectivity.js";
import { withDeadline } from "./deadline.js";
import { logOffline } from "./diagnostics.js";

/**
 * How long to wait for the network before answering from the device.
 *
 * One second. A healthy server answers in tens of milliseconds, so this is already generous;
 * anything longer is time the user spends looking at a screen that has the answer.
 */
export const LOCAL_FALLBACK_MS = 1_000;

/** Marker used in diagnostic output, so the fallback can be counted and grepped. */
export const FALLBACK_MARKER = "DIAGNOSTIC:fallback";

export interface FallbackOptions<T> {
  /** What to call it in the log: `"summary 2026-10"`. */
  readonly label: string;
  /** The request. Given a timeout, which it must pass on to `apiFetch`. */
  readonly network: (timeoutMs: number) => Promise<T>;
  /** What to answer with when the network does not. */
  readonly local: () => Promise<T>;
  /** How long to wait. */
  readonly timeoutMs?: number;
}

/**
 * An error that means **no answer arrived**, as opposed to an answer we did not like.
 *
 * ⚠️ **The distinction matters for what the app tells the user.** A `500` says the server is
 * unwell and a `403` says the request was refused; neither means the network is gone, and an
 * "you are offline" banner over a working connection is its own kind of lie. Only a refused
 * connection, a timeout, or the browser's explicit "no network" changes the offline state —
 * **all three still fall back to the local copy**, because something useful beats nothing.
 */
export function meansNoAnswer(error: unknown): boolean {
  const status = (error as { readonly status?: unknown }).status;

  // `apiFetch` uses 0 for "offline" and "timed out"; anything else is a real answer.
  if (typeof status === "number") return status === 0;

  // A thrown fetch (`TypeError: Failed to fetch`) or an abort with no HTTP status.
  return true;
}

/**
 * The network if it answers, the device otherwise.
 *
 * Re-throws nothing: if the local copy is also unavailable, the local error is the useful
 * one, because it is the code that actually ran last.
 */
export async function withLocalFallback<T>(options: FallbackOptions<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? LOCAL_FALLBACK_MS;

  try {
    const answer = await options.network(timeoutMs);

    /**
     * A real answer arrived, so the account is reachable — whatever the browser believes.
     * This is the half of the merge that clears the offline state.
     */
    reportReachability(true);

    return answer;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

    /**
     * ⚠️ **The local answer has its own deadline, and that is the fix for the tablet.**
     *
     * The owner reported identical code working on a phone and leaving a tablet on a loading screen
     * for ever. The request cannot be the cause: `apiFetch` aborts it after a second. **So something
     * else in this function never settled** — and there is only one other thing here, the read of
     * the device's own database.
     *
     * **An IndexedDB read can hang rather than fail.** It rejects on an error, but a transaction can
     * also simply never complete: the page being suspended, another tab holding a version upgrade
     * open, the browser deciding to stop servicing it. **A promise that never settles produces no
     * error and no log line — the screen spins for ever and every diagnostic stays silent**, which
     * is exactly why this took so long to see.
     *
     * **And it explains why two devices behaved differently on identical code.** Safari on a tablet
     * suspends pages far more aggressively than a phone in active use, so the same read that always
     * came back on the phone could never come back on the tablet — and left no trace, because it was
     * an absence rather than a failure.
     *
     * **A deadline turns an absence into an answer.**
     */
    const local = await withDeadline(options.local());

    await logOffline(
      `${FALLBACK_MARKER} · ${options.label}`,
      local.timedOut ? `${detail}；⚠️ 本机读取超时` : detail,
    );

    /**
     * Only a *missing* answer means offline. A 500 still falls back — the local copy is better than
     * an error page — but it does not claim the network is down.
     */
    reportReachability(!meansNoAnswer(error), detail);

    if (local.timedOut) {
      /**
       * ⚠️ **Thrown rather than answered with an empty page.**
       *
       * There is no honest value to return, and an empty list would be the app asserting something
       * it does not know — "you have no entries this month" when the truth is "the device did not
       * answer". The error state says the true thing, and the log line above says which half failed.
       */
      throw new Error(`本机数据读取超时：${options.label}`);
    }

    return local.value as T;
  }
}
