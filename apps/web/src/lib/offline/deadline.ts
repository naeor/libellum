/**
 * A deadline for something that should answer promptly.
 *
 * ⚠️ **Written because the tablet stayed on a loading screen while the phone did not, and no
 * existing timeout could explain it.**
 *
 * The request has a guard: `apiFetch` aborts it after a second and rejects. So a spinner that
 * never ends is not a request that never ends — **it is something else in the same code path that
 * never settles.** In `withLocalFallback` there is exactly one other thing: the read of the
 * device's own database.
 *
 * And that read can genuinely hang rather than fail. `readValue` rejects on an error, but an
 * IndexedDB transaction can also simply never complete — when the page is being suspended, when
 * another tab holds a version upgrade open, when the browser decides to stop servicing it. **A
 * promise that never settles produces no error, no rejection, and no log line**: the screen spins
 * for ever and everything written to diagnose it stays silent.
 *
 * ⚠️ **This is also why the symptom differed between two devices running the same code.** Safari on
 * a tablet suspends pages far more aggressively than a phone being actively used — so the same read
 * that always returned on the phone could simply never come back on the tablet, and the failure
 * left no trace because it was an absence rather than an error.
 *
 * **A deadline turns an absence into an answer**, and the answer is the one the app can always
 * give: whatever is on the device.
 */

/**
 * A timer handle, whichever runtime produced it.
 *
 * ⚠️ **`globalThis`, not `window`, and the reason is the test suite.**
 *
 * The first version used `window.setTimeout`, which does not exist under Node — where these tests
 * run — so **every test of the fallback failed with `window is not defined`** rather than with
 * anything about the behaviour being tested. That is a signal worth heeding: **a module that can
 * only be exercised in a browser is a module whose tests cannot run**, and this one is about
 * timeouts, which is precisely the kind of logic that needs testing.
 *
 * The handle is left untyped on purpose. Browsers hand back a number and Node hands back an object,
 * and this code only ever passes it back to `clearTimeout`.
 */
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/** How long to wait for a local answer. Generous: this is a local database, not a network. */
export const LOCAL_READ_DEADLINE_MS = 1_500;

export interface RaceResult<T> {
  readonly value: T | null;
  /** True when the deadline passed first, so `value` is not the real answer. */
  readonly timedOut: boolean;
}

/**
 * Wait for a promise, but not for ever.
 *
 * Resolves with `timedOut: true` rather than rejecting, because the caller has a useful thing to do
 * with a timeout — carry on with what it has — and a rejection would only be caught and turned into
 * the same thing.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number = LOCAL_READ_DEADLINE_MS,
): Promise<RaceResult<T>> {
  let timer: TimerHandle | undefined;

  const deadline = new Promise<RaceResult<T>>((resolve) => {
    timer = globalThis.setTimeout(() => {
      resolve({ value: null, timedOut: true });
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      work.then((value): RaceResult<T> => ({ value, timedOut: false })),
      deadline,
    ]);
  } finally {
    /**
     * ⚠️ **The timer is always cleared, including when `work` won.**
     *
     * A timer left running holds its closure alive and fires later for no reason — and in this
     * codebase that would also mean a stray write into the diagnostic log after the query had
     * already settled, which is the kind of noise that made the log unreadable before.
     */
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}
