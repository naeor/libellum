import { readValue, writeValue } from "./storage.js";

/**
 * A record of what the offline machinery actually did.
 *
 * ⚠️ **This exists because three rounds of reading the code did not find the fault.**
 *
 * The owner reported that "下载全部" did nothing, three times. Each round produced a
 * real defect and a plausible explanation — a cache key that did not match, a
 * pagination loop that fetched one page, a metered check applied to a button — and each
 * round the symptom survived. **Reading the code kept producing theories; what was
 * missing was a record of what happened on his phone.**
 *
 * So the fill now writes down each attempt: when it started, whether it was asked for
 * or automatic, how many months it planned, what it skipped and why, what failed. The
 * download manager shows the last few entries. **A screenshot of that panel answers in
 * one look what four rounds of code reading could not.**
 *
 * Kept bounded: this is a diagnostic, not a history. Two hundred entries, oldest dropped.
 */

/** Where the log lives. */
const LOG_KEY = "offline-log";

/**
 * How many entries to keep.
 *
 * ⚠️ **Raised from fifty, because one "下载全部" is sixty lines by itself** — the
 * owner worked that out and said so: "每次下载全部，它都会检索一遍所有月份的数据）光这个就
 * 60 条了". At fifty, a single download pushed everything before it out of the window,
 * so the record could never show what happened *before* the attempt being investigated —
 * which is usually the useful part.
 *
 * Two hundred holds three full downloads, which is what "what did it do last time" needs.
 * Still bounded: this is a diagnostic, not a history.
 */
const MAX_ENTRIES = 200;

export interface LogEntry {
  /** Milliseconds since the epoch. */
  readonly at: number;
  /** What happened, in a phrase a person can read. */
  readonly what: string;
  /** Anything worth adding — a month, a count, an error. */
  readonly detail?: string;
}

/** Add one line to the log. Never throws: a diagnostic must not break the thing. */
export async function logOffline(what: string, detail?: string): Promise<void> {
  /**
   * ⚠️ **Buffered in memory and flushed in one write.**
   *
   * The first version read the whole log, appended, and wrote it back — **on every single call**.
   * With `read` written as an `async` function returning a promise, the append and the
   * persistence did not have to wait for each other, and the storage trace showed what that
   * produced: **`read offline-log` and `write offline-log` alternating over a hundred times in
   * under two seconds**, each read seeing 200 entries and each write storing 200 entries.
   *
   * **A log line is the most frequently executed thing in this file**, and it was doing two
   * database round trips per line — including during a download that writes sixty months of
   * diagnostics. The cost was paid on every offline read, which is the path that matters most.
   *
   * So entries go into an array and the array is written once, on a short timer. The order is
   * preserved exactly, which is the only property a diagnostic actually needs.
   */
  pending.push({ at: Date.now(), what, ...(detail === undefined ? {} : { detail }) });

  if (pending.length > MAX_ENTRIES) pending = pending.slice(-MAX_ENTRIES);

  scheduleFlush();

  // Kept `async` so every existing caller still awaits something; nothing waits on the write.
  await Promise.resolve();
}

/** Entries written but not yet stored. */
let pending: LogEntry[] = [];

/** In-flight write, so two flushes cannot interleave. */
let flushPromise: Promise<void> | null = null;

/** A pending timer, so a burst becomes one write. */
let flushTimer: number | null = null;

/**
 * Write the buffer out shortly.
 *
 * ⚠️ **A short delay rather than an immediate write**, because the calls arrive in bursts — sixty
 * months of fill each log several lines within a few milliseconds. Waiting turns sixty round
 * trips into one, and the delay is short enough that a report opened immediately afterwards
 * still sees everything.
 *
 * `queueMicrotask` is deliberately not used: it would fire before the burst has finished.
 */
function scheduleFlush(): void {
  if (typeof window === "undefined") return;
  if (flushTimer !== null) return;

  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 250);
}

/** Append the buffer to what is stored, and store it. */
async function flush(): Promise<void> {
  if (flushPromise !== null) return flushPromise;

  flushPromise = (async () => {
    const batch = pending;
    if (batch.length === 0) return;

    try {
      const existing = await readValue<readonly LogEntry[]>(LOG_KEY);
      const entries = Array.isArray(existing) ? existing : [];

      /**
       * ⚠️ **Only the part of the batch that is new.**
       *
       * A timer and a manual flush can both fire, and the entries already written must not be
       * written twice — the log would then show every line in duplicate, which is worse than
       * losing one.
       */
      const alreadyStored = new Set(entries.map((entry) => `${String(entry.at)}|${entry.what}`));
      const fresh = batch.filter((entry) => !alreadyStored.has(`${String(entry.at)}|${entry.what}`));

      if (fresh.length === 0) return;

      const next = [...entries, ...fresh].slice(-MAX_ENTRIES);

      pending = [];

      await writeValue(LOG_KEY, next);
    } catch {
      // A log that fails is a log that is empty. Nothing else changes.
    }
  })().finally(() => {
    flushPromise = null;
  });

  return flushPromise;
}

/** The log, newest first. Flushes first, so a report includes what just happened. */
export async function readOfflineLog(): Promise<readonly LogEntry[]> {
  await flush();

  const stored = await readValue<readonly LogEntry[]>(LOG_KEY);

  return Array.isArray(stored) ? [...stored].reverse() : [];
}

/** Forget it, for a clean reproduction. */
export async function clearOfflineLog(): Promise<void> {
  pending = [];

  await writeValue(LOG_KEY, []);
}

/** How a timestamp reads on screen. */
export function logTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");

  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
