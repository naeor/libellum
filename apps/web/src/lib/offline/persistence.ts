import { hasIndexedDb, readValue } from "./storage.js";

/**
 * Asking the browser to keep what it has been given.
 *
 * ⚠️ **This is the difference between "data" and "a cache", and it is not
 * cosmetic.** Storage that a browser considers *best-effort* may be evicted —
 * when the device is short of space, and under Safari's seven-day rule for sites
 * that have not been visited recently. Everything this project has built for
 * offline would then be discarded, silently, and the user would open the app on a
 * plane to find a login screen.
 *
 * `navigator.storage.persist()` asks for *persistent* storage, which the browser
 * will not evict on its own. The answer matters enough to report it: if a browser
 * says no, that is a fact the user should be told once, in plain words, rather
 * than something they discover at the worst moment.
 *
 * **The distinction the owner raised is worth stating plainly**, because it is the
 * common misunderstanding: a browser is not "only a cache". IndexedDB is a real
 * database in the profile directory — the same storage a native application would
 * use for its files — and the app's code is kept beside it by the service worker.
 * The web platform is not a thinner version of a native app here; it is the same
 * arrangement with a different installer.
 */

/** Whether the browser promises to keep this origin's storage. */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || navigator.storage === undefined) return false;

  try {
    if (await navigator.storage.persisted()) return true;

    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** What this origin is using, and how much it may use. */
export interface StorageReport {
  readonly usageBytes: number;
  /** `null` when the browser declines to say, which some do. */
  readonly quotaBytes: number | null;
  readonly persisted: boolean;
}

/**
 * How much room the ledger is taking.
 *
 * Worth showing for one reason: the user asked for **all** of their history to be
 * available offline, and "all" is a promise about space. A number they can look at
 * answers "is this going to fill up my phone" before it becomes a question, and a
 * quota figure that turns out to be small is something to find out here rather
 * than mid-flight.
 */
export async function storageReport(): Promise<StorageReport> {
  const empty: StorageReport = { usageBytes: 0, quotaBytes: null, persisted: false };

  if (typeof navigator === "undefined" || navigator.storage === undefined) return empty;

  try {
    const estimate = await navigator.storage.estimate();

    return {
      usageBytes: estimate.usage ?? 0,
      quotaBytes: estimate.quota ?? null,
      persisted: await navigator.storage.persisted(),
    };
  } catch {
    return empty;
  }
}

/**
 * Where the origin's storage has actually gone.
 *
 * ⚠️ **Written because the owner's figures did not add up, and nothing on screen could
 * explain the gap.** He saw **52.5 MB used** while the download manager reported a query
 * cache of **127 KB** — the ledger itself being about that size. Four hundred times the
 * difference is not a rounding error, and there was no way to see what the rest was.
 *
 * `navigator.storage.estimate()` reports one number for the whole origin: the database,
 * the caches, and whatever the browser is holding on our behalf. It cannot say which is
 * which — **and Chrome counts things it may not have written to disk yet**, so the figure
 * can run ahead of the data.
 *
 * So this weighs the pieces that are ours:
 *
 *  * **the query cache** — the ledger copy, the one that matters;
 *  * **the service worker's shell cache** — the app's own HTML, JS and CSS;
 *  * **the diagnostics log** — bounded, but ours, and it should be visible.
 *
 * **Whatever is left over is the browser's business**, and saying so is better than
 * implying the ledger takes 52 MB when it takes 127 KB.
 */
export interface StorageBreakdown {
  readonly totalBytes: number;
  readonly queryCacheBytes: number;
  readonly shellCacheBytes: number;
  readonly diagnosticsBytes: number;
  /** The remainder: browser overhead, and data not yet written to disk. */
  readonly otherBytes: number;
}

/** Measure the pieces this application controls. */
export async function storageBreakdown(): Promise<StorageBreakdown> {
  const report = await storageReport();

  const queryCacheBytes = await byteLengthOf("query-cache");
  const diagnosticsBytes = await byteLengthOf("offline-log");

  let shellCacheBytes = 0;

  try {
    if (typeof caches !== "undefined") {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);

        for (const request of await cache.keys()) {
          const response = await cache.match(request);

          if (response === undefined) continue;

          /**
           * `content-length` when the browser kept it, otherwise the body's own length.
           *
           * A cached response is a stream, so measuring it means reading it — which is why
           * this only runs on a screen the user opens deliberately.
           */
          const declared = Number(response.headers.get("content-length") ?? "0");

          shellCacheBytes += declared > 0 ? declared : (await response.clone().blob()).size;
        }
      }
    }
  } catch {
    // A cache that cannot be measured counts as nothing, rather than breaking the page.
  }

  return {
    totalBytes: report.usageBytes,
    queryCacheBytes,
    shellCacheBytes,
    diagnosticsBytes,
    otherBytes: Math.max(0, report.usageBytes - queryCacheBytes - shellCacheBytes - diagnosticsBytes),
  };
}

/** How many bytes one stored value takes, as JSON. */
async function byteLengthOf(key: string): Promise<number> {
  const value = await readValue<unknown>(key);

  if (value === null) return 0;

  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * Bytes in the units a person reads.
 *
 * Pure, and it lives here rather than in a component because there are two callers
 * coming — the offline status line and the storage report — and two copies of a
 * formatter is how one of them ends up saying "1.0 MB" while the other says
 * "1024 KB".
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Whether offline is worth offering at all.
 *
 * A browser with no IndexedDB cannot keep the ledger, and saying so is better than
 * a screen that promises offline and quietly does nothing. Rare, but the answer
 * costs one check.
 */
export function canStoreOffline(): boolean {
  return hasIndexedDb();
}
