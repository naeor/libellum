/**
 * 备份**并立刻验证它能恢复**。
 *
 * ⚠️ **为什么这两件事必须在同一个脚本里。**
 *
 * `开发计划.md` 的风险表里，第 8 条是这么写的：
 * **"备份没验证 → 出事时数据全丢 → S10 强制恢复演练，写入验收标准"**。
 * 一个没人恢复过的备份，**不是备份，只是一份让人安心的文件**——
 * 它可能在写的时候就被截断、可能导出时漏了某张表、可能在恢复到一半时报错，
 * 而这些**只有真的恢复一次才会知道**。所以这个脚本**不接受"只备份"**：
 * 它导出之后立刻把那份文件恢复到一个临时库、比对行数、再删掉临时库。
 *
 * ⚠️ **恢复的是"那份文件"，不是"数据库本身"。** 脚本恢复的是刚写出来的 dump，
 * 所以它验证的正是**你手上要拿去救命的那份东西**。
 *
 * ⚠️ **它不会碰你的真实库。** 恢复目标是一个**新建的临时库**（名字带时间戳），
 * 验证完就删掉。**这正是为什么它敢自动做这件事**——一个需要人工确认的演练，
 * 一年也不会跑一次。
 *
 * 用法：
 *
 *   node tools/backup-verify.mjs                    # 备份 + 恢复演练
 *   node tools/backup-verify.mjs --keep             # 演练后保留临时库（排查用）
 *   node tools/backup-verify.mjs --source=TEST_DATABASE_URL
 *
 * ⚠️ **需要 `pg_dump` / `pg_restore` / `psql` 在 PATH 上，或在 `PG_BIN` 里。**
 * Windows 上它们默认在 `C:\Program Files\PostgreSQL\17\bin`。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * ⚠️ **从 `.env` 里读，而不是从环境变量里读。**
 * 这个项目里连接串一直是 `.env` 的一份拷贝（Prisma 也读它），
 * 而"备份脚本连的库和应用的库不是同一个"是最经典的那种事故。
 */
function readEnvFile() {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) throw new Error(`找不到 ${path}`);

  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/**
 * ⚠️ **`?schema=public` 必须去掉。**
 * Prisma 的连接串带这个参数，而 `pg_dump` / `psql` **不认它**，
 * 报 `invalid URI query parameter: "schema"` —— 这个错在开发时已经踩过一次。
 */
function stripPrismaParams(url) {
  return url.replace(/\?.*$/, "");
}

