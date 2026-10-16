/**
 * **设置某个账号的密码** —— 服务器终端前的操作，不需要登录。
 *
 * ```bash
 * pnpm set:password <用户 UUID> --password "<新密码>" --by "<操作者>"
 * ```
 *
 * ⚠️ **为什么需要它**：应用里改密码的接口（`POST /api/v1/auth/password`）**要求先登录**，
 * 而恢复密码要靠**恢复码**。当两者都不可用时（密码记错、恢复码也丢了），
 * **唯一剩下的路径就是站在服务器终端前**——那本来就是比应用管理员更高的一层权限。
 * 这不是后门：它需要数据库访问权，而拿到它的人本来就能改任何东西。
 *
 * ⚠️ **哈希用项目自己的 `hashPassword`**（Argon2id，m=19456 t=2 p=1），
 * 不另写一套参数——**关于同一件事的第二份实现迟早会不一致**（`教训.md` §8.7）。
 *
 * ⚠️ **口令从命令行读，不写进任何文件**，也不打印回来。
 * 改完只打印"改成功了"以及账号标识。
 */
import { createPrismaClient } from "../db.js";
import { loadEnv } from "../env.js";
import { hashPassword } from "../auth/password.js";

const args = process.argv.slice(2);

function flag(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

const target = args.find((argument) => !argument.startsWith("--") && argument.includes("-"))?.trim();
const password = flag("--password");
const by = flag("--by");

function fail(message: string): never {
  process.stderr.write(`\n❌ ${message}\n\n`);
  process.exit(1);
}

if (target === undefined || target === "") {
  fail("用法：pnpm set:password <用户 UUID> --password \"<新密码>\" --by \"<操作者>\"");
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
  fail(`"${target}" 不是一个 UUID。用 \`pnpm admin:list\` 查真实值。`);
}
if (password === null || password === "") {
  fail("缺少 --password。");
}
if (password.length < 8) {
  fail(`密码太短（${String(password.length)} 位）。至少 8 位。`);
}
if (by === null || by === "") {
  fail("缺少 --by <操作者>：改密码必须写下是谁做的。");
}

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const hash = await hashPassword(password);

const result = await prisma.$transaction(async (tx) => {
  const user = await tx.user.findUnique({
    where: { id: target },
    select: { id: true, username: true, accountNumber: true, passwordHash: true },
  });
  if (user === null) return { kind: "missing" as const };

  const unchanged = user.passwordHash === hash;
  await tx.user.update({ where: { id: user.id }, data: { passwordHash: hash } });
  return { kind: "ok" as const, user, unchanged };
});

if (result.kind === "missing") {
  fail(`没有这个账号：${target}\n（没有写入任何东西）`);
}

process.stdout.write(
  [
    "",
    "  ✅ 密码已更新",
    `  用户名：${result.user.username}`,
    `  账号编号：${result.user.accountNumber}`,
    `  UUID：${result.user.id}`,
    `  操作者：${by}`,
    `  时间：${new Date().toLocaleString("zh-CN")}`,
    "",
    "  ⚠️ 新密码只用于验证，没有回显。请立刻用它登录一次确认。",
    "  ⚠️ 已有的登录会话不受影响（改密码不会踢掉已登录的设备）。",
    "",
  ].join("\n"),
);

await prisma.$disconnect();
