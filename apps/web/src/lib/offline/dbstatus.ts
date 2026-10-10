import { hasIndexedDb, listKeys, readValue } from "./storage.js";

/**
 * What the device's own database says about itself.
 *
 * ⚠️ **Written because "缓存条目：0 条" was the whole of a report and it is not enough to act on.**
 *
 * The owner's tablet reported **0 entries and 0 bytes while online** — the cache was not merely
 * unreadable offline, it appeared never to have been written. That can mean several different
 * things and they are indistinguishable from the counts alone:
 *
 *  * **IndexedDB is unavailable** — private browsing, a blocked origin, storage disabled;
 *  * **the database will not open** — a version clash, another tab holding an old connection;
 *  * **the data was written and then evicted** — iOS is the platform that does this most;
 *  * **the write silently failed** — a quota refusal;
 *  * **the write is fine and something is looking in the wrong place.**
 *
 * So this asks the database directly and reports what it says, rather than inferring. **A count of
 * zero is a symptom; these are the causes.**
 */
export interface DatabaseReport {
  /** Whether the API exists at all. */
  readonly supported: boolean;
  /** Whether the database could be opened. */
  readonly opened: boolean;
  /** Why not, when it could not. */
  readonly error: string | null;
  /** How many keys are stored. */
  readonly keyCount: number;
  /** The keys themselves, so a missing or renamed one is visible. */
  readonly keys: readonly string[];
  /** Bytes in the query cache, measured from the store rather than from the count. */
  readonly cacheBytes: number;
  /** Whether the app's own bookkeeping can see a database at all. */
  readonly hasDatabase: boolean;
  /**
   * What is actually stored under the cache key.
   *
   * ⚠️ **Added because "0 字节" cannot be acted on.** The owner's tablet reported two keys in the
   * database and an empty cache — and that is consistent with several different situations that
   * need different fixes:
   *
   *  * **the key is absent** — something removed it;
   *  * **the key holds an empty string** — something wrote nothing over the top;
   *  * **the key holds a non-string** — a structured clone of something unexpected;
   *  * **the key holds text that is not JSON** — a truncated or corrupted write.
   *
   * A length alone cannot tell those apart, so the type and the first characters are reported too.
   */
  readonly cacheKind: string;
  /** The beginning of the stored value, enough to recognise it. */
  readonly cachePreview: string;
  /** Whether it parses as the dehydrated cache shape the app expects. */
  readonly cacheParses: boolean;
  /** How many queries the stored cache holds, when it parses. */
  readonly cacheQueryCount: number;
}

/** Ask the device. */
export async function databaseReport(): Promise<DatabaseReport> {
  if (!hasIndexedDb()) {
    return {
      supported: false,
      opened: false,
      error: "这个浏览器或这个模式下没有 IndexedDB",
      keyCount: 0,
      keys: [],
      cacheBytes: 0,
      hasDatabase: false,
      cacheKind: "(无数据库)",
      cachePreview: "",
      cacheParses: false,
      cacheQueryCount: 0,
    };
  }

  try {
    /**
     * `listKeys` goes through the same open-and-read path the rest of the app uses, so a failure
     * here is the same failure the ledger would hit — which is the point of asking.
     */
    const keys = await listKeys();
    const cached = await readValue<unknown>("query-cache");

    /**
     * ⚠️ **Read as `unknown`, not as `string`.**
     *
     * The rest of the app casts the stored value to `string` and treats anything else as "no cache".
     * That is right for the code's behaviour and wrong for a diagnosis: it turns "the key holds an
     * object" into "the key is empty", and those need different fixes.
     */
    const kind =
      cached === null || cached === undefined
        ? "(键不存在)"
        : typeof cached === "string"
          ? "字符串"
          : typeof cached;
    const preview = typeof cached === "string" ? cached.slice(0, 80) : JSON.stringify(cached)?.slice(0, 80) ?? "";

    let parses = false;
    let queryCount = 0;

    if (typeof cached === "string" && cached !== "") {
      try {
        const parsed = JSON.parse(cached) as {
          readonly clientState?: { readonly queries?: readonly unknown[] };
        };

        const queries = parsed.clientState?.queries;

        parses = Array.isArray(queries);
        queryCount = Array.isArray(queries) ? queries.length : 0;
      } catch {
        parses = false;
      }
    }

    return {
      supported: true,
      opened: true,
      error: null,
      keyCount: keys.length,
      keys,
      cacheBytes: typeof cached === "string" ? cached.length : 0,
      hasDatabase: true,
      cacheKind: kind,
      cachePreview: preview,
      cacheParses: parses,
      cacheQueryCount: queryCount,
    };
  } catch (error) {
    return {
      supported: true,
      opened: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      keyCount: 0,
      keys: [],
      cacheBytes: 0,
      hasDatabase: true,
      cacheKind: "(打不开)",
      cachePreview: "",
      cacheParses: false,
      cacheQueryCount: 0,
    };
  }
}

/**
 * How the browser describes its own storage for this origin.
 *
 * ⚠️ **`quota` and `usage` together, not just usage.** A device can report a few megabytes used
 * against a quota of a few megabytes, and that is a completely different situation from the same
 * usage against a quota of gigabytes — the first explains a refused write, the second rules it
 * out.
 */
export interface QuotaReport {
  readonly usageBytes: number;
  readonly quotaBytes: number | null;
  readonly persisted: boolean;
}

/** Ask the browser. */
export async function quotaReport(): Promise<QuotaReport> {
  let usageBytes = 0;
  let quotaBytes: number | null = null;
  let persisted = false;

  try {
    const estimate = await navigator.storage?.estimate();

    usageBytes = estimate?.usage ?? 0;
    quotaBytes = estimate?.quota ?? null;
  } catch {
    // A browser that will not say is reported as not saying.
  }

  try {
    persisted = (await navigator.storage?.persisted()) ?? false;
  } catch {
    // Same.
  }

  return { usageBytes, quotaBytes, persisted };
}
