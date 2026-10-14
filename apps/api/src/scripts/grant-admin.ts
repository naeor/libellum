/**
 * **Grant platform administration to one named account, once, from a trusted terminal.**
 *
 * ⚠️ **This script is the only way an administrator is created.** There is deliberately no
 * route, no request body field and no invite flag that does it — see
 * `docs/管理员与权限边界-设计决定.md`. A privilege that can be acquired by sending a
 * request is a privilege that will eventually be acquired by sending a request.
 *
 * ## Running it
 *
 * ```bash
 * # 1. look, without writing anything
 * pnpm admin:list
 *
 * # 2. grant, naming the account by the UUID the database holds
 * pnpm admin:grant bc82bf91-c0d9-4f88-9e34-6558fcd66ee8 --by "owner@laptop"
 * ```
 *
 * ⚠️ **`--by` is required, and it is not ceremony.** A grant record with no author answers
 * "who did this" with a shrug, and that is the first question asked about a privilege.
 *
 * ## What it refuses, and why each refusal is here rather than in a caller
 *
 *  * **An account that does not exist.** A UUID typed from memory is exactly the input this
 *    script exists to check.
 *  * **An account outside the first hundred.** *"具有管理员资格，不等于自动成为管理员"* — but the
 *    converse also holds: **without qualification there is no path at all**, and the place
 *    to enforce that is here rather than only in the guard, so the two cannot disagree.
 *  * **A demo account.** A public credential cannot hold a private privilege.
 *  * **A second live grant.** Re-granting an already-granted account is almost always a
 *    mistake — usually a UUID copied from the wrong window — and it is the kind of mistake
 *    that is invisible afterwards.
 *
 * ## What it does on purpose
 *
 *  * **One transaction.** `users.is_admin` and the `admin_grants` row are two facts that
 *    must agree; half-applied they would be a marker without an authorization (harmless but
 *    confusing) or an authorization without a marker.
 *  * **Safe to run twice.** Running it against an account that already holds a live grant
 *    prints what it found and exits without writing — so "did I already do this?" has an
 *    answer that does not involve guessing.
 *  * **Revives a revoked grant rather than adding a row.** The primary key is the account,
 *    so re-granting after a revocation updates that account's single row and clears the
 *    revocation. History stays on one line.
 *  * **Prints no credentials and no secrets.** A UUID and an account number are identity,
 *    not secrets, and they are what the operator needs to confirm they hit the right row.
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
const grantedBy = flag("--by");

function fail(message: string): never {
  process.stderr.write(`\n❌ ${message}\n\n`);
  process.exit(1);
}

if (target === undefined || target === "") {
  fail(
    "用法：pnpm admin:grant <用户 UUID> --by <操作者>\n" +
      "     UUID 用 `pnpm admin:list` 查，不要凭记忆输入。",
  );
}

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
  fail(`"${target}" 不是一个 UUID。用 \`pnpm admin:list\` 查真实值。`);
}

if (grantedBy === null || grantedBy === "") {
  fail("缺少 --by <操作者>：授权记录必须写下是谁做的。");
}

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const outcome = await prisma.$transaction(async (tx) => {
  const user = await tx.user.findUnique({
    where: { id: target },
    select: { id: true, username: true, accountNumber: true, isDemo: true, isAdmin: true },
  });

  if (user === null) return { kind: "missing" as const };
  if (user.isDemo) return { kind: "demo" as const, user };
  if (!isFirstBatchAccountNumber(user.accountNumber)) {
    return { kind: "ineligible" as const, user };
  }

  const existing = await tx.adminGrant.findUnique({ where: { userId: user.id } });

  if (existing !== null && existing.revokedAt === null) {
    return { kind: "already" as const, user, existing };
  }

  const grant = await tx.adminGrant.upsert({
    where: { userId: user.id },
    create: { userId: user.id, grantedBy, note: "首次授权（一次性脚本）" },
    update: { grantedAt: new Date(), grantedBy, revokedAt: null, revokedBy: null, note: "重新授权" },
  });

  /**
   * The marker is written in the same transaction as the authorization, so the two cannot
   * drift. It is a *marker*: the guard does not read it — but leaving it false while a
   * grant exists would make the database describe a state that is not the state, and the
   * next person to read the row would believe it.
   */
  await tx.user.update({ where: { id: user.id }, data: { isAdmin: true } });

  return { kind: "granted" as const, user, grant, revived: existing !== null };
});

switch (outcome.kind) {
  case "missing":
    fail(`没有这个账号：${target}\n（没有写入任何东西）`);
    break;

  case "demo":
    fail(`账号 ${outcome.user.username} 是只读演示账号，不能持有管理员权限。\n（没有写入任何东西）`);
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
        "  这个账号已经是管理员，没有重复写入。",
        `  用户名：${outcome.user.username}`,
        `  账号编号：${outcome.user.accountNumber}`,
        `  授权时间：${outcome.existing.grantedAt.toLocaleString("zh-CN")}`,
        `  授权人：${outcome.existing.grantedBy}`,
        "",
        "  （这条输出是幂等性的证据：脚本可以安全地重复运行。）",
        "",
      ].join("\n"),
    );
    break;

  case "granted":
    process.stdout.write(
      [
        "",
        outcome.revived ? "  ✅ 已重新授权（原撤销记录已清除）" : "  ✅ 已授权为系统管理员",
        `  用户名：${outcome.user.username}`,
        `  账号编号：${outcome.user.accountNumber}`,
        `  UUID：${outcome.user.id}`,
        `  授权人：${outcome.grant.grantedBy}`,
        `  时间：${outcome.grant.grantedAt.toLocaleString("zh-CN")}`,
        "",
      ].join("\n"),
    );
    break;
}

await prisma.$disconnect();
