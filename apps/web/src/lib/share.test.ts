import { afterEach, describe, expect, it, vi } from "vitest";

import { canShareFiles, deliverFile, toFile } from "./share.js";

/**
 * The delivery path, tested at its decision points.
 *
 * These run without a DOM: the module touches `navigator`, `document` and
 * `URL.createObjectURL` only inside the functions under test, so each can be
 * stubbed. That keeps the suite fast and, more importantly, keeps the *decisions*
 * — share or download, cancelled or failed — testable at all, which they are not
 * when the whole thing is buried in an event handler.
 */

/** A one-pixel PNG. Real bytes, so `toFile` is exercised for real. */
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

const CSV_BYTES = new TextEncoder().encode("日期,金额\n2026-10-10,12.34");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("toFile", () => {
  it("keeps the bytes exactly, including those above 0x7f", () => {
    const file = toFile("pixel.png", "image/png", PNG_BYTES);

    expect(file.name).toBe("pixel.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(PNG_BYTES.length);
  });

  it("keeps a UTF-8 CSV's byte length and its Chinese name", () => {
    const file = toFile("账目.csv", "text/csv", CSV_BYTES);

    expect(file.name).toBe("账目.csv");
    expect(file.type).toBe("text/csv");
    // Three bytes per Chinese character: proof the bytes were not re-encoded as
    // Latin-1 somewhere on the way.
    expect(file.size).toBe(CSV_BYTES.length);
    expect(file.size).toBeGreaterThan("日期,金额".length);
  });
});

describe("canShareFiles", () => {
  it("is false when the browser has no share capability at all", () => {
    vi.stubGlobal("navigator", {});
    expect(canShareFiles(new File(["x"], "a.csv"))).toBe(false);
  });

  it("is false when canShare is present but refuses files", () => {
    vi.stubGlobal("navigator", { canShare: () => false });
    expect(canShareFiles(new File(["x"], "a.csv"))).toBe(false);
  });

  it("is true when the browser says it can share this file", () => {
    vi.stubGlobal("navigator", { canShare: () => true });
    expect(canShareFiles(new File(["x"], "a.csv"))).toBe(true);
  });

  it("asks about files, not about sharing in general", () => {
    const canShare = vi.fn(() => true);
    vi.stubGlobal("navigator", { canShare });

    canShareFiles(new File(["x"], "a.csv"));

    // iOS Safari answers true for text and false for files; asking the wrong
    // question sends the user to a sheet that cannot accept what they made.
    expect(canShare).toHaveBeenCalledWith({ files: [expect.any(File)] });
  });
});

describe("deliverFile", () => {
  function stubDownload(): { clicked: string[] } {
    const clicked: string[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:test",
      revokeObjectURL: () => undefined,
    });
    vi.stubGlobal("document", {
      createElement: () => ({
        href: "",
        download: "",
        rel: "",
        click: () => {
          clicked.push("click");
        },
        remove: () => undefined,
      }),
      body: { append: () => undefined },
    });

    return { clicked };
  }

  it("shares when the platform can, and reports that it shared", async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { canShare: () => true, share });

    const outcome = await deliverFile("账目.csv", "text/csv", CSV_BYTES);

    expect(outcome).toEqual({ method: "share", cancelled: false });
    expect(share).toHaveBeenCalledOnce();
  });

  it("treats a dismissed share sheet as a choice, not a failure", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("dismissed", "AbortError");
    });
    vi.stubGlobal("navigator", { canShare: () => true, share });
    const { clicked } = stubDownload();

    const outcome = await deliverFile("账目.csv", "text/csv", CSV_BYTES);

    expect(outcome).toEqual({ method: "share", cancelled: true });
    // And crucially: no download. Someone who closes the sheet did not ask for
    // a file in their downloads folder.
    expect(clicked).toHaveLength(0);
  });

  it("falls back to downloading when sharing breaks", async () => {
    const share = vi.fn(async () => {
      throw new Error("share is not really available");
    });
    vi.stubGlobal("navigator", { canShare: () => true, share });
    const { clicked } = stubDownload();

    const outcome = await deliverFile("账目.csv", "text/csv", CSV_BYTES);

    expect(outcome).toEqual({ method: "download", cancelled: false });
    expect(clicked).toHaveLength(1);
  });

  it("downloads when the platform cannot share files at all", async () => {
    vi.stubGlobal("navigator", { canShare: () => false });
    const { clicked } = stubDownload();

    const outcome = await deliverFile("账目.xlsx", "application/vnd.ms-excel", PNG_BYTES);

    expect(outcome).toEqual({ method: "download", cancelled: false });
    expect(clicked).toHaveLength(1);
  });
});
