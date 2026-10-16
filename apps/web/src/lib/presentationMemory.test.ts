import { afterEach, describe, expect, it, vi } from "vitest";
import { markPresentationSeen, readSeenPresentation } from "./spaceTransition.js";

describe("device presentation acknowledgement", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("does not infer completion from a blocked browser store", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("blocked"); } } });
    expect(readSeenPresentation("new-account")).toBe(false);
  });
  it("keeps accounts independent and does not mark on read", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    expect(readSeenPresentation("first")).toBe(false);
    expect(values.size).toBe(0);
    markPresentationSeen("first");
    expect(readSeenPresentation("first")).toBe(true);
    expect(readSeenPresentation("second")).toBe(false);
  });
});
