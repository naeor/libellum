import {
  MAX_RECOGNIZE_BYTES,
  MAX_RECOGNIZE_IMAGES,
  recognizeResponseSchema,
  type OcrItemResult,
} from "@libellum/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { badRequest } from "../lib/errors.js";
import type { OcrService } from "../ocr/client.js";

interface RecognizeRouteOptions {
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
  /** Only these two are needed, so a stub can stand in without the rest. */
  readonly ocr: Pick<OcrService, "recognize">;
}

/**
 * `POST /api/v1/recognize` — read screenshots, return guesses.
 *
 * Nothing is saved. The endpoint's whole job is to turn an image into fields
 * the user can confirm, and the image is gone by the time it answers.
 *
 * Limits are enforced here as well as in the recogniser, because this is the
 * boundary that faces the network. The recogniser checks again for the day
 * something else calls it.
 */

/**
 * Identify an image by its contents.
 *
 * The declared `Content-Type` is whatever the client felt like sending; a file
 * renamed to `.png` is a text file with a misleading name. The first bytes are
 * not something a caller can choose independently of the actual data.
 */
function sniffImage(buffer: Buffer): "png" | "jpeg" | "webp" | "heic" | null {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "png";
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }

  // ftyp....heic / heix / hevc / mif1 — an iPhone photo rather than a screenshot.
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12);
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      return "heic";
    }
  }

  return null;
}

export function registerRecognizeRoutes(app: FastifyInstance, options: RecognizeRouteOptions): void {
  const { requireAuth, ocr } = options;

  app.post("/api/v1/recognize", { preHandler: requireAuth }, async (request) => {
    if (!request.isMultipart()) {
      throw badRequest("expected_multipart", "请以上传图片的方式提交。");
    }

    const images: { buffer: Buffer; declared: string }[] = [];

    for await (const part of request.files()) {
      if (images.length >= MAX_RECOGNIZE_IMAGES) {
        throw badRequest(
          "too_many_images",
          `一次最多上传 ${String(MAX_RECOGNIZE_IMAGES)} 张截图。`,
        );
      }

      // Read into memory. The stream is never piped to a file, so there is no
      // window in which the screenshot exists on disk.
      const buffer = await part.toBuffer();

      if (buffer.length === 0) {
        throw badRequest("empty_image", "有一张图片是空的。");
      }

      if (buffer.length > MAX_RECOGNIZE_BYTES) {
        throw badRequest(
          "image_too_large",
          `有图片超过 ${String(Math.floor(MAX_RECOGNIZE_BYTES / 1024 / 1024))}MB。`,
        );
      }

      const kind = sniffImage(buffer);

      if (kind === "heic") {
        // Said plainly rather than as a generic failure: the user can act on
        // this by taking a screenshot, and cannot act on "unsupported format".
        throw badRequest(
          "heic_not_supported",
          "暂不支持 HEIC 格式（iPhone 相册原图）。请用截图，或先在相册里存为 JPG。",
        );
      }

      if (kind === null) {
        throw badRequest("not_an_image", "有文件不是图片（即使扩展名是 .png 也不是）。");
      }

      images.push({ buffer, declared: part.mimetype });
    }

    if (images.length === 0) {
      throw badRequest("no_images", "没有收到图片。");
    }

    const started = Date.now();

    // Sequential, not parallel: the recogniser is one process using the CPU,
    // and firing five requests at it at once would make every one of them
    // slower without finishing the batch any sooner.
    const items: OcrItemResult[] = [];
    for (const [index, image] of images.entries()) {
      items.push(await ocr.recognize(image.buffer, index));
    }

    return recognizeResponseSchema.parse({
      items,
      seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
    });
  });
}
