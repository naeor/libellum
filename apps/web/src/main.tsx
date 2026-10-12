import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.js";
import { primeBookId } from "./lib/api.js";
import { currentBookId, restoreCurrentBook, subscribeCurrentBook } from "./lib/currentBook.js";
import { restoreOfflineScopeSync } from "./lib/offline/scope.js";
import { requestPersistentStorage } from "./lib/offline/persistence.js";
import { registerServiceWorker } from "./lib/offline/worker.js";
import "./index.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error('Root container "#root" was not found in index.html');
}

/**
 * Registered before the first render, and not awaited.
 *
 * Before, because the worker should be in place by the time the user has finished
 * reading the first screen — and every load it is not registered is a load that
 * cannot be opened offline. Not awaited, because the app must not wait for a cache
 * to start: everything except offline works without it, and a slow or failed
 * registration must not delay somebody's ledger.
 */
void registerServiceWorker();

/**
 * ⚠️ **The difference between "data" and "a cache".**
 *
 * Storage a browser treats as *best-effort* may be evicted when the device is short
 * of space, and Safari discards it after seven days for sites not recently visited.
 * Everything built for offline would then be thrown away silently, and the user
 * would open the app on a plane to find a login screen.
 *
 * Asked for at startup rather than when the first entry is saved: the answer is
 * needed before the data matters, and the browser may show the user a prompt it
 * would rather show once.
 */
void requestPersistentStorage();

/**
 * ⚠️ **The one place the ledger and the request header are joined.**
 *
 * `currentBook.ts` owns the fact, `api.ts` owns the header it feeds, and neither imports the
 * other — a cycle between them would be a module-initialisation order bug, which is the kind
 * that only ever reproduces on somebody else's device. Wiring them here keeps both honest and
 * makes the dependency visible in one line.
 *
 * ⚠️ **Before the first render, and not awaited — but it fills a synchronous mirror.** Every
 * ledger-scoped request names its ledger, and the area a person was last in is remembered on
 * the device so a reload does not lose it. If the value is already in memory the header is set
 * before React mounts; if it is not, the server refuses the request rather than filing it under
 * the wrong ledger.
 */
primeBookId(currentBookId());
subscribeCurrentBook(() => {
  primeBookId(currentBookId());
});

/**
 * ⚠️ **The offline scope is restored first, and synchronously, because the persisted query cache
 * is keyed by it.**
 *
 * The cache is read once, early. If the scope were still empty at that moment, the read would land
 * on the unscoped key — **another account's copy, or none**. This is why the scope is remembered
 * as a value that `storage.ts` has in its synchronous mirror rather than only in IndexedDB.
 */
restoreOfflineScopeSync();

void restoreCurrentBook();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
