/**
 * Try the network; use what is on the device when it does not answer.
 *
 * ⚠️ **The owner described this rule better than the code did**: "先去读网络数据，被拒绝/
 * 超过两秒没有收到数据然后直接改成用本地数据就可以了吧？"
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
 * **Two seconds, because of what happens after it.** The wait is the user's, and the
 * fallback is cheap: the data is already on the device. A shorter time is not "giving up
 * early", it is choosing the answer that is available now over the one that might arrive.
 *
 * ⚠️ **And a failure is logged with a unique marker**, so that "was it offline or was the
 * server unhappy" is answerable from the record rather than from another round of guessing
 * — which is the rule the owner set out in DEVLOG §9.1.
 */
import { logOffline } from "./diagnostics.js";

/** How long to wait for the network before answering from the device. */
export const LOCAL_FALLBACK_MS = 2_000;

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
 * The network if it answers, the device otherwise.
 *
 * Re-throws nothing: if the local copy is also unavailable the local error is the useful
 * one, because it is the code that actually ran last.
 */
export async function withLocalFallback<T>(options: FallbackOptions<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? LOCAL_FALLBACK_MS;

  try {
    return await options.network(timeoutMs);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

    await logOffline(`${FALLBACK_MARKER} · ${options.label}`, detail);

    return options.local();
  }
}
