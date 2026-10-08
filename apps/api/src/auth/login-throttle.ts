export interface LoginThrottleOptions {
  /** Failures allowed inside the window before locking starts. */
  readonly maxFailures: number;
  /** How long a first lockout lasts; it doubles with each further failure. */
  readonly lockoutMs: number;
  /** Failures older than this are forgotten. */
  readonly windowMs: number;
}

interface Entry {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const MAX_BACKOFF_DOUBLINGS = 5;

/**
 * In-memory login throttle.
 *
 * Deliberately simple: it counts failures per username *and* per IP, and locks
 * with exponential backoff. Keeping it in memory means a restart clears it,
 * which is an acceptable trade for a single-instance deployment — the point is
 * to make online guessing impractical, not to be a durable audit trail.
 */
export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: LoginThrottleOptions) {}

  /** Seconds the caller must wait, or 0 when they may try now. */
  retryAfterSeconds(keys: readonly string[], now: number = Date.now()): number {
    let longest = 0;

    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry && entry.lockedUntil > now) {
        longest = Math.max(longest, Math.ceil((entry.lockedUntil - now) / 1000));
      }
    }

    return longest;
  }

  recordFailure(keys: readonly string[], now: number = Date.now()): void {
    for (const key of keys) {
      const entry = this.entries.get(key);

      if (!entry || now - entry.firstFailureAt > this.options.windowMs) {
        this.entries.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
        continue;
      }

      entry.failures += 1;

      if (entry.failures >= this.options.maxFailures) {
        const doublings = Math.min(entry.failures - this.options.maxFailures, MAX_BACKOFF_DOUBLINGS);
        entry.lockedUntil = now + this.options.lockoutMs * 2 ** doublings;
      }
    }
  }

  recordSuccess(keys: readonly string[]): void {
    for (const key of keys) {
      this.entries.delete(key);
    }
  }
}
