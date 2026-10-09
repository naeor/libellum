"""Extract the fields a bookkeeping entry needs, from OCR output.

Rewritten after the owner supplied real screenshots. Every rule below exists
because a real screenshot broke an earlier version of it, and the reasons are
recorded next to each one - the field names and layouts are not documented
anywhere, so this file is the documentation.

What the fixtures got wrong (they were drawn by the same person who wrote the
reader, so they agreed with it):

  * amounts carry a sign or a currency mark - `¥0.10`, `-328.00`, `+50.00` -
    and requiring bare digits found almost none of them
  * the phone's status bar clock is the first `H:MM` on the screen, so the
    entry was dated to the moment the screenshot was taken
  * WeChat writes `2026年9月21日16:55:23` and Alipay writes
    `2026-10-08 12:29:31`; only the first was understood
  * Alipay's bill screen is mostly advertisements, and a `5` from a coupon
    ("5元 天天秒杀") was read as the amount - a wrong number, which is worse
    than no number, because a wrong number gets confirmed
  * a refund is not an expense, and its field names are all different
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# Digits, optional thousands separators, optional decimals. Signs and currency
# marks are stripped first rather than matched, because the recogniser puts
# them wherever it likes - sometimes on their own line, sometimes reading ¥ as 夫.
NUMBER = re.compile(r"^[0-9][0-9,]*(?:\.[0-9]{1,2})?$")

# Everything a currency mark or sign might have been recognised as.
TRIM = " \t¥￥$€£+-－—–·.,:："

# Both shapes, because the two apps disagree. The 月/日 form is WeChat, the
# dashed form is Alipay; a missing space between date and time
# (`2026-10-0809:08:35`) also occurs, so the clock is matched separately.
DATE_WITH_MARKERS = re.compile(r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")
DATE_DASHED = re.compile(r"(20\d{2})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{1,2})")

CLOCK = re.compile(r"(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?")

# Long digit strings are serial numbers, never amounts.
SERIAL_LENGTH = 10

# The status bar sits at the very top. Its clock is a time, but it is the time
# the screenshot was taken, not the time of the transaction.
STATUS_BAR_FRACTION = 0.08

# What the two apps call things. Labels are matched exactly because the
# recogniser is reliable on these - they are short, large and unadorned.
LABEL_AMOUNT_ROW = ("支付时间", "创建时间", "退款时间", "转账时间", "交易时间")
LABEL_COUNTERPARTY_OUT = ("收款方", "商户全称", "收款方全称", "收款账户")
LABEL_COUNTERPARTY_IN = ("付款方", "付款账户", "转账方")
LABEL_NOTE = ("商品", "商品说明", "备注", "转账说明", "说明")

# A refund puts money back, whatever the original entry was.
REFUND_MARKERS = ("退款状态", "退款成功", "已退款", "退款方式", "退款单号")

# Words that mean money came in.
#
# Deliberately NOT 收款方 or 收款账户. Those name the counterparty, and which
# side that is depends on the direction: on a payment, 收款方 is the merchant
# you paid; on money received, 付款方 is the person who paid you. Reading them
# as a direction made an Alipay payment to a game company look like income,
# because its bill screen has a field called 收款方全称.
INCOME_MARKERS = ("收款成功", "已到账", "对方已收", "收款到账")

# Distinctive strings no other app prints. Relying on the word 转账 was wrong:
# it appears in a WeChat refund titled 转账-退款.
CHANNEL_MARKERS: tuple[tuple[str, str], ...] = (
    ("财付通", "WECHAT"),
    ("微信支付", "WECHAT"),
    ("对订单有疑惑", "WECHAT"),
    ("支付宝", "ALIPAY"),
    ("芝麻", "ALIPAY"),
    ("账单管理", "ALIPAY"),
    ("计入收支", "ALIPAY"),
)


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
        return bool(NUMBER.match(self.text.strip().strip(TRIM)))


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
    is_refund: bool = False
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


def _row_value(lines: list[Line], label: str) -> str | None:
    """The text to the right of a label, on the same row."""
    anchor = next((line for line in lines if line.text == label), None)
    if anchor is None:
        return None

    candidates = [
        other
        for other in lines
        if abs(other.top - anchor.top) < max(anchor.height * 0.9, 6) and other.left > anchor.left
    ]
    if not candidates:
        return None

    return min(candidates, key=lambda other: other.left).text


def _first_of(lines: list[Line], labels: tuple[str, ...]) -> str | None:
    for label in labels:
        value = _row_value(lines, label)
        if value is not None:
            return value
    return None


def extract(lines: list[Line]) -> Draft:
    draft = Draft()
    joined = "\n".join(line.text for line in lines)

    # The status bar is the top strip; its clock is not a transaction time.
    tallest = max((line.height for line in lines), default=0)
    lowest = max((line.top for line in lines), default=0)
    status_floor = lowest * STATUS_BAR_FRACTION

    body = [line for line in lines if line.top > status_floor]

    # --- what kind of thing is this? ---------------------------------------
    # Refunds are checked first: a refund screen also says 支付 in places, and
    # the direction of the money is the opposite of what that suggests.
    if any(marker in joined for marker in REFUND_MARKERS):
        draft.is_refund = True
        draft.kind = "income"
    elif any(hint in joined for hint in INCOME_MARKERS):
        draft.kind = "income"
    else:
        draft.kind = "expense"

    # --- amount -------------------------------------------------------------
    # The amount is the largest number on the screen, once signs and currency
    # marks are stripped. Size beats position: the balance line and the coupon
    # amounts further down are smaller, and a coupon's face value is a real
    # number that must never be mistaken for the amount paid.
    numbers = [
        line
        for line in body
        if line.numeric and len(line.text.strip().strip(TRIM)) < SERIAL_LENGTH
    ]

    if numbers:
        biggest = max(numbers, key=lambda line: line.height)
        draft.amount = biggest.text.strip().strip(TRIM).replace(",", "")
    else:
        draft.warnings.append("未能识别金额，请手动填写。")

    # --- date and time ------------------------------------------------------
    for pattern in (DATE_WITH_MARKERS, DATE_DASHED):
        match = pattern.search(joined)
        if match:
            draft.occurred_local_date = (
                f"{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
            )
            break

    if draft.occurred_local_date is None:
        draft.warnings.append("未能识别日期，已按今天填写。")

    # Prefer a time printed next to a label. Failing that, prefer one with
    # seconds - the status bar never shows seconds.
    labelled = _first_of(lines, LABEL_AMOUNT_ROW)
    clock = CLOCK.search(labelled) if labelled else None

    if clock is None:
        with_seconds = [
            match
            for line in body
            for match in [CLOCK.search(line.text)]
            if match and match.group(3) is not None
        ]
        clock = with_seconds[0] if with_seconds else None

    if clock:
        draft.occurred_time = f"{int(clock.group(1)):02d}:{clock.group(2)}"

    # --- channel ------------------------------------------------------------
    # Left unset when nothing distinctive is present. Guessing "bank" from the
    # word 转账 was wrong on a WeChat refund, and a wrong channel is a silent
    # error the user has no reason to check.
    for needle, channel in CHANNEL_MARKERS:
        if needle in joined:
            draft.channel = channel
            break

    # --- counterparty -------------------------------------------------------
    labels = LABEL_COUNTERPARTY_OUT if draft.kind == "expense" else LABEL_COUNTERPARTY_IN
    value = _first_of(lines, labels)
    if value is None:
        value = _first_of(lines, LABEL_COUNTERPARTY_OUT + LABEL_COUNTERPARTY_IN)
    draft.counterparty = value

    # --- serial number, for spotting the same screenshot twice --------------
    for line in lines:
        digits = line.text.replace(" ", "")
        if len(digits) >= 15 and digits.isdigit():
            draft.serial = digits
            break

    # --- note ---------------------------------------------------------------
    draft.note = _first_of(lines, LABEL_NOTE)

    return draft


def describe(draft: Draft) -> str:
    rows = [
        ("金额", draft.amount),
        ("类型", ("退款" if draft.is_refund else "收入" if draft.kind == "income" else "支出")),
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
