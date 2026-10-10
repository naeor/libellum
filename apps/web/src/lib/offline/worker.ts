/**
 * Registering the service worker.
 *
 * ⚠️ **Only over HTTPS, or on localhost.** A browser refuses to register a
 * service worker on an insecure origin — the same rule that made speech recording
 * fail on the phone until the LAN server was given a certificate, and the same
 * wrong diagnosis waiting to happen: the app would silently have no offline
 * support and no error anybody would see.
 *
 * So registration **reports** rather than assumes. It says what it did, so that
 * "offline is not working" can be answered by looking at the console instead of
 * guessing.
 */

/** Whether this page is allowed to register a service worker. */
export function canRegisterWorker(): boolean {
  if (typeof navigator === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;

  // `isSecureContext` covers `localhost` as well as HTTPS, and the protocol is the
  // fallback for a browser that does not report it.
  return window.isSecureContext || window.location.protocol === "https:";
}

/**
 * Register the worker, and keep it up to date.
 *
 * Returns whether registration was even attempted, which is what the caller needs
 * to say something useful — a failure here must never break the app, because
 * everything except offline works without it.
 */
export async function registerServiceWorker(): Promise<boolean> {
  if (!canRegisterWorker()) {
    if (import.meta.env.DEV) {
      console.info(
        "[offline] 未注册 Service Worker：这个地址不是安全上下文。\n" +
          "          离线功能需要 https 或 localhost。手机访问请用 https 地址（见 docs/README.md）。",
      );
    }

    return false;
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

    /**
     * Check for a new version on every load.
     *
     * The default interval is long enough that a phone would keep an old build for
     * days, which is the worst kind of bug to diagnose: the fix is deployed and the
     * user is running last week's code.
     */
    void registration.update();

    return true;
  } catch (error) {
    // A failure to register costs offline support and nothing else.
    console.warn("[offline] Service Worker 注册失败：", error);

    return false;
  }
}