/** 找到 PostgreSQL 的客户端工具。 */
function findBin(name) {
  const fromEnv = process.env.PG_BIN;
  const candidates = [
    fromEnv ? join(fromEnv, name) : null,
    name,
    `C:\\Program Files\\PostgreSQL\\17\\bin\\${name}.exe`,
    `/usr/bin/${name}`,
    `/usr/local/bin/${name}`,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", shell: false });
    if (result.status === 0) return candidate;
  }

  throw new Error(
    `找不到 ${name}。请把它加进 PATH，或用 PG_BIN 指定 PostgreSQL 的 bin 目录。`,
  );
}

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${bin} 失败了（退出码 ${String(result.status)}）：\n${result.stderr || result.stdout || ""}`,
    );
  }
  return result.stdout ?? "";
}

/** 每张表的行数——**它是"恢复成功"的判据**，而不是"文件存在"。 */
async function tableCounts(psql, url) {
  const query = `
    SELECT relname, n_live_tup
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
    ORDER BY relname;
  `;
  const out = run(psql, ["--dbname", url, "-w", "-t", "-A", "-F", "|", "-c", query]);

  const counts = new Map();
  for (const line of out.split(/\r?\n/)) {
    const [name, count] = line.split("|");
    if (name && count !== undefined) counts.set(name, Number(count));
  }
  return counts;
}

/**
 * ⚠️ **`n_live_tup` 是估算值，所以比对允许小误差。**
 * 它由 autovacuum 维护，刚写完的库上并不精确。**用精确 `COUNT(*)` 要跑 30 次查询**，
 * 而这里要回答的问题是"整张表是不是空的 / 是不是少了一个数量级"，
 * 估算值完全够用——**而且它不会因为一次 analyze 的时机而假报失败**。
 */
function compareCounts(before, after) {
  const problems = [];
  const tolerance = 0.05;

  for (const [table, original] of before) {
    const restored = after.get(table);

    if (restored === undefined) {
      problems.push(`表 ${table} 在恢复后不存在`);
      continue;
    }

    if (original === 0) {
      if (restored !== 0) problems.push(`表 ${table}：原 0 行，恢复后 ${String(restored)} 行`);
      continue;
    }

    const drift = Math.abs(restored - original) / original;
    if (drift > tolerance) {
      problems.push(`表 ${table}：原 ${String(original)} 行，恢复后 ${String(restored)} 行`);
    }
  }

  for (const table of after.keys()) {
    if (!before.has(table)) problems.push(`表 ${table} 是恢复出来的、原本没有`);
  }

  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const sourceKey =
    args.find((a) => a.startsWith("--source="))?.slice("--source=".length) ?? "DATABASE_URL";

  const env = readEnvFile();
  const rawUrl = env[sourceKey];
  if (!rawUrl) throw new Error(`.env 里没有 ${sourceKey}`);

  const sourceUrl = stripPrismaParams(rawUrl);
  const database = /^\w+:\/\/[^@]*@[^/]+\/([^?]+)/.exec(sourceUrl)?.[1] ?? "unknown";
  /**
   * ⚠️ **`slice(0, 14)`，不是 15。** ISO 串是 `2026-10-12T03:14:22.123Z`，去掉 `-` `:` `T` 之后
   * 第 15 个字符正好是那个小数点，于是文件名会变成 `...20261012031422..dump`（两个点）。
   * 第一版就是这么写的——**一个只影响观感、但会让人以为"文件名拼错了"的小毛病**。
   */
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const tempDatabase = `ledger_verify_${stamp}`;

  const pgDump = findBin("pg_dump");
  const pgRestore = findBin("pg_restore");
  const psql = findBin("psql");

  const backupDir = join(ROOT, "_backups");
  mkdirSync(backupDir, { recursive: true });
  const file = join(backupDir, `${database}-${stamp}.dump`);

  console.log(`\n=== 备份与恢复演练 ===`);
  console.log(`源库：${database}`);
  console.log(`文件：${file}\n`);

  // ---- 1. 备份 ---------------------------------------------------------------
  const before = await tableCounts(psql, sourceUrl);
  run(pgDump, ["--dbname", sourceUrl, "--format=custom", "--file", file], { stdio: "inherit" });

  const size = statSync(file).size;
  if (size === 0) throw new Error("备份文件是空的——这不算备份成功。");
  console.log(`\n✅ 备份写完：${(size / 1024).toFixed(1)} KB`);

  /**
   * ⚠️ **`--list` 是"这个文件我能读懂"的最小证明。**
   * 一个被截断的 dump 在文件系统上看起来完全正常（大小也对），
   * 只有真的让 `pg_restore` 解析它才会暴露。
   */
  const listing = run(pgRestore, ["--list", file]);
  const entries = listing.split(/\r?\n/).filter((line) => /^\d+;/.test(line)).length;
  console.log(`✅ 备份可解析：${String(entries)} 个条目`);

  // ---- 2. 恢复到一个临时库 ---------------------------------------------------
  /**
   * ⚠️ **`postgres` 是维护库**：`CREATE DATABASE` 不能在你要创建的那个库里执行。
   *
   * ⚠️ **用 `psql -c`，不用 `createdb` / `dropdb`。** 第一版用了 `createdb --dbname ...`，
   * 而 **`--dbname` 是 `psql` 的参数、不是 `createdb` 的**，于是脚本报
   * `createdb: illegal option -- dbname`。**两个命令名字相近、参数不同**——
   * 这类错误只有真的跑一遍才会露面，**而"没跑过的脚本"正是这个脚本要防的东西**。
   */
  const adminUrl = sourceUrl.replace(/\/[^/?]+(\?|$)/, "/postgres$1");

  try {
    run(psql, ["--dbname", adminUrl, "-w", "-q", "-c", `CREATE DATABASE "${tempDatabase}";`]);
    console.log(`\n✅ 已建临时库：${tempDatabase}`);

    const tempUrl = sourceUrl.replace(/\/[^/?]+(\?|$)/, `/${tempDatabase}$1`);

    /**
     * ⚠️ **`--exit-on-error` 会让恢复在第一个错误处停下**，这正是演练想要的：
     * 一个"恢复了 99% 然后报错"的备份，在最需要它的那天就是 99% 的数据丢失。
     */
    run(pgRestore, ["--dbname", tempUrl, "--exit-on-error", "--no-owner", "--no-privileges", file]);
    console.log("✅ 已恢复到临时库");

    // ---- 3. 比对 -------------------------------------------------------------
    const after = await tableCounts(psql, tempUrl);
    const problems = compareCounts(before, after);

    if (problems.length > 0) {
      console.error("\n❌ 恢复后的数据对不上：");
      for (const problem of problems) console.error(`   · ${problem}`);
      throw new Error("恢复演练失败——这份备份不能信。");
    }

    const total = [...before.values()].reduce((sum, n) => sum + n, 0);
    console.log(`✅ 行数一致：${String(before.size)} 张表、约 ${String(total)} 行`);
    console.log(`\n🎉 这份备份验证通过，可以拿去救命。\n`);
  } finally {
    if (keep) {
      console.log(`（--keep：临时库 ${tempDatabase} 保留着）\n`);
    } else {
      spawnSync(psql, ["--dbname", adminUrl, "-w", "-q", "-c", `DROP DATABASE IF EXISTS "${tempDatabase}";`], {
        encoding: "utf8",
      });
      console.log(`临时库 ${tempDatabase} 已删除\n`);
    }
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
