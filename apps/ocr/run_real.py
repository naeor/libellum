"""Run the recogniser over the real screenshots the owner provided.

Same pipeline as measure.py, pointed at real-samples/ instead of the generated
fixtures. This is the test that decides whether the feature is worth building:
the fixtures proved the recogniser works on a layout I drew myself, which is
not evidence about a layout somebody else's app produced.
"""

from __future__ import annotations

import os
import sys
import time

from rapidocr_onnxruntime import RapidOCR

from extract import describe, extract, to_lines

REAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "real-samples")

IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".heic")


def main() -> None:
    only = sys.argv[1] if len(sys.argv) > 1 else None

    engine = RapidOCR()

    names = sorted(
        name for name in os.listdir(REAL) if name.lower().endswith(IMAGE_SUFFIXES)
    )
    if only:
        names = [name for name in names if only in name]

    if not names:
        print("real-samples/ 里没有图片。")
        return

    print(f"找到 {len(names)} 张真实截图。\n")

    for name in names:
        path = os.path.join(REAL, name)

        started = time.perf_counter()
        result, _ = engine(path)
        elapsed = time.perf_counter() - started

        print("=" * 70)
        print(f"  {name}    {elapsed:.2f}s")
        print("=" * 70)

        if not result:
            print("  (没有识别出任何文字)\n")
            continue

        lines = to_lines(result)
        scores = [line.score for line in lines]

        for line in lines:
            flag = "  " if line.score >= 0.9 else ("? " if line.score >= 0.6 else "! ")
            print(f"  {flag}[{line.score:.3f}] h={line.height:5.1f}  {line.text}")

        print("-" * 70)
        print(f"  行数 {len(lines)}   平均 {sum(scores) / len(scores):.3f}   最低 {min(scores):.3f}   耗时 {elapsed:.2f}s")
        print(describe(extract(lines)))
        print()


if __name__ == "__main__":
    main()
