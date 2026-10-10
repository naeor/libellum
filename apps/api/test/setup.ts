import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

/**
 * Integration tests talk to a real PostgreSQL database, so they must never be
 * pointed at the development one: the suite truncates tables between cases.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
config({ path: resolve(here, "../../../.env"), quiet: true });

// `config` does not override a variable that is already set, so an exported
// DATABASE_URL in the shell would win over the test one. Say so out loud rather
// than quietly aiming the suite at whatever the shell happened to hold.
if (process.env["DATABASE_URL"] !== undefined) {
  console.warn(
    "[test] DATABASE_URL was already set in the environment; it takes precedence " +
      "over TEST_DATABASE_URL for this run. The guard below still applies.",
  );
}

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
if (testDatabaseUrl) {
  process.env["DATABASE_URL"] = testDatabaseUrl;
}

process.env["NODE_ENV"] = "test";

/**
 * Refuse to run against anything that does not look like a test database.
 *
 * This guard exists because it was needed. On 2026-10-10 the suite cleared the
 * transaction table in `ledger_dev` — 11 rows, unrecoverable — because the run
 * inherited a DATABASE_URL from a shell that had been switched to the
 * development database for migration checks. `deleteMany()` has no undo, and no
 * backup existed.
 *
 * A name check is deliberately crude. It cannot know an environment's
 * conventions, so it errs towards refusing to run: stopping with a clear message
 * costs a minute, and the alternative cost real data.
 */
export async function assertTestDatabase(
  query: (sql: string) => Promise<unknown>,
): Promise<void> {
  // Prisma's `$queryRawUnsafe` hands back a plain array; `pg` hands back
  // `{ rows }`. Accept both rather than making the caller care.
  const result = await query("select current_database() as name");
  const rows = Array.isArray(result)
    ? (result as { name?: string }[])
    : ((result as { rows?: { name?: string }[] }).rows ?? []);
  const name = rows[0]?.name ?? "";

  if (!/test/i.test(name)) {
    throw new Error(
      [
        "",
        `拒绝运行：当前连接的数据库叫 "${name}"，但它看起来不是测试库。`,
        "",
        "  集成测试会清空所有业务表，所以只允许连到测试库。",
        "",
        "  请检查 .env 里的 TEST_DATABASE_URL（库名里应当含 test），",
        "  并确认当前 shell 没有导出 DATABASE_URL —— 已导出的变量优先级更高。",
        "",
      ].join("\n"),
    );
  }
}
