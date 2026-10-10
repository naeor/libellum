/**
 * Create a batch of registration invites, one transaction for the lot.
 *
 *   pnpm invite:batch 98 --note "首批"
 *
 * Written for the owner's plan of 2026-10-10: a block of account numbers is
 * reserved for a first batch of codes, written down, and handed out slowly over
 * months. Everything happens in **one transaction** for two reasons:
 *
 *  * the reserved numbers stay contiguous, so the list reads 10000002, 10000003,
 *    … rather than hopping about;
 *  * a failure part-way leaves no codes at all, which is better than half a
 *    batch somebody has to work out the shape of.
 *
 * The codes are printed to standard output. `docs/invite-codes.md` is the file
 * the owner asked them to live in, and it is **git-ignored** — a code in the
 * repository is a code in everybody's hands, and these grant accounts.
 */
import { createReservedInvite } from "../auth/invites.js";
import { createPrismaClient } from "../db.js";
import { loadEnv } from "../env.js";

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const count = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isInteger(count) || count < 1 || count > 500) {
  process.stderr.write("用法：pnpm invite:batch <数量 1-500> [--note \"备注\"]\n");
  process.exit(1);
}

const noteIndex = process.argv.indexOf("--note");
const note = noteIndex >= 0 ? (process.argv[noteIndex + 1]?.trim() ?? null) : null;

const created = await prisma.$transaction(async (tx) => {
  const rows: { code: string; accountNumber: string | null }[] = [];

  for (let index = 0; index < count; index += 1) {
    /**
     * The batch generator makes **reserved** codes: each carries the account
     * number it will grant and does not expire.
     *
     * That is the whole purpose of a batch — it is written down and handed out
     * slowly, which a seven-day code cannot survive. `createReservedInvite`
     * also reserves the number from the counter inside this same transaction, so
     * the numbers come out contiguous and a failure leaves no half-batch.
     */
    const invite = await createReservedInvite(tx, note);
    rows.push({ code: invite.code, accountNumber: invite.accountNumber });
  }

  return rows;
});

const lines = [
  `# 邀请码（${String(created.length)} 个，一次性，每个对应一个账号编号）`,
  "",
  `生成时间：${new Date().toLocaleString("zh-CN")}`,
  note === null ? null : `备注：${note}`,
  "",
  "| # | 邀请码 | 账号编号 | 已使用 |",
  "|---|---|---|---|",
  ...created.map(
    (row, index) =>
      `| ${String(index + 1)} | \`${row.code}\` | ${row.accountNumber ?? "—"} | 否 |`,
  ),
  "",
].filter((line): line is string => line !== null);

process.stdout.write(lines.join("\n") + "\n");

await prisma.$disconnect();
