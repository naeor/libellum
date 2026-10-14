/**
 * 比较**开发库与测试库**已成功应用的 Prisma 迁移集合，不一致时指出差在哪。
 *
 * ⚠️ **为什么需要这个检查。**
 *
 * 2026-10-14 做管理员机制时发现：`ledger_test` 停在 `20261011140000`，而 `ledger_dev` 已经
 * 在 `20261013190000`——**测试库落后了 9 个迁移**，而**没有任何东西会提醒你**。
 *
 * 后果不是"测试跑不起来"那么简单：在那之前跑在测试库上的集成测试，**可能一直在测一个
 * 旧 schema**。本次没有发现因此得出的错误结论，但**那属于运气好，不属于设计好**。
 *
 * 成因也很平常：`prisma migrate deploy` 连的是 `DATABASE_URL` 指向的库，
 * 而**测试库需要单独跑一次**（`交接.md` §2.1 写过这件事）。一个需要"记得做"的步骤，
 * 迟早会有人忘记。
 *
 * ⚠️ **它只读，而且刻意什么都不修。**
 * 不重置数据库、不应用迁移、不碰业务数据。**"发现不一致"和"把它改掉"是两件事**——
 * 前者是报告，后者要有人决定（测试库可以重建，而开发库里有真实账目）。
 *
 * ⚠️ **它不比较业务数据。** 两个库的账目数量本来就该不同，比较它们只会产出噪音。
 * 它只比较 `_prisma_migrations` 里 `finished_at` 非空的那些行。
 *
 * ⚠️ **不打印任何连接串或口令**，只打印库名与迁移名。
 *
 * ```bash
 * pnpm check:db            # 只报错
 * pnpm check:db -- --list  # 连两边都有的迁移也列出来
 * ```
 *
 * 为什么它在 `apps/api` 而不是 `tools/`：它需要 Prisma 客户端，而客户端只在这个包里
 * （`tools/` 下的脚本用不了 `pg`——根目录没有那个依赖）。和 `admin:list` 一样的理由。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import { createPrismaClient } from "../db.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * ⚠️ **从仓库根的 `.env` 读，而不是从环境变量读。**
 * 这个项目的连接串一直是 `.env` 的一份拷贝（Prisma 也读它），而"比较脚本连的库
 * 和应用的库不是同一个"是最经典的那种事故。
 */
loadDotenv({ path: join(ROOT, ".env"), quiet: true });

const LIST = process.argv.includes("--list");

interface MigrationRow {
  readonly migration_name: string;
}

/** 已成功应用的迁移：`finished_at` 非空。失败或中断的不算。 */
async function appliedMigrations(url: string): Promise<{ database: string; names: string[] }> {
  const prisma = createPrismaClient(url);

  try {
    const nameRows = await prisma.$queryRaw<{ name: string }[]>`select current_database() as name`;
    const rows = await prisma.$queryRaw<MigrationRow[]>`
      select migration_name from _prisma_migrations
       where finished_at is not null
       order by migration_name
    `;

    return {
      database: nameRows[0]?.name ?? "?",
      names: rows.map((row) => row.migration_name),
    };
  } finally {
    await prisma.$disconnect();
  }
}

const devUrl = process.env["DATABASE_URL"];
const testUrl = process.env["TEST_DATABASE_URL"];

if (!devUrl || !testUrl) {
  console.error("❌ .env 里缺少 DATABASE_URL 或 TEST_DATABASE_URL，无法比较。");
  process.exit(1);
}

try {
  const dev = await appliedMigrations(devUrl);
  const test = await appliedMigrations(testUrl);

  /**
   * ⚠️ **两个库不能是同一个。** 如果 `.env` 把两个变量指向同一个库，这个检查会永远通过——
   * 而那不是"一致"，是"没在比较"。
   */
  if (dev.database === test.database) {
    console.error(
      `❌ DATABASE_URL 与 TEST_DATABASE_URL 指向同一个库（${dev.database}），没有可比性。`,
    );
    process.exit(1);
  }

  const testSet = new Set(test.names);
  const devSet = new Set(dev.names);
  const missingInTest = dev.names.filter((name) => !testSet.has(name));
  const extraInTest = test.names.filter((name) => !devSet.has(name));

  console.log(
    `开发库 ${dev.database}：${String(dev.names.length)} 个已应用迁移\n` +
      `测试库 ${test.database}：${String(test.names.length)} 个已应用迁移`,
  );

  if (LIST) {
    for (const name of dev.names) {
      console.log(`  ${testSet.has(name) ? "两边都有" : "仅开发库"}  ${name}`);
    }
    for (const name of extraInTest) console.log(`  仅测试库  ${name}`);
  }

  if (missingInTest.length === 0 && extraInTest.length === 0) {
    console.log("\n✅ 两个库的迁移集合一致");
    process.exit(0);
  }

  console.error("\n❌ 两个库的迁移集合不一致：\n");
  if (missingInTest.length > 0) {
    console.error(`  测试库缺少 ${String(missingInTest.length)} 个：`);
    for (const name of missingInTest) console.error(`      ${name}`);
    console.error(
      "\n  修法：把 TEST_DATABASE_URL 当作 DATABASE_URL 跑一次 `pnpm db:deploy`" +
        "（`交接.md` §2.1 记的就是这一步）。",
    );
  }
  if (extraInTest.length > 0) {
    console.error(`\n  测试库多出 ${String(extraInTest.length)} 个（开发库没有）：`);
    for (const name of extraInTest) console.error(`      ${name}`);
    console.error("\n  ⚠️ 这通常意味着有人在测试库上试过一个还没进仓库的迁移。");
  }
  console.error(
    "\n  ⚠️ 本检查只报告，不修改任何东西——" +
      "要不要重建测试库、要不要在开发库上补迁移，是两件需要人来定的决定。",
  );
  process.exit(1);
} catch (error) {
  console.error(`❌ 检查失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
