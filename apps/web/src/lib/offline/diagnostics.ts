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
  try {
    const existing = await readValue<readonly LogEntry[]>(LOG_KEY);
    const entries = Array.isArray(existing) ? existing : [];

    const next = [...entries, { at: Date.now(), what, detail }].slice(-MAX_ENTRIES);

    await writeValue(LOG_KEY, next);
  } catch {
    // A log that fails is a log that is empty. Nothing else changes.
  }
}

/** The log, newest first. */
export async function readOfflineLog(): Promise<readonly LogEntry[]> {
  const stored = await readValue<readonly LogEntry[]>(LOG_KEY);

  return Array.isArray(stored) ? [...stored].reverse() : [];
}

/** Forget it, for a clean reproduction. */
export async function clearOfflineLog(): Promise<void> {
  await writeValue(LOG_KEY, []);
}

/** How a timestamp reads on screen. */
export function logTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");

  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
