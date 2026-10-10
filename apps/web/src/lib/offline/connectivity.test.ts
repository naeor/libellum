import { beforeEach, describe, expect, it } from "vitest";

import {
  connectivitySnapshot,
  isAccountOffline,
  offlineReason,
  reportReachability,
  resetConnectivityForTest,
} from "./connectivity.js";

/**
 * ⚠️ **The merge the owner asked for**: "当这个判决条件被触发时或者服务器认为我们不在线
 * （二者任意一项被触发）就默认账号已经离线，直到账号能再从服务器读到信息且服务器认为我们在线."
 *
 * Two signals, and neither is enough on its own:
 *
 *  * **the browser's opinion** — immediate, and wrong in a lift, on a train, and on any Wi-Fi
 *    network whose router stopped forwarding;
 *  * **the last request's outcome** — authoritative, because it is about an actual attempt,
 *    but blind until something is attempted.
 *
 * **Offline is the union. Online is the intersection.** These tests pin both halves, because
 * getting either wrong produces a banner that is either missing when it is needed or present
 * when it is not — and a warning that cries wolf stops being read.
 */
describe("the account's offline state", () => {
  beforeEach(() => {
    resetConnectivityForTest(true);
  });

  it("starts online on a browser that says it is online", () => {
    expect(isAccountOffline()).toBe(false);
    expect(offlineReason()).toBeNull();
  });

  it("is offline when the browser says so", () => {
    resetConnectivityForTest(false);

    expect(isAccountOffline()).toBe(true);
    expect(offlineReason()).toBe("browser");
  });

  it("⚠️ is offline when a request got no answer, even though the browser is happy", () => {
    // The case that broke everything: a phone reports itself online in a lift, on a train,
    // and behind a captive portal. The browser's answer is not evidence; a failed request is.
    reportReachability(false, "TypeError: Failed to fetch");

    expect(isAccountOffline()).toBe(true);
    expect(offlineReason()).toBe("unreachable");
  });

  it("⚠️ stays offline until a request actually succeeds", () => {
    // His rule, second half: offline "直到账号能再从服务器读到信息". A browser going back
    // online is not that — the network can be up while the server is still unreachable.
    reportReachability(false);

    // The browser notices the Wi-Fi came back.
    resetConnectivityForTest(true);
    reportReachability(false);

    expect(isAccountOffline()).toBe(true);

    // Only a real answer clears it.
    reportReachability(true);

    expect(isAccountOffline()).toBe(false);
  });

  it("stays offline while the browser says so, even after a successful request", () => {
    // The union: one signal saying offline is enough, whichever it is.
    resetConnectivityForTest(false);
    reportReachability(true);

    expect(isAccountOffline()).toBe(true);
    expect(offlineReason()).toBe("browser");
  });

  it("prefers the browser's reason when both apply", () => {
    // The one the user can do something about. "Check your connection" is actionable;
    // "the server is not answering" is not, and if the connection is genuinely down the
    // first is the honest answer.
    resetConnectivityForTest(false);
    reportReachability(false);

    expect(offlineReason()).toBe("browser");
  });

  it("does not count twice when the same failure repeats", () => {
    reportReachability(false);
    const first = connectivitySnapshot();

    reportReachability(false);
    reportReachability(false);

    expect(connectivitySnapshot()).toBe(first);
  });

  it("reports the state as a snapshot, for useSyncExternalStore", () => {
    expect(connectivitySnapshot()).toBe(false);

    reportReachability(false);

    expect(connectivitySnapshot()).toBe(true);
  });
});
