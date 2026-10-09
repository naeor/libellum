"""Draw a few payment screenshots for OCR testing.

These stand in for what a user would upload: screenshots of WeChat Pay, Alipay
and a bank transfer. They are drawn rather than downloaded because the point is
to test the recogniser on the layout and wording these screens actually use —
and because a test fixture should not depend on somebody else's server.

Deliberately plain: a screenshot is already a clean, flat, high-contrast image,
which is exactly the case OCR handles well, and that is what we are checking.
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")

# Windows ships these; a missing one would only change the glyphs, not the test.
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def make(
    name: str,
    title: str,
    amount: str,
    rows: list[tuple[str, str]],
    accent: tuple[int, int, int],
    footer: str,
) -> None:
    width, height = 828, 1472  # A 390pt phone at 2x, i.e. a real screenshot size.
    image = Image.new("RGB", (width, height), (247, 247, 247))
    draw = ImageDraw.Draw(image)

    draw.rectangle([0, 0, width, 150], fill=(255, 255, 255))
    draw.text((width / 2, 60), title, font=font(34), fill=(30, 30, 30), anchor="mm")
    draw.text((width / 2, 112), "支付成功", font=font(24), fill=(120, 120, 120), anchor="mm")

    draw.rectangle([0, 150, width, 470], fill=accent)
    draw.text((width / 2, 250), "¥", font=font(40), fill=(255, 255, 255), anchor="mm")
    draw.text((width / 2, 350), amount, font=font(110), fill=(255, 255, 255), anchor="mm")
    draw.text((width / 2, 425), footer, font=font(22), fill=(240, 240, 240), anchor="mm")

    top = 500
    for index, (label, value) in enumerate(rows):
        y = top + index * 88
        draw.rectangle([0, y, width, y + 87], fill=(255, 255, 255))
        draw.text((36, y + 43), label, font=font(26), fill=(120, 120, 120), anchor="lm")
        draw.text((width - 36, y + 43), value, font=font(26), fill=(30, 30, 30), anchor="rm")

    image.save(os.path.join(OUT, name))
    print(f"  wrote {name}")


def main() -> None:
    os.makedirs(OUT, exist_ok=True)

    make(
        "wechat-pay.png",
        "微信支付",
        "20.00",
        [
            ("当前状态", "支付成功"),
            ("商品", "扫二维码付款"),
            ("商户全称", "老王便利店"),
            ("支付方式", "零钱"),
            ("支付时间", "2026年10月9日 12:34"),
            ("交易单号", "4200002318202610091234567890"),
            ("商户单号", "20261009123456789012"),
        ],
        (7, 193, 96),
        "已支付",
    )

    make(
        "alipay-receive.png",
        "支付宝",
        "1,280.00",
        [
            ("当前状态", "收款成功"),
            ("付款方", "张*"),
            ("收款方", "我的余额"),
            ("收款时间", "2026年10月9日 08:15"),
            ("交易号", "2026100922001234567890"),
            ("备注", "10 月房租"),
        ],
        (22, 119, 255),
        "已到账",
    )

    make(
        "bank-transfer.png",
        "转账详情",
        "3,500.00",
        [
            ("交易状态", "交易成功"),
            ("付款账户", "尾号 6688"),
            ("收款账户", "陈*"),
            ("转账时间", "2026年10月8日 19:02"),
            ("转账说明", "还款"),
            ("交易流水号", "20261008190233445566"),
        ],
        (176, 40, 40),
        "转账成功",
    )


if __name__ == "__main__":
    main()
