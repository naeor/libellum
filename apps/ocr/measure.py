"""Measure the recogniser and the extractor over the sample screenshots.

Two numbers matter and they are different numbers:

  * **how long it takes** - this decides whether the feature feels instant or
    whether it needs a progress indicator
  * **how often the fields come out right** - this decides whether the feature
    saves typing or costs more time than it saves

The first call is discarded: it includes loading the models, which happens once
per server start, not once per screenshot.
"""

from __future__ import annotations

import os
import time

from rapidocr_onnxruntime import RapidOCR

from extract import describe, extract, to_lines

SAMPLES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")


def main() -> None:
    engine = RapidOCR()
    paths = sorted(os.path.join(SAMPLES, name) for name in os.listdir(SAMPLES) if name.endswith(".png"))

    print("预热（加载模型，只发生一次）…")
    engine(paths[0])
    print("完成。\n")

    timings: list[float] = []

    for path in paths:
        name = os.path.basename(path)
        started = time.perf_counter()
        result, _ = engine(path)
        elapsed = time.perf_counter() - started
        timings.append(elapsed)

        lines = to_lines(result or [])
        draft = extract(lines)

        print("=" * 62)
        print(f"  {name}    {elapsed:.2f}s")
        print("=" * 62)
        print(f"  识别到 {len(lines)} 行，平均置信度 "
              f"{sum(line.score for line in lines) / max(len(lines), 1):.3f}")
        print(describe(draft))
        print()

    print("=" * 62)
    print(f"  平均耗时（不含模型加载）：{sum(timings) / len(timings):.2f}s")
    print(f"  最慢：{max(timings):.2f}s   最快：{min(timings):.2f}s")
    print("=" * 62)


if __name__ == "__main__":
    main()
