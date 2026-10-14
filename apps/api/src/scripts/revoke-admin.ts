/**
 * **Take administration away from one account, immediately.**
 *
 * The other half of `grant-admin.ts`, and the half that matters more. An authorization
 * system that can only grant is a system where a compromised account can only be dealt
 * with by editing the database by hand — and *"how do I fire an administrator"* is not a
 * question that should have a manual answer.
 *
 * ```bash
 * pnpm admin:revoke bc82bf91-c0d9-4f88-9e34-6558fcd66ee8 --by "owner@laptop" --why "账号疑似被盗"
 * ```
 *
 * ⚠️ **Revocation is a write to a timestamp, not a delete.** The row stays, so the record
 * still says the account once held the role and when it stopped. That is what an audit
 * needs; a deleted row would answer "was this account ever an administrator" with a shrug.
 *
 * ⚠️ **Nothing needs restarting and no session needs clearing.** The guard reads the grant
 * on every request and caches nothing, so the *next* admin request from a signed-in session
 * already fails. See the test named *"撤销授权后旧会话立即失效"* — it is the assertion that
 * keeps this true, because a cache added later for performance would quietly break it.
 *
 * ⚠️ **It refuses to revoke the last administrator unless told to.** The brief is explicit
 * that nobody is auto-promoted to fill a gap: locking everybody out is recoverable (this
 * script works from a terminal, and it can re-grant), but doing it by accident while
 * intending to revoke somebody else is not something to discover at 3am. `--allow-empty`
 * is the deliberate way to say "yes, I mean there will be none".
 */
import { createPrismaClient } from "../db.js";
import { loadEnv } from "../env.js";

const args = process.argv.slice(2);

function flag(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1]?.trim() ?? null;
}

const target = args.find((argument) => !argument.startsWith("--") && argument.includes("-"))?.trim();
const revokedBy = flag("--by");
const why = flag("--why");
const allowEmpty = args.includes("--allow-empty");

function fail(message: string): never {
  process.stderr.write(`\n❌ ${message}\n\n`);
  process.exit(1);
}

if (target === undefined || target === "") {
  fail("用法：pnpm admin:revoke <用户 UUID> --by <操作者> [--why <原因>] [--allow-empty]");
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
  fail(`"${target}" 不是一个 UUID。用 \`pnpm admin:list\` 查真实值。`);
}
if (revokedBy === null || revokedBy === "") {
  fail("缺少 --by <操作者>：撤销记录必须写下是谁做的。");
}

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const outcome = await prisma.$transaction(async (tx) => {
  const user = await tx.user.findUnique({
    where: { id: target },
    select: { id: true, username: true, accountNumber: true, isAdmin: true },
  });

  if (user === null) return { kind: "missing" as const };

  const grant = await tx.adminGrant.findUnique({ where: { userId: user.id } });
  if (grant === null) return { kind: "no_grant" as const, user };
  if (grant.revokedAt !== null) return { kind: "already" as const, user, grant };

  const liveCount = await tx.adminGrant.count({ where: { revokedAt: null } });
  if (liveCount <= 1 && !allowEmpty) {
    return { kind: "last_one" as const, user };
  }

  const updated = await tx.adminGrant.update({
    where: { userId: user.id },
    data: {
      revokedAt: new Date(),
      revokedBy,
      note: why ?? "撤销（一次性脚本）",
    },
  });

  /**
   * The marker is cleared in the same transaction. It is not what the guard reads — the
   * grant row is — but a row still saying `is_admin = true` for an account with no live
   * authorization is a lie the next reader has no way to catch.
   */
  await tx.user.update({ where: { id: user.id }, data: { isAdmin: false } });

  return { kind: "revoked" as const, user, grant: updated };
});

switch (outcome.kind) {
  case "missing":
    fail(`没有这个账号：${target}\n（没有写入任何东西）`);
    break;

  case "no_grant":
    fail(
      `账号 ${outcome.user.username}（编号 ${outcome.user.accountNumber}）本来就没有管理员授权。\n` +
        `（没有写入任何东西）`,
    );
    break;

  case "already":
    process.stdout.write(
      [
        "",
        "  这个账号的管理员授权早已撤销，没有重复写入。",
        `  用户名：${outcome.user.username}`,
        `  撤销时间：${outcome.grant.revokedAt?.toLocaleString("zh-CN") ?? "?"}`,
        `  撤销人：${outcome.grant.revokedBy ?? "?"}`,
        "",
      ].join("\n"),
    );
    break;

  case "last_one":
    fail(
      `账号 ${outcome.user.username} 是**当前唯一**持有有效授权的管理员。\n` +
        `撤销它会让系统没有任何管理员。\n` +
        `如果这确实是你想要的，加上 --allow-empty 再运行一次。\n` +
        `（没有写入任何东西；系统不会自动补一个替补管理员。）`,
    );
    break;

  case "revoked":
    process.stdout.write(
      [
        "",
        "  ✅ 管理员授权已撤销",
        `  用户名：${outcome.user.username}`,
        `  账号编号：${outcome.user.accountNumber}`,
        `  撤销人：${outcome.grant.revokedBy}`,
        `  时间：${outcome.grant.revokedAt?.toLocaleString("zh-CN") ?? "?"}`,
        why === null ? "" : `  原因：${why}`,
        "",
        "  下一次管理员请求就会失败——权限没有缓存，也不需要让人重新登录。",
        "",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
    break;
}

await prisma.$disconnect();
