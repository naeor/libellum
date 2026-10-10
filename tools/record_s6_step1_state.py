"""Record the state S6 step 1 was left in, so the next session does not have to rediscover it."""

from __future__ import annotations

import io
import os

PATH = os.path.join(
    r"C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1",
    "docs",
    "S6-导出与导入-设计决定.md",
)

SECTION = """

---

## 八、⚠️ 第 1 步的中途状态（2026-10-10 收尾记录）

**这一步没有做完，仓库已回退到全绿状态。** 这一段是给下一次接手的人看的。

### 发生了什么

| 顺序 | 结果 |
|---|---|
| 1 | 往 `prisma/schema.prisma` 加了 `Transaction.sourceRef`、`@@unique([bookId, sourceRef])`、`ExportLog` 模型 |
| 2 | `prisma validate` 通过 ✓ |
| 3 | **`prisma migrate dev` 不能用** —— 它需要交互终端 ✗ |
| 4 | 改为手写迁移 SQL + `prisma migrate deploy` → **迁移成功应用** ✓ |
| 5 | **但 API 测试挂了 11 / 14**（创建流水返回 500）✗ |
| 6 | **回退 schema 与迁移文件 → 66 个 API 测试重新全绿** ✓ |

### 结论：**是 schema 改动导致的，不是迁移**

第 6 步证明了这一点（回退 schema 后测试恢复）。**但具体是哪一处改动导致的，没有查明** ——
余量用尽前只确认了"是它"，没确认"它的哪一部分"。

**下一次接手时的调查方向**（按可能性排序）：

1. **`ExportLog` 的反向关系插入位置** —— 当时是用脚本找每个模型的 `}` 前插入的，
   `Book` / `User` 两处是否落在正确位置**没有逐行核对** ✗
2. **`@@unique([bookId, sourceRef])`** —— 加在**可空列**上的唯一约束，理论可行，但值得单独验一次
3. **`sourceRef` 的插入位置** —— 插在 `bookId` 之后，理论上无影响 ✓

**建议的做法**：**一次只加一处**，每加一处就重跑 API 测试 ✓
（当时是**三处一起加**，所以只能知道"这个整体有问题"，无法定位 ✗）

### ⚠️ 数据库现在领先于 schema

迁移**已经应用到了 `ledger_dev`**，所以库里现在有：

- `transactions.source_ref` 列
- `transactions` 上 `(book_id, source_ref)` 的唯一索引
- **`export_logs` 表**（含两个外键）

而 `prisma/schema.prisma` **没有**这些 ✓

**这是无害的漂移**：多出来的列可空、多出来的表没人查 ✓ 所以测试全绿 ✓

**但下次必须处理**，二选一：

| 做法 | 说明 |
|---|---|
| **A. 重新加上 schema**（推荐） | 顺着上面的调查方向一处一处加，确认没问题后，用 `prisma migrate diff` 生成一个 **no-op 或对齐用**的迁移，把状态补正 |
| **B. 从库里删掉** | `DROP TABLE export_logs; DROP INDEX ...; ALTER TABLE transactions DROP COLUMN source_ref;` |

> **不要直接改库来"对齐"** —— 先想清楚哪边是想要的 ✓

### 环境上的两个坑（下次直接用）

1. **schema 在仓库根目录** `prisma/schema.prisma`，**不在 `apps/api` 下** ✗
   所以 `pnpm --filter @libellum/api exec prisma ...` **会跑错目录** ✓
   正确写法：`pnpm exec prisma <cmd> --schema "<仓库根>/prisma/schema.prisma"`（在仓库根目录执行）✓

2. **`prisma migrate dev` 在本环境不可用**（需要交互终端）✗
   **改用**：手写 `migration.sql` → `prisma migrate deploy` ✓
   （或 `prisma migrate diff --from-config-datasource --to-schema ... --script` 生成 SQL）

3. **`migrate diff` 的输出不要用 PowerShell 管道写文件** ✗
   验证时把 PowerShell 自己的报错和 BOM 一起写进了 `migration.sql`，
   导致 PostgreSQL 报语法错误、迁移进入失败状态 ✓
   **改用 Python 写文件** ✓（`docs/README.md` 里已经有一条同源的教训）
"""


def main() -> None:
    text = io.open(PATH, encoding="utf-8").read()

    if "第 1 步的中途状态" in text:
        print("  (已有记录)")
        return

    io.open(PATH, "w", encoding="utf-8", newline="\n").write(text.rstrip() + SECTION)
    print("  ✓ 已记录第 1 步的中途状态与两个环境坑")


if __name__ == "__main__":
    main()
