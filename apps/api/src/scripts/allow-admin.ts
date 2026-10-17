/**
 * **Put one named account on the administrator allow list — the second, independent half.**
 *
 * ⚠️ **This command is not a way to make somebody an administrator.** It is a way to say
 * *"this account is one that administration may currently run as"*, and on its own it does
 * nothing at all: the guard also requires a live `admin_grants` row
 * (`pnpm admin:grant`). Both must be present, and **neither command writes the other table**.
 *
 * That separation is the point. The first version of the second check derived its answer from
 * `admin_grants`, so one grant satisfied both halves and the two checks could never disagree;
 * the owner caught it (`docs/开发过程记录/管理员与权限边界-设计决定.md` §4.2). Granting and listing are
 * therefore two deliberate acts:
 *
 * ```bash
 * pnpm admin:list                                    # look first
 * pnpm admin:grant    <uuid> --by "<operator>"       # authorization
 * pnpm admin:allow    <uuid> --by "<operator>"       # permission to exercise it
 * ```
 *
 * ⚠️ **The list starts empty.** Nothing populates it automatically — not registration, not an
 * invitation, not a grant, and not the migration that created the table. Every entry is a
 * command somebody ran against a UUID they had to look up.
 *
 * ⚠️ **Telling somebody about the list would be telling them the answer.** *"不能由客户端提交
 * UUID 自我声明"* — there is no request body, header or parameter anywhere in the application
 * that contributes to this table. This script is the only writer.
 */
import { createPrismaClient } from "../db.js";
import { loadEnv } from "../env.js";
import { isFirstBatchAccountNumber } from "../admin/rules.js";

const args = process.argv.slice(2);

function flag(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1]?.trim() ?? null;
}

const target = args.find((argument) => !argument.startsWith("--") && argument.includes("-"))?.trim();
const listedBy = flag("--by");

function fail(message: string): never {
  process.stderr.write(`\n❌ ${message}\n\n`);
  process.exit(1);
}

if (target === undefined || target === "") {
  fail(
    "用法：pnpm admin:allow <用户 UUID> --by <操作者>\n" +
      "     UUID 用 `pnpm admin:list` 查，不要凭记忆输入。",
  );
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
  fail(`"${target}" 不是一个 UUID。用 \`pnpm admin:list\` 查真实值。`);
}
if (listedBy === null || listedBy === "") {
  fail("缺少 --by <操作者>：名单记录必须写下是谁做的。");
}

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const outcome = await prisma.$transaction(async (tx) => {
  const user = await tx.user.findUnique({
    where: { id: target },
    select: { id: true, username: true, accountNumber: true, isDemo: true },
  });

  if (user === null) return { kind: "missing" as const };
  if (user.isDemo) return { kind: "demo" as const, user };
  if (!isFirstBatchAccountNumber(user.accountNumber)) {
    return { kind: "ineligible" as const, user };
  }

  const existing = await tx.adminAllowEntry.findUnique({ where: { userId: user.id } });
  if (existing !== null && existing.revokedAt === null) {
    return { kind: "already" as const, user, existing };
  }

  const entry = await tx.adminAllowEntry.upsert({
    where: { userId: user.id },
    create: { userId: user.id, listedBy, note: "列入允许名单（一次性脚本）" },
    update: { listedAt: new Date(), listedBy, revokedAt: null, revokedBy: null, note: "重新列入" },
  });

  /**
   * ⚠️ **The grant table is not touched here, and the reader should be able to see that
   * from this function.** If this script also wrote `admin_grants`, "grant" and "list" would
   * collapse back into one action and the second check would be decorative again.
   */
  return { kind: "listed" as const, user, entry, revived: existing !== null };
});

switch (outcome.kind) {
  case "missing":
    fail(`没有这个账号：${target}\n（没有写入任何东西）`);
    break;

  case "demo":
    fail(`账号 ${outcome.user.username} 是只读演示账号，不能在允许名单上。\n（没有写入任何东西）`);
    break;

  case "ineligible":
    fail(
      `账号 ${outcome.user.username}（编号 ${outcome.user.accountNumber}）不在前 100 个账号之内，` +
        `不具备管理员资格。\n（没有写入任何东西）`,
    );
    break;

  case "already":
    process.stdout.write(
      [
        "",
        "  这个账号已经在允许名单上，没有重复写入。",
        `  用户名：${outcome.user.username}`,
        `  账号编号：${outcome.user.accountNumber}`,
        `  列入时间：${outcome.existing.listedAt.toLocaleString("zh-CN")}`,
        `  操作者：${outcome.existing.listedBy}`,
        "",
        "  （这条输出是幂等性的证据：脚本可以安全地重复运行。）",
        "",
      ].join("\n"),
    );
    break;

  case "listed":
    process.stdout.write(
      [
        "",
        outcome.revived ? "  ✅ 已重新列入允许名单（原移除记录已清除）" : "  ✅ 已列入管理员允许名单",
        `  用户名：${outcome.user.username}`,
        `  账号编号：${outcome.user.accountNumber}`,
        `  UUID：${outcome.user.id}`,
        `  操作者：${outcome.entry.listedBy}`,
        `  时间：${outcome.entry.listedAt.toLocaleString("zh-CN")}`,
        "",
        "  ⚠️ 这一步只写入名单。这个账号**还**需要一条有效的管理员授权才算管理员：",
        "     pnpm admin:grant <同一个 UUID> --by <操作者>",
        "",
      ].join("\n"),
    );
    break;
}

await prisma.$disconnect();
