import type { OcrItemResult } from "@libellum/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, resetDatabase, signUp } from "./support.js";

/**
 * The screenshot endpoint.
 *
 * The recogniser is stubbed. Loading real models would add about a minute to
 * every run and make the API's tests depend on a Python environment being
 * installed — and none of what is being checked here is the recogniser's
 * accuracy. What is checked is the boundary: who may call it, what it refuses,
 * and that nothing is written to disk.
 */
const calls: Buffer[] = [];

function stubOcr() {
  return {
    recognize: (image: Buffer, index: number): Promise<OcrItemResult> => {
      calls.push(image);

      return Promise.resolve({
        index,
        ok: true,
        draft: {
          amount: "328.00",
          currency: "CNY",
          occurredLocalDate: "2026-09-21",
          occurredTime: "16:55",
          kind: "expense",
          channel: "WECHAT",
          counterparty: "Apple Distribution International",
          note: null,
          serial: "4200003225202609228616685603",
          isRefund: false,
          warnings: [],
        },
        error: null,
        message: null,
        lineCount: 30,
        averageConfidence: 0.9834,
        seconds: 1.2,
      });
    },
    stop: (): void => undefined,
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = makeApp({ ocr: stubOcr() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase();
  calls.length = 0;
});

/** A one-pixel PNG — enough to pass content sniffing. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function multipart(files: readonly { readonly field: string; readonly filename: string; readonly type: string; readonly body: Buffer }[]): {
  readonly payload: Buffer;
  readonly headers: Record<string, string>;
} {
  const boundary = "----libellumtestboundary";
  const chunks: Buffer[] = [];

  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`,
        "utf8",
      ),
      file.body,
      Buffer.from("\r\n", "utf8"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

describe("POST /recognize", () => {
  it("returns a draft for a screenshot", async () => {
    const cookie = await signUp(app, "mama");
    const form = multipart([{ field: "file", filename: "shot.png", type: "image/png", body: PNG_BYTES }]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/recognize",
      headers: { ...form.headers, cookie },
      payload: form.payload,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as { items: OcrItemResult[]; seconds: number };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.draft?.amount).toBe("328.00");
    expect(body.items[0]?.draft?.channel).toBe("WECHAT");
    expect(typeof body.seconds).toBe("number");
  });

  it("passes the image bytes through untouched", async () => {
    const cookie = await signUp(app, "papa");
    const form = multipart([{ field: "file", filename: "shot.png", type: "image/png", body: PNG_BYTES }]);

    await app.inject({
      method: "POST",
      url: "/api/v1/recognize",
      headers: { ...form.headers, cookie },
      payload: form.payload,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.equals(PNG_BYTES)).toBe(true);
  });

  it("numbers each item so a result can be matched to its thumbnail", async () => {
    const cookie = await signUp(app, "sister");
    const form = multipart([
      { field: "file", filename: "a.png", type: "image/png", body: PNG_BYTES },
      { field: "file", filename: "b.jpg", type: "image/jpeg", body: JPEG_BYTES },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/recognize",
      headers: { ...form.headers, cookie },
      payload: form.payload,
    });

    const body = response.json() as { items: OcrItemResult[] };
    expect(body.items.map((item) => item.index)).toEqual([0, 1]);
  });

  it("refuses a file that is not an image, whatever it claims to be", async () => {
    const cookie = await signUp(app, "uncle");
    const form = multipart([
      {
        field: "file",
        filename: "shot.png",
        type: "image/png",
        body: Buffer.from("this is definitely not a png", "utf8"),
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/recognize",
      headers: { ...form.headers, cookie },
      payload: form.payload,
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe("not_an_image");
    // Nothing reached the recogniser.
    expect(calls).toHaveLength(0);
  });

  it("explains HEIC rather than failing vaguely", async () => {
    const cookie = await signUp(app, "aunt");
    // ftyp box, brand heic: an iPhone photo rather than a screenshot.
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from("ftypheic", "ascii"),
      Buffer.alloc(12),
    ]);
    const form = multipart([{ field: "file", filename: "photo.heic", type: "image/heic", body: heic }]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/recognize",
      headers: { ...form.headers, cookie },
      payload: form.payload,
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { code: string; message: string };
    expect(body.code).toBe("heic_not_supported");
    // The message has to tell the user what to do about it.
    expect(body.message).toContain("截图");
  });

  it("refuses more than the limit", async () => {
    const cookie = await signUp(app, "cousin");
    const form = multipart(
      Array.from({ length: 6 }, (_, index) => ({
        field: "file",
        filename: `shot-${String(index)}.png`,
        type: "image/png",
        body: PNG_BYTES,
      })),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/recognize",
      headers: { ...form.headers, cookie },
      payload: form.payload,
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe("too_many_images");
  });

  it("refuses a request with no images", async () => {
    const cookie = await signUp(app, "grandma");
    const form = multipart([]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/recognize",
      headers: { ...form.headers, cookie },
      payload: form.payload,
    });

    expect(response.statusCode).toBe(400);
  });

  it("requires a session", async () => {
    const form = multipart([{ field: "file", filename: "shot.png", type: "image/png", body: PNG_BYTES }]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/recognize",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
