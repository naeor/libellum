"""Run the recogniser over the sample screenshots and report what came back.

This exists to answer one question with evidence rather than opinion: does OCR
work well enough on payment screenshots to save somebody typing? It prints the
raw lines, the confidence, the elapsed time, and then whether the two fields
that actually matter could be pulled out.

Nothing here is product code. It is a measurement.
"""

from __future__ import annotations

import os
import re
import sys
import time

from rapidocr_onnxruntime import RapidOCR

SAMPLES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")

AMOUNT = re.compile(r"[¥￥]\s*([0-9][0-9,]*\.?[0-9]{0,2})")
DATE = re.compile(r"(20\d{2})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*[日]?")
TIME = re.compile(r"(\d{1,2})\s*[:：]\s*(\d{2})")


def main() -> None:
    engine = RapidOCR()
    paths = sorted(os.path.join(SAMPLES, name) for name in os.listdir(SAMPLES) if name.endswith(".png"))

    for path in paths:
        name = os.path.basename(path)
        print("=" * 66)
        print(f"  {name}")
        print("=" * 66)

        started = time.perf_counter()
        result, _ = engine(path)
        elapsed = time.perf_counter() - started

        if not result:
            print("  (没有识别出任何文字)")
            continue

        scores = []
        lines: list[str] = []

        for _box, text, score in result:
            scores.append(float(score))
            lines.append(text)
            print(f"  [{float(score):.3f}] {text}")

        joined = "\n".join(lines)
        average = sum(scores) / len(scores)
        lowest = min(scores)

        print("-" * 66)
        print(f"  行数 {len(lines)}   平均置信度 {average:.3f}   最低 {lowest:.3f}   耗时 {elapsed:.2f}s")

        amount = AMOUNT.search(joined)
        date = DATE.search(joined)
        clock = TIME.search(joined)

        print(f"  金额   -> {amount.group(1) if amount else '未识别'}")
        print(
            "  日期   -> "
            + (f"{date.group(1)}-{int(date.group(2)):02d}-{int(date.group(3)):02d}" if date else "未识别")
        )
        print(f"  时间   -> {clock.group(0).replace('：', ':') if clock else '未识别'}")
        print()


if __name__ == "__main__":
    sys.exit(main())
