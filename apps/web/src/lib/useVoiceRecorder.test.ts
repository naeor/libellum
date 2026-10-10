import { describe, expect, it } from "vitest";

import { describeBlocker, detectBlocker, isSecureContextForMedia } from "./useVoiceRecorder.js";

/**
 * Telling apart "this browser cannot" from "this address cannot".
 *
 * ⚠️ **This is the bug the owner hit.** Reached at `http://192.168.0.184:5173` —
 * how a phone on the home Wi-Fi reaches the dev machine — `getUserMedia` is not
 * defined, and the screen said "这个浏览器不支持录音". The browser supported it
 * perfectly; the *URL* did not, because media APIs are secure-context only and
 * over plain HTTP the browser never defines them at all.
 *
 * The two are indistinguishable by feature detection alone, which is why the
 * context is asked about first — and why this deserves a test rather than a
 * comment. The context arrives as an argument so it can be tested here: this
 * package's test environment is `node`, with no `window`.
 */

/** A browser that can record, on a secure origin. */
const CAPABLE = {
  isSecureContext: true,
  protocol: "https:",
  hasGetUserMedia: true,
  hasMediaRecorder: true,
};

describe("isSecureContextForMedia", () => {
  it("accepts a secure context", () => {
    expect(isSecureContextForMedia(CAPABLE)).toBe(true);
  });

  it("accepts https even without the flag", () => {
    // The flag is the browser's own answer, but it is not universal.
    expect(isSecureContextForMedia({ ...CAPABLE, isSecureContext: false })).toBe(true);
  });

  it("rejects plain http on a LAN address", () => {
    // The exact situation: `http://192.168.0.184:5173` from a phone.
    expect(
      isSecureContextForMedia({
        isSecureContext: false,
        protocol: "http:",
        hasGetUserMedia: false,
        hasMediaRecorder: false,
      }),
    ).toBe(false);
  });
});

describe("detectBlocker", () => {
  it("finds nothing wrong with a capable browser on https", () => {
    expect(detectBlocker(CAPABLE)).toBeNull();
  });

  it("blames the address when the context is insecure", () => {
    // The important one. Note that the media APIs are *also* missing — that is
    // what an insecure context does — so a check that only looked at features
    // would say "unsupported" and send the user to the wrong place.
    expect(
      detectBlocker({
        isSecureContext: false,
        protocol: "http:",
        hasGetUserMedia: false,
        hasMediaRecorder: false,
      }),
    ).toBe("insecure-context");
  });

  it("blames the browser only when the context is fine", () => {
    expect(detectBlocker({ ...CAPABLE, hasGetUserMedia: false })).toBe("unsupported");
    expect(detectBlocker({ ...CAPABLE, hasMediaRecorder: false })).toBe("unsupported");
  });
});

describe("describeBlocker", () => {
  it("names the address, not the browser, when the context is insecure", () => {
    // The owner read "不支持录音" and went looking at his browser. The cause was
    // the URL, and naming it costs one string.
    const message = describeBlocker("insecure-context") ?? "";

    expect(message).toContain("https");
    expect(message).not.toContain("这个浏览器不支持");
  });

  it("says the browser is the problem only when it really is", () => {
    expect(describeBlocker("unsupported")).toContain("这个浏览器不支持录音");
  });

  it("says nothing when nothing is wrong", () => {
    expect(describeBlocker(null)).toBeNull();
  });
});
