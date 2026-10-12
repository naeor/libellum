import { forgetCurrentBook } from "../currentBook.js";
import { clearDatabase, hasIndexedDb } from "./storage.js";

/**
 * Remove everything this application has left on the device.
 *
 * ⚠️ **The owner asked for this, and his reasoning is the part worth keeping**: "倘若浏览器其他
 * 数据我们没法处理的话，那岂不是每下载一次手机就少3MB的空间？我们可以一键删除这个程序在本地
 * 留下的所有的东西吗？"
 *
 * He is right that it is the only answer available. The storage figure includes a remainder the
 * app cannot itemise and cannot free — the browser's own accounting, including writes it has
 * not flushed. **What the app *can* do is throw away everything it owns**, and that is a real
 * ceiling on the damage rather than a partial cleanup that leaves the user guessing.
 *
 * **Three things are removed, and they are removed in this order on purpose**:
 *
 *  1. **the caches** — the app's own HTML, JS and CSS, which the service worker will fetch
 *     again on the next load. Done first because it is the largest and the safest;
 *  2. **IndexedDB** — the ledger copy and everything else the app stored;
 *  3. **the service worker registration itself** — so the next visit is a genuinely fresh
 *     start rather than a stale shell serving a half-removed state.
 *
 * ⚠️ **It deliberately does not touch the session cookie.** Signing the user out to free space
 * would be a different action with a different consent, and a "clear data" button that logs
 * somebody out is a button that surprises them.
 *
 * ⚠️ **And the caller is expected to reload.** Half of what is removed is needed for the app to
 * run; carrying on with it gone is not a state worth supporting.
 */
export async function resetEverything(): Promise<{ readonly cachesCleared: number; readonly databaseCleared: boolean }> {
  let cachesCleared = 0;

  try {
    if (typeof caches !== "undefined") {
      for (const name of await caches.keys()) {
        if (await caches.delete(name)) cachesCleared += 1;
      }
    }
  } catch {
    // Nothing to do: a cache that cannot be listed cannot be cleared.
  }

  const databaseCleared = hasIndexedDb() ? await clearDatabase() : false;

  /**
   * ⚠️ **The in-memory copy of "which ledger" goes too.**
   *
   * Clearing the database removes the stored value, but the module keeps the answer in memory
   * for the request header to read, and a stale ledger id would keep being sent until the next
   * reload. The caller reloads straight after this — but relying on that would be relying on
   * the order of somebody else's code.
   */
  forgetCurrentBook();

  try {
    const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? [];

    for (const registration of registrations) {
      /**
       * ⚠️ **Unregistered, not just updated.** A registered worker keeps serving the shell it
       * cached, so a reload after clearing would put the user back where they started — with
       * the cache gone but the page still loading and re-caching. Unregistering makes the next
       * load hit the network for everything, which is what "fresh start" has to mean.
       */
      await registration.unregister();
    }
  } catch {
    // A worker that cannot be unregistered is not a reason to fail the whole operation.
  }

  return { cachesCleared, databaseCleared };
}

/**
 * How much room the app's own data may take before it offers to start over.
 *
 * ⚠️ **An offer, not an automatic wipe.**
 *
 * The owner suggested doing it automatically: "可以比方说检测到占用超过100MB就全删再重下一次
 * 之类的". That is tempting and it is the wrong default, for a reason about this specific number:
 * **`storage.estimate()` includes data the browser has not written to disk yet**, so it can run
 * far ahead of anything real — his own report shows 16.6 MB used against a 126 KB ledger. A
 * threshold on a figure that inflated would eventually delete somebody's freshly downloaded
 * ledger while the app looked half-empty, and it would happen while they were offline.
 *
 * So the threshold is what raises the *offer*, and the user makes the decision. That also keeps
 * the button honest: a program that silently deletes its own data is a program people stop
 * trusting with a ledger.
 */
export const RESET_OFFER_BYTES = 100 * 1024 * 1024;
