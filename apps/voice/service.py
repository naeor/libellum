"""The speech-to-text sidecar.

A long-lived process that reads one JSON request per line on stdin and writes one
JSON response per line on stdout, exactly like the OCR sidecar next to it. Node
starts it on the first transcription and then talks to it for the life of the
server.

The three decisions the OCR service made apply here for the same reasons, and one
of them matters more:

**Long-lived, not one process per request.** Loading the `base` model takes about
six seconds and 147 MB. Paying that per recording would make a two-second
sentence take eight.

**stdin/stdout, not HTTP.** A pipe has no address, so there is nothing to expose
and nothing to authenticate.

**Audio arrives as base64 in the message, never as a file path.** This is the
part that matters more here than for screenshots: **a recording of somebody's
voice is the most sensitive thing this project ever handles.** It is decoded in
memory, transcribed, and dropped. Nothing is written to disk, so there is no
temporary file to forget, no backup that quietly keeps a copy, and no path to get
wrong.

A fourth decision is this service's own:

**One engine behind a narrow interface.** `transcribe()` below is the only thing
the caller knows about, so swapping whisper.cpp for `faster-whisper`, a hosted
API, or the browser's own speech engine is a change to this file and nothing
else. The owner asked for that split explicitly, and it is the right seam: the
part that is hard to get right is the *recognition*, and the part that is easy to
get wrong in a dozen small ways is turning a sentence into five fields.

Protocol, one JSON object per line:

    -> {"id": "1", "audio": "<base64>", "language": "zh"}
    <- {"id": "1", "ok": true, "text": "午饭 38", "seconds": 1.2}

On startup it prints {"ready": true} so the caller knows the model is loaded
rather than guessing with a sleep.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import os
import sys
import time
import traceback

import av
import numpy as np

# Whisper only ever wants this: 16 kHz, mono, float32 in [-1, 1].
TARGET_RATE = 16_000

# Refuse anything unreasonable before decoding. Ten minutes of speech is far more
# than a sentence about lunch, and the API enforces its own limit too — both ends
# check because either could be called by something else one day.
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_SECONDS = 60

# The owner chose the model. `base` misheard 午饭 as 五份 — a tonal distinction
# that matters in Chinese and that the smallest models are known to lose — so he
# asked for one step up. `small` is 466 MB against `base`'s 148, still comfortable
# on a 2 GB server, and noticeably better on Mandarin.
#
# Overridable so the choice can be revisited on a real phone without editing code,
# and named in the startup line so a log says which one is actually loaded rather
# than which one was intended.
MODEL_NAME = os.environ.get("LIBELLUM_WHISPER_MODEL", "small")
THREADS = int(os.environ.get("LIBELLUM_WHISPER_THREADS", "4"))


def decode_audio(payload: str) -> np.ndarray:
    """Decode any container the browser produced into 16 kHz mono float32.

    PyAV rather than a WAV reader because the browser decides the format, not us:
    Chrome records `audio/webm;codecs=opus`, Safari records `audio/mp4` with AAC.
    Handing either to a WAV parser produces silence at best, and both are decoded
    here by the same code path, which is one fewer difference between browsers to
    discover on a phone.

    Raises `ValueError` with a reason the caller can show, rather than letting a
    decoder exception surface as a 500.
    """
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("audio_not_base64") from error

    if len(raw) > MAX_AUDIO_BYTES:
        raise ValueError("audio_too_large")

    try:
        container = av.open(io.BytesIO(raw))
    except av.AVError as error:
        raise ValueError("audio_undecodable") from error

    try:
        stream = next(s for s in container.streams if s.type == "audio")
    except StopIteration as error:
        raise ValueError("audio_undecodable") from error

    # `to_ndarray` gives (samples, channels) as int16 for most codecs; the
    # resampler converts to the rate, layout and format whisper wants in one
    # step, so nothing downstream has to know what the browser chose.
    resampler = av.audio.resampler.AudioResampler(
        format="fltp",
        layout="mono",
        rate=TARGET_RATE,
    )

    chunks: list[np.ndarray] = []
    total = 0

    for frame in container.decode(stream):
        for converted in resampler.resample(frame):
            samples = converted.to_ndarray()
            chunks.append(samples.reshape(-1))
            total += samples.size

            # Stop early rather than decoding a long file the API would refuse
            # anyway: the cost of decoding is the cost of holding it.
            if total > TARGET_RATE * MAX_SECONDS:
                raise ValueError("audio_too_long")

    # Flush whatever the resampler is still holding.
    for converted in resampler.resample(None):
        samples = converted.to_ndarray()
        chunks.append(samples.reshape(-1))

    container.close()

    if not chunks:
        raise ValueError("audio_empty")

    audio = np.concatenate(chunks).astype(np.float32)

    if audio.size == 0:
        raise ValueError("audio_empty")

    return audio


def main() -> int:
    # Imported here, not at module scope, so `decode_audio` can be imported and
    # tested without loading a 147 MB model.
    from pywhispercpp.model import Model

    print(json.dumps({"ready": False, "loading": True}), flush=True)

    model = Model(
        MODEL_NAME,
        n_threads=THREADS,
        print_realtime=False,
        print_progress=False,
    )

    print(json.dumps({"ready": True, "model": MODEL_NAME}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if line == "":
            continue

        started = time.time()
        request_id = None

        try:
            request = json.loads(line)
            request_id = request.get("id")
            language = request.get("language")

            audio = decode_audio(request["audio"])

            segments = model.transcribe(
                audio,
                language=language,
                # One sentence about a purchase: no context to carry, and keeping
                # it avoids whisper inventing continuity between two recordings
                # that have nothing to do with each other.
                no_context=True,
            )

            text = "".join(getattr(segment, "text", "") for segment in segments).strip()

            print(
                json.dumps(
                    {
                        "id": request_id,
                        "ok": True,
                        "text": text,
                        "seconds": round(time.time() - started, 2),
                        "audioSeconds": round(audio.size / TARGET_RATE, 2),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except ValueError as error:
            print(
                json.dumps(
                    {"id": request_id, "ok": False, "error": str(error), "message": MESSAGES.get(str(error), "音频无法识别。")},
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:  # noqa: BLE001 - one bad request must not kill the service
            traceback.print_exc(file=sys.stderr)
            print(
                json.dumps(
                    {
                        "id": request_id,
                        "ok": False,
                        "error": "transcribe_failed",
                        "message": "识别失败，请再试一次。",
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    return 0


MESSAGES = {
    "audio_not_base64": "录音数据无法解码。",
    "audio_too_large": "录音文件过大。",
    "audio_too_long": f"录音超过 {MAX_SECONDS} 秒，请说短一点。",
    "audio_undecodable": "录音格式无法识别。",
    "audio_empty": "没有录到声音。",
}


if __name__ == "__main__":
    sys.exit(main())
