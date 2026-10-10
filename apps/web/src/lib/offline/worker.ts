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
  /**
   * ⚠️ **Not registered in development, and that is a fix rather than a convenience.**
   *
   * The owner spent three rounds testing fixes that had not reached his device — "pad上还是看不了"
   * answered with the same diagnostic twice, because the copy he pasted had the timestamp of the
   * previous one. **The cause was this worker**: it served the shell from its cache first, and in
   * development Vite serves modules from `/src/...` at stable URLs, so **the code that ran was
   * always the code from the visit before**.
   *
   * A cache that makes development unverifiable is worse than no cache during development. The
   * worker exists for the built application, and `vite build` does not take this branch.
   *
   * ⚠️ **And any worker left over from an earlier session is removed**, because otherwise the
   * person who has one keeps getting the old behaviour while the code says it cannot happen.
   */
  if (import.meta.env.DEV) {
    try {
      const existing = await navigator.serviceWorker?.getRegistrations();

      for (const registration of existing ?? []) {
        await registration.unregister();
      }

      if ((existing ?? []).length > 0) {
        console.info("[offline] 开发模式：已注销此前注册的 Service Worker，避免拿到旧代码。");
      }
    } catch {
      // Nothing to unregister is the normal case.
    }

    return false;
  }

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
