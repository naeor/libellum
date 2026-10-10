import { useSyncExternalStore } from "react";

import { logOffline } from "./diagnostics.js";

/**
 * Whether the account is currently cut off from the server.
 *
 * ⚠️ **Two signals, and the owner asked for exactly this merge**: "要不要把这个判定条件和之前的
 * '服务器认为我们不在线'合并一下？也就是说，当这个判决条件被触发时或者服务器认为我们不在线
 * （二者任意一项被触发）就默认账号已经离线."
 *
 * The two are not the same thing and neither is sufficient:
 *
 *  * **the browser's opinion** — `navigator.onLine`. Immediate, and wrong in a lift, on a
 *    train, and on any Wi-Fi network whose router stopped forwarding. It is also *right*
 *    the moment a connection drops, which the other signal cannot know until it tries.
 *  * **the last request's outcome** — did an answer arrive. Authoritative, because it is
 *    about an actual attempt, but blind until something is attempted.
 *
 * **Being offline is the union**, and being online again is the intersection — which is
 * what he described: offline if either says so, online only once the browser agrees *and*
 * a request has succeeded.
 *
 * ⚠️ **A request failing is not proof of being offline.** A 500 means the server is
 * unwell, and a 403 means the request was refused; neither says the network is gone, and
 * claiming otherwise would put an "you are offline" banner on a perfectly good connection.
 * Only failures that mean *no answer arrived* count.
 */

let browserOnline = typeof navigator === "undefined" ? true : navigator.onLine;
let lastRequestFailed = false;
let listeners = new Set<() => void>();

/**
 * Record what the browser says.
 *
 * Wired to the `online`/`offline` events, and also consulted directly — because a phone
 * sometimes changes its mind without firing anything.
 */
function setBrowserOnline(online: boolean): void {
  if (browserOnline === online) return;

  browserOnline = online;
  emit();
}

/** Let every screen know the answer changed. */
function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Record the outcome of a request that had a real chance of reaching the server.
 *
 * ⚠️ **Called only by the fallback helper**, which knows the difference between "no answer"
 * and "an answer we did not like". See the note at the top.
 */
export function reportReachability(reachable: boolean, detail?: string): void {
  if (reachable) {
    if (lastRequestFailed) {
      lastRequestFailed = false;
      void logOffline("DIAGNOSTIC:reachable", "服务器恢复响应");
      emit();
    }

    return;
  }

  if (!lastRequestFailed) {
    lastRequestFailed = true;
    void logOffline("DIAGNOSTIC:unreachable", detail ?? "请求没有收到答复");
    emit();
  }
}

/** Whether the account is cut off, by either signal. */
export function isAccountOffline(): boolean {
  return !browserOnline || lastRequestFailed;
}

/** Why, for a message that says something useful. */
export function offlineReason(): "browser" | "unreachable" | null {
  if (!browserOnline) return "browser";
  if (lastRequestFailed) return "unreachable";

  return null;
}

/** Subscribe to changes, for `useSyncExternalStore`. */
export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener);

  // Wired once, on the first subscriber, and never removed: the browser's online state is
  // global and the app is a single page, so tearing this down and rebuilding it on every
  // mount would be churn for nothing.
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("online", () => {
      setBrowserOnline(true);
    });
    window.addEventListener("offline", () => {
      setBrowserOnline(false);
    });
  }

  return () => {
    listeners.delete(listener);
  };
}

/** The current answer, for `useSyncExternalStore`. */
export function connectivitySnapshot(): boolean {
  return isAccountOffline();
}

/**
 * Whether the app should behave as offline **right now**, as a React value.
 *
 * One store rather than a hook reading `navigator.onLine` per component: the answer has to
 * be the same everywhere, or one screen shows an offline banner while the next one fetches
 * happily.
 */
export function useAccountOffline(): { readonly offline: boolean; readonly reason: "browser" | "unreachable" | null } {
  const offline = useSyncExternalStore(subscribeConnectivity, connectivitySnapshot, () => false);

  return { offline, reason: offline ? offlineReason() : null };
}

/**
 * Reset for tests, which need a clean slate between cases.
 *
 * Exported rather than kept private because a module-level store is exactly the kind of
 * thing that leaks between tests, and the alternative — re-importing with a cache-busting
 * query — is worse to read.
 */
export function resetConnectivityForTest(browserIsOnline: boolean): void {
  browserOnline = browserIsOnline;
  lastRequestFailed = false;
  listeners = new Set();
}
