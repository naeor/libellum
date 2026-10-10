import { describe, expect, it, vi } from "vitest";

import { FALLBACK_MARKER, LOCAL_FALLBACK_MS, withLocalFallback } from "./fallback.js";

/**
 * ⚠️ **The rule the owner described better than the code did.**
 *
 * His words: "先去读网络数据，被拒绝/超过两秒没有收到数据然后直接改成用本地数据就可以了吧？"
 *
 * The version this replaced asked `navigator.onLine` first and only used the local copy
 * when the browser admitted to being offline. **A phone lies about that**: it reports
 * online in a lift, on a train, on a captive portal, and on a Wi-Fi network whose router
 * has stopped forwarding. In every one of those the app waited, failed, and showed nothing
 * — with a perfectly good copy of the ledger on the device.
 *
 * **The question is not "does the browser think we are online" but "did the answer
 * arrive".**
 */
describe("withLocalFallback", () => {
  it("uses the network when it answers", async () => {
    const local = vi.fn(async () => "local");

    const result = await withLocalFallback({
      label: "test",
      network: async () => "network",
      local,
    });

    expect(result).toBe("network");
    expect(local).not.toHaveBeenCalled();
  });

  it("uses the device when the request is refused", async () => {
    const result = await withLocalFallback({
      label: "test",
      network: async () => {
        throw new Error("Failed to fetch");
      },
      local: async () => "local",
    });

    expect(result).toBe("local");
  });

  it("uses the device when the request times out", async () => {
    const result = await withLocalFallback({
      label: "test",
      network: async () => {
        throw new DOMException("aborted", "AbortError");
      },
      local: async () => "local",
    });

    expect(result).toBe("local");
  });

  it("uses the device when the server is unhappy", async () => {
    // A 500 says nothing about whether the local copy is good, and it is the only copy
    // available. The user gets their ledger rather than an error about somebody else's
    // server.
    const result = await withLocalFallback({
      label: "test",
      network: async () => {
        throw new Error("HTTP 500");
      },
      local: async () => "local",
    });

    expect(result).toBe("local");
  });

  it("passes the timeout to the request, so the network cannot hang", async () => {
    // The wait is the user's, and the fallback is cheap — the data is already on the
    // device. A request given no deadline is a request that can leave somebody staring at
    // a spinner on a train.
    let received: number | null = null;

    await withLocalFallback({
      label: "test",
      network: async (timeoutMs) => {
        received = timeoutMs;
        return "network";
      },
      local: async () => "local",
    });

    expect(received).toBe(LOCAL_FALLBACK_MS);
  });

  it("honours a caller's own timeout", async () => {
    let received: number | null = null;

    await withLocalFallback({
      label: "test",
      timeoutMs: 500,
      network: async (timeoutMs) => {
        received = timeoutMs;
        return "network";
      },
      local: async () => "local",
    });

    expect(received).toBe(500);
  });

  it("lets the local copy's own error through", async () => {
    // When neither side can answer, the useful error is the one from the code that ran
    // last — "this entry is not stored on this device" rather than "the network failed",
    // because the second one is already obvious.
    await expect(
      withLocalFallback({
        label: "test",
        network: async () => {
          throw new Error("offline");
        },
        local: async () => {
          throw new Error("这一笔还没有存到本机");
        },
      }),
    ).rejects.toThrow("这一笔还没有存到本机");
  });

  it("names the fallback in the diagnostic log with a greppable marker", async () => {
    // The rule from DEVLOG §9.1: a diagnostic should produce a unique, searchable result,
    // so "was it offline or was the server unhappy" is answerable from the record.
    expect(FALLBACK_MARKER).toContain("DIAGNOSTIC");
  });
});
