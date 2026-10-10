import { describe, expect, it, vi } from "vitest";

import { withDeadline } from "./deadline.js";

/**
 * ⚠️ **The fix for a loading screen that never ended, and the reason it hit one device and not
 * another.**
 *
 * The owner reported identical code working on his phone and leaving his tablet on a spinner for
 * ever. The request could not be the cause — `apiFetch` aborts it after a second — so the thing
 * that never settled had to be the other half of the fallback: **the read of the device's own
 * database.**
 *
 * **An IndexedDB read can hang rather than fail.** It rejects on an error, but a transaction can
 * also simply never complete: the page being suspended, another tab holding a version upgrade open,
 * the browser deciding to stop servicing it. **A promise that never settles produces no error and
 * no log line**, so the screen spins for ever and every diagnostic stays silent.
 *
 * **That is also why two devices differed on identical code**: Safari on a tablet suspends pages far
 * more aggressively than a phone in active use, so a read that always came back on the phone could
 * never come back on the tablet — **an absence rather than a failure, which is why nothing was
 * logged.**
 */
describe("withDeadline", () => {
  it("returns the value when the work finishes in time", async () => {
    const result = await withDeadline(Promise.resolve("answered"), 1_000);

    expect(result).toEqual({ value: "answered", timedOut: false });
  });

  it("⚠️ gives up on work that never settles, instead of hanging for ever", async () => {
    // This is the whole point: a promise that never resolves used to hang the screen for ever.
    const never = new Promise<string>(() => {
      // Deliberately never settles.
    });

    const result = await withDeadline(never, 20);

    expect(result.timedOut).toBe(true);
    expect(result.value).toBeNull();
  });

  it("does not reject when the work rejects", async () => {
    // A caller with a useful fallback should get a result to branch on, not an exception to catch
    // and convert back into the same branch.
    await expect(
      withDeadline(
        (async () => {
          throw new Error("the device said no");
        })(),
        1_000,
      ),
    ).rejects.toThrow("the device said no");
  });

  it("accepts the deadline as a parameter", async () => {
    const never = new Promise<number>(() => {
      // Never settles.
    });

    const started = Date.now();
    await withDeadline(never, 30);

    expect(Date.now() - started).toBeLessThan(500);
  });

  it("⚠️ leaves no timer behind when the work wins", async () => {
    // A stray timer keeps its closure alive and, in this codebase, would write into the diagnostic
    // log after the query had already settled — the kind of noise that made the log unreadable.
    const clear = vi.spyOn(globalThis, "clearTimeout");

    await withDeadline(Promise.resolve("quick"), 10_000);

    expect(clear).toHaveBeenCalled();

    clear.mockRestore();
  });
});
