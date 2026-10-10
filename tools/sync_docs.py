"""Bring the three remaining documents in line with the present state."""

from __future__ import annotations

import io
import os

DOCS = os.path.join(
    r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1", "docs"
)

# ---------------------------------------------------------------------------
# README: it had no index at all, so nothing said which documents exist.
# ---------------------------------------------------------------------------

INDEX = """
---

## 📚 文档索引

| 文件 | 是什么 | 什么时候看 |
|---|---|---|
| **`DEVLOG.md`** | **开发日志**：按时间记录了每个阶段做了什么、为什么、怎么验证的 | 想知道"当时为什么这么定" |
| **`ROADMAP.md`** | **制作计划**：S0–S13 阶段、每阶段产出与预估 | 想知道"还剩什么、大概多久" |
| **`PLAN.md`** | **技术方案**：数据模型、接口、权限、离线策略 | 动手改代码前 |
| **`BACKLOG.md`** | **后期待办与想法池**：已排期的、想法池、**以及明确否掉的** | 想提新想法时先查这里 |
| **`S6-导出与导入-设计决定.md`** | **S6 的决定与中途状态** | 做导出/导入前**必读** |
| **`README.md`** | 本文件：怎么启动、怎么生成文档、踩过的坑 | 每次开工前 |

> ⚠️ **上面每个 `.md` 都有一个同名的 `.docx` / `.pdf`** —— 那是给人阅读的导出件，
> **内容完全一样**。**永远改 `.md`**，改完重新生成 ✓

---

## ⚠️ 当前进度（2026-10-10）

| 阶段 | 状态 |
|---|---|
| S0–S4（骨架、录入、账户、统计） | ✅ 完成 |
| S5（截图识别记账） | ✅ 后端与前端均完成，真机验证识别正确 |
| **明细页两形态改版** | ✅ 完成（真机确认流畅） |
| **S6（导出与导入）** | ⏳ **设计已定稿，第 1 步未完成** —— 见 `S6-导出与导入-设计决定.md` §8 |
| S7 及以后 | ⏳ 未开始 |
"""

# ---------------------------------------------------------------------------
# BACKLOG: A8 was completed, so it must not sit in the to-do list.
# ---------------------------------------------------------------------------

OLD_A8 = "| **A8** | **明细界面视觉优化** | 所有者原话：**\"明细界面有点丑，也有点太占地了\"**。具体待定，可能方向：流水行更紧凑、减少分区标题占高、金额与分类的视觉层级重排、整体密度提高 | 无 | 中 | 不需要（纯前端） |"
NEW_A8 = "| ~~**A8**~~ | ~~**明细界面视觉优化**~~ | ✅ **2026-10-10 完成** —— 明细页改为两个形态（展示态 / 明细态），一个 `--p` 进度驱动全部几何。见开发日志 §1.31。**已完成，不再是待办** | — | — | — |"

# ---------------------------------------------------------------------------
# ROADMAP: the ledger redesign happened outside the S-numbering and is unrecorded.
# ---------------------------------------------------------------------------

ROADMAP_ROW = """| **S6** | 导出与导入 | CSV/XLSX 导出 + **CSV 导入历史账** | 1 天 | |"""

ROADMAP_NEW = """| **—** | **明细页两形态改版** | **展示态 ↔ 明细态**，单一进度驱动、区域手势、弹簧、限速 | **已完成 2026-10-10** | ✅ |
| **S6** | 导出与导入 | CSV/XLSX 导出 + **CSV 导入历史账** | 1 天 | ⏳ 设计定稿，见 `S6-导出与导入-设计决定.md` |"""


def main() -> None:
    # README
    path = os.path.join(DOCS, "README.md")
    text = io.open(path, encoding="utf-8").read()
    if "文档索引" in text:
        print("  (README 已有索引)")
    else:
        io.open(path, "w", encoding="utf-8", newline="\n").write(text.rstrip() + "\n" + INDEX)
        print("  ✓ README：加了文档索引与当前进度")

    # BACKLOG
    path = os.path.join(DOCS, "BACKLOG.md")
    text = io.open(path, encoding="utf-8").read()
    if "A8** | **明细界面视觉优化" in text:
        text = text.replace(OLD_A8, NEW_A8, 1)
        io.open(path, "w", encoding="utf-8", newline="\n").write(text)
        print("  ✓ BACKLOG：A8 标记为已完成")
    else:
        print("  (A8 已是完成状态或未找到)")

    # ROADMAP
    path = os.path.join(DOCS, "ROADMAP.md")
    text = io.open(path, encoding="utf-8").read()
    if "明细页两形态改版" in text:
        print("  (ROADMAP 已记录)")
    elif ROADMAP_ROW in text:
        text = text.replace(ROADMAP_ROW, ROADMAP_NEW, 1)
        io.open(path, "w", encoding="utf-8", newline="\n").write(text)
        print("  ✓ ROADMAP：加入明细页改版与 S6 状态")
    else:
        print("  ✗ ROADMAP：找不到 S6 那一行")


if __name__ == "__main__":
    main()
