import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.js";
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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
