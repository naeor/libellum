"""Extract the fields a bookkeeping entry needs, from OCR output.

The lesson this file exists to demonstrate: **recognition and extraction are
different problems.** The recogniser turned the pixels into text almost
perfectly - confidence 0.97 to 1.00 on every sample - and the first version of
this file still failed to find two of the three amounts, because it looked for
a currency mark *immediately* before the digits. The recogniser had put the ¥
on its own line, and on one sample had read it as 夫.

So the extraction does not rely on the text alone. It uses what the screenshot
layout tells us: the amount is the **largest** text on the screen, and the time
is next to the word 时间. Both facts survive an imperfect reading of the
smaller print, which is exactly the property we need - the recogniser does not
have to be perfect, only good enough on the few fields that matter.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# Digits with optional thousands separators and up to two decimals. The
# currency mark is deliberately NOT part of this: it is often read as its own
# token, or as another character entirely.
NUMBER = re.compile(r"^[0-9][0-9,]*(?:\.[0-9]{1,2})?$")

DATE = re.compile(r"(20\d{2})\s*年?\s*[-\/]?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?")
CLOCK = re.compile(r"(\d{1,2})\s*[:：]\s*(\d{2})")

# Long digit strings are serial numbers, never amounts.
SERIAL_LENGTH = 10

# Which payment channel a screenshot came from, by the words it shows. Order
# matters: the first match wins, so the more specific patterns come first.
CHANNELS: tuple[tuple[str, str], ...] = (
    ("微信", "WECHAT"),
    ("支付宝", "ALIPAY"),
    ("银行", "BANK"),
    ("转账", "BANK"),
)

# Whether the money came in or went out.
INCOME_HINTS = ("收款成功", "已到账", "收款方", "对方已收")
EXPENSE_HINTS = ("支付成功", "已支付", "付款", "转账成功")


@dataclass
class Line:
    """One recognised run of text, with the size it was drawn at."""

    text: str
    score: float
    height: float
    top: float
    left: float

    @property
    def numeric(self) -> bool:
        return bool(NUMBER.match(self.text.strip()))


@dataclass
class Draft:
    """What we think the entry is. Every field is a guess, and every guess is
    shown to the user for correction - that is the whole design."""

    amount: str | None = None
    currency: str = "CNY"
    occurred_local_date: str | None = None
    occurred_time: str | None = None
    kind: str = "expense"
    channel: str | None = None
    counterparty: str | None = None
    note: str | None = None
    serial: str | None = None
    warnings: list[str] = field(default_factory=list)


def to_lines(result: list[Any]) -> list[Line]:
    lines: list[Line] = []

    for box, text, score in result:
        ys = [float(point[1]) for point in box]
        xs = [float(point[0]) for point in box]
        lines.append(
            Line(
                text=str(text).strip(),
                score=float(score),
                height=max(ys) - min(ys),
                top=min(ys),
                left=min(xs),
            )
        )

    return lines


def extract(lines: list[Line]) -> Draft:
    draft = Draft()
    joined = "\n".join(line.text for line in lines)

    # --- amount -------------------------------------------------------------
    # The amount is the largest number on the screen. Size is a far more
    # reliable signal than the currency mark, which is small, thin and easily
    # confused with other characters.
    numbers = [line for line in lines if line.numeric and len(line.text) < SERIAL_LENGTH]

    if numbers:
        biggest = max(numbers, key=lambda line: line.height)
        draft.amount = biggest.text.replace(",", "")
    else:
        draft.warnings.append("未能识别金额，请手动填写。")

    # --- date and time ------------------------------------------------------
    date = DATE.search(joined)
    if date:
        draft.occurred_local_date = (
            f"{date.group(1)}-{int(date.group(2)):02d}-{int(date.group(3)):02d}"
        )
    else:
        draft.warnings.append("未能识别日期，已按今天填写。")

    clock = CLOCK.search(joined)
    if clock:
        draft.occurred_time = f"{int(clock.group(1)):02d}:{clock.group(2)}"

    # --- channel and direction ---------------------------------------------
    for needle, channel in CHANNELS:
        if needle in joined:
            draft.channel = channel
            break

    if any(hint in joined for hint in INCOME_HINTS):
        draft.kind = "income"
    elif any(hint in joined for hint in EXPENSE_HINTS):
        draft.kind = "expense"

    # --- counterparty -------------------------------------------------------
    # Which label holds the counterparty depends on the direction: for money
    # going out it is whoever received it, for money coming in it is whoever
    # sent it. Taking whichever label happens to appear first gets the payer's
    # own account number on a transfer, which is worse than showing nothing -
    # it looks like a real answer.
    labels = (
        ("收款方", "收款账户", "商户全称")
        if draft.kind == "expense"
        else ("付款方", "付款账户", "转账方")
    )

    for label in labels:
        match = next((line for line in lines if line.text == label), None)
        if match is None:
            continue

        same_row = [
            other
            for other in lines
            if abs(other.top - match.top) < match.height * 0.8 and other.left > match.left
        ]
        if same_row:
            draft.counterparty = min(same_row, key=lambda other: other.left).text
            break

    # --- serial number, for spotting the same screenshot twice --------------
    for line in lines:
        digits = line.text.replace(" ", "")
        if len(digits) >= 15 and digits.isdigit():
            draft.serial = digits
            break

    # --- note ---------------------------------------------------------------
    for line in lines:
        if line.text in ("备注", "转账说明", "商品", "说明"):
            same_row = [
                other
                for other in lines
                if abs(other.top - line.top) < line.height * 0.8 and other.left > line.left
            ]
            if same_row:
                draft.note = min(same_row, key=lambda other: other.left).text
            break

    return draft


def describe(draft: Draft) -> str:
    rows = [
        ("金额", draft.amount),
        ("类型", "收入" if draft.kind == "income" else "支出"),
        ("渠道", draft.channel),
        ("日期", draft.occurred_local_date),
        ("时间", draft.occurred_time),
        ("对方", draft.counterparty),
        ("备注", draft.note),
        ("单号", draft.serial),
    ]

    out = "\n".join(f"    {label}：{value if value is not None else '—'}" for label, value in rows)

    if draft.warnings:
        out += "\n    " + "\n    ".join(f"⚠ {warning}" for warning in draft.warnings)

    return out
