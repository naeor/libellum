"""The OCR sidecar.

A long-lived process that reads one JSON request per line on stdin and writes
one JSON response per line on stdout. Node spawns it once at boot and talks to
it for the life of the server.

Three decisions worth stating.

**Long-lived, not one process per request.** Loading the models takes about two
seconds. Per-request processes would add that to every recognition, turning a
1.5-second feature into a 3.5-second one for no benefit.

**stdin/stdout, not HTTP.** A local HTTP service would need a port, and a port
needs deciding who may reach it. A pipe has no address, so there is nothing to
expose and nothing to authenticate.

**Base64 in the message, never a file path.** The images are payment
screenshots. They are decoded in memory, recognised, and dropped. Nothing is
written to disk at any point, so there is no temporary file to clean up, no
backup that quietly keeps a copy, and no path to get wrong.

Protocol, one JSON object per line:

    -> {"id": "1", "image": "<base64>"}
    <- {"id": "1", "ok": true, "draft": {...}, "lines": 19, "seconds": 1.2}

On startup it prints {"ready": true} so the caller knows the models are loaded
rather than guessing with a sleep.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import sys
import time
import traceback
from dataclasses import asdict

from PIL import Image, UnidentifiedImageError
from rapidocr_onnxruntime import RapidOCR

from extract import extract, to_lines

# Refuse anything unreasonable before decoding it. The API enforces this too;
# both ends check because either could be called by something else one day.
MAX_IMAGE_BYTES = 10 * 1024 * 1024


def recognise(engine: RapidOCR, payload: str) -> dict:
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        return {"ok": False, "error": "image_not_base64", "message": "图片数据无法解码。"}

    if len(raw) > MAX_IMAGE_BYTES:
        return {"ok": False, "error": "image_too_large", "message": "图片超过 10MB。"}

    # Open through Pillow rather than handing the recogniser raw bytes: it gives
    # a clear failure for a file that is not an image at all, and normalises
    # modes the recogniser would otherwise have to guess at.
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            converted = image.convert("RGB")
    except (UnidentifiedImageError, OSError):
        return {"ok": False, "error": "not_an_image", "message": "这不是一张图片。"}

    started = time.perf_counter()
    result, _ = engine(converted)
    elapsed = time.perf_counter() - started

    lines = to_lines(result or [])
    draft = extract(lines)

    scores = [line.score for line in lines]

    return {
        "ok": True,
        "draft": asdict(draft),
        "lineCount": len(lines),
        "averageConfidence": round(sum(scores) / len(scores), 4) if scores else 0.0,
        "seconds": round(elapsed, 3),
    }


def main() -> None:
    engine = RapidOCR()

    # Tell the caller the models are loaded. Without this the caller has to
    # sleep and hope, which is either too slow or occasionally too fast.
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if line == "":
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "error": "bad_request", "message": "请求不是有效 JSON。"}), flush=True)
            continue

        request_id = request.get("id")

        try:
            response = recognise(engine, request.get("image", ""))
        except Exception:  # noqa: BLE001 - the service must not die on one bad image
            response = {
                "ok": False,
                "error": "recognition_failed",
                "message": "识别过程出错。",
                "detail": traceback.format_exc(limit=3),
            }

        response["id"] = request_id
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
