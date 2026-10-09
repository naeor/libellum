"""Bring PLAN.md in line with the redesigned S5.

The technical solution document still described uploading receipt photographs
and storing them in a non-public directory. The feature is now screenshot
recognition, and images are never written to disk at all, so those passages
were not merely stale - they described an architecture that no longer exists.

Written as a script because the changes are scattered across fourteen places
and every one of them is an exact string.
"""

from __future__ import annotations

import io
import os
import sys

DOCS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "docs")
PLAN = os.path.join(DOCS, "PLAN.md")

REPLACEMENTS: list[tuple[str, str]] = [
    (
        "| 拍照/上传小票 | 一笔账可挂多张图片（**S5 实现**） |",
        "| 截图识别记账 | 上传付款截图，自动识别金额与时间，核对后入账（**S5 实现**，图片不落盘） |",
    ),
    (
        "| 拍照上传小票 | 好 | **好**（浏览器拍照/相册可用） | 好 | 好 |",
        "| 截图识别记账 | 好 | **好**（浏览器选图/拍照都可用） | 好 | 一般（需常驻 OCR 进程） |",
    ),
    (
        "上传目录（非公开）",
        "OCR 服务（常驻）  ",
    ),
    (
        "| 备份 | cron 每日 `pg_dump` + 上传目录打包，本地 7 天、异地 30 天 |",
        "| 备份 | cron 每日 `pg_dump`，本地 7 天、异地 30 天。**无需备份图片——图片从不落盘** |",
    ),
    (
        "| POST | `/transactions/:id/attachments` | multipart 上传小票（≤10MB，仅图片） |",
        "| POST | `/ocr/recognize` | multipart 上传截图（≤10MB，≤5 张），**内存处理、不落盘**，返回识别结果与警告 |",
    ),
    (
        "| GET | `/attachments/:id` | 鉴权后返回图片流（不暴露真实路径） |",
        "| — | *（已废弃）* | 原「鉴权读取图片」接口：图片不再保存，无需读取接口 |",
    ),
    (
        "| DELETE | `/attachments/:id` | 删除小票 |",
        "| — | *（已废弃）* | 原「删除小票」接口：没有图片可删 |",
    ),
    (
        "| 新增流水、上传小票 | ✅ | ✅ | ❌ | ❌ |",
        "| 新增流水、截图识别 | ✅ | ✅ | ❌ | ❌ |",
    ),
    (
        "- 上传：只允许 jpg/png/webp，做真实内容嗅探（不信任扩展名），重命名后存入**非公开目录**，图片只通过带鉴权的接口读取",
        "- 上传：只允许 jpg/png/webp，做**真实内容嗅探**（不信任扩展名），大小上限 10MB，**图片只在内存中存在，识别后立即释放**",
    ),
    (
        "| 8.5 | 恶意上传 | 白名单类型 + 内容嗅探 + 大小限制 + 随机文件名 + 非公开目录 + 鉴权读取 |",
        "| 8.5 | 恶意上传 | 白名单类型 + 内容嗅探 + 大小限制 + **不落盘**（没有文件就没有可执行、可遍历、可泄露的文件） |",
    ),
    (
        "| **S5 小票图片** | 拍照/选图、压缩、缩略图、鉴权查看 | 手机拍照上传成功；未登录访问图片被拒 | 0.5 天 |",
        "| **S5 截图识别** | 上传付款截图 → 服务端 OCR → 字段提取 → 弹窗核对；**图片不落盘** | 三类截图字段识别正确、2 秒内返回；磁盘无图片残留 | 2–3 天 |",
    ),
    (
        "| 9 | **小票拍照** | 更早 | S5 | `attachments` 表已设计 |",
        "| 9 | **小票拍照** | 更早 | ⛔ **已被「截图识别」取代**（2026-10-09） | 场景改为付款截图；`attachments` 表不再需要 |",
    ),
]


def main() -> int:
    text = io.open(PLAN, encoding="utf-8").read()
    missing: list[str] = []
    applied = 0

    for old, new in REPLACEMENTS:
        if old not in text:
            missing.append(old[:60])
            continue
        text = text.replace(old, new, 1)
        applied += 1

    # Written even when something did not match: a script that discards the
    # nine edits it did find because the tenth moved is worse than useless.
    io.open(PLAN, "w", encoding="utf-8", newline="\n").write(text)
    print(f"已更新 {applied} / {len(REPLACEMENTS)} 处。")

    if missing:
        print("以下字符串没找到（可能已被改过）：")
        for item in missing:
            print(f"  - {item}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
