import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.js";
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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
