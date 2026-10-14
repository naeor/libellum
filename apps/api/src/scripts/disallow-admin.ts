/**
 * **Take one account off the administrator allow list — immediately.**
 *
 * The counterpart of `allow-admin.ts`, and the faster lever of the two. Revoking the
 * *authorization* (`pnpm admin:revoke`) says *"this account no longer holds the role"*;
 * removing the *listing* says *"this account may not exercise administration, whatever it
 * holds"*. They are different statements, made separately, and either one alone is enough to
 * stop an admin request.
 *
 * ```bash
 * pnpm admin:disallow <uuid> --by "<operator>" --why "账号疑似被盗"
 * ```
 *
 * ⚠️ **Nothing needs restarting and no session needs clearing.** The guard reads the list on
 * every request and caches nothing, so the next admin request from a signed-in session
 * already fails. The test *"撤销名单后旧会话立即失效"* is what keeps that true — a cache added
 * later for performance would quietly break it.
 *
 * ⚠️ **It refuses to empty the list entirely unless told to.** An empty list means nobody can
 * administer the platform, which is recoverable (this script runs from a terminal and can put
 * an account back) but is not something to do by accident while intending to remove somebody
 * else. `--allow-empty` is the deliberate way to say *"yes, I mean there will be none"*.
 *
 * ⚠️ **It does not touch `admin_grants`.** An account removed from the list keeps its grant
 * record, and that is the point: the two facts are meant to be able to disagree, so that a
 * reviewer can see *which* of the two was withdrawn and when.
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
  fail("用法：pnpm admin:disallow <用户 UUID> --by <操作者> [--why <原因>] [--allow-empty]");
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
  fail(`"${target}" 不是一个 UUID。用 \`pnpm admin:list\` 查真实值。`);
}
if (revokedBy === null || revokedBy === "") {
  fail("缺少 --by <操作者>：移除记录必须写下是谁做的。");
}

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const outcome = await prisma.$transaction(async (tx) => {
  const user = await tx.user.findUnique({
    where: { id: target },
    select: { id: true, username: true, accountNumber: true },
  });

  if (user === null) return { kind: "missing" as const };

  const entry = await tx.adminAllowEntry.findUnique({ where: { userId: user.id } });
  if (entry === null) return { kind: "not_listed" as const, user };
  if (entry.revokedAt !== null) return { kind: "already" as const, user, entry };

  const liveCount = await tx.adminAllowEntry.count({ where: { revokedAt: null } });
  if (liveCount <= 1 && !allowEmpty) {
    return { kind: "last_one" as const, user };
  }

  const updated = await tx.adminAllowEntry.update({
    where: { userId: user.id },
    data: { revokedAt: new Date(), revokedBy, note: why ?? "移出允许名单（一次性脚本）" },
  });

  return { kind: "removed" as const, user, entry: updated };
});

switch (outcome.kind) {
  case "missing":
    fail(`没有这个账号：${target}\n（没有写入任何东西）`);
    break;

  case "not_listed":
    fail(
      `账号 ${outcome.user.username}（编号 ${outcome.user.accountNumber}）本来就不在允许名单上。\n` +
        `（没有写入任何东西）`,
    );
    break;

  case "already":
    process.stdout.write(
      [
        "",
        "  这个账号早已移出允许名单，没有重复写入。",
        `  用户名：${outcome.user.username}`,
        `  移除时间：${outcome.entry.revokedAt?.toLocaleString("zh-CN") ?? "?"}`,
        `  操作者：${outcome.entry.revokedBy ?? "?"}`,
        "",
      ].join("\n"),
    );
    break;

  case "last_one":
    fail(
      `账号 ${outcome.user.username} 是**当前唯一**在允许名单上的账号。\n` +
        `移出它会让系统没有任何账号能行使管理员权限。\n` +
        `如果这确实是你想要的，加上 --allow-empty 再运行一次。\n` +
        `（没有写入任何东西；系统不会自动补一个替补。）`,
    );
    break;

  case "removed":
    process.stdout.write(
      [
        "",
        "  ✅ 已移出管理员允许名单",
        `  用户名：${outcome.user.username}`,
        `  账号编号：${outcome.user.accountNumber}`,
        `  操作者：${outcome.entry.revokedBy ?? "?"}`,
        `  时间：${outcome.entry.revokedAt?.toLocaleString("zh-CN") ?? "?"}`,
        why === null ? null : `  原因：${why}`,
        "",
        "  下一次管理员请求就会失败——权限没有缓存，也不需要让人重新登录。",
        "  ⚠️ 管理员授权记录（admin_grants）**没有**被改动：两件事是分开的。",
        "",
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    );
    break;
}

await prisma.$disconnect();
