/**
 * Create a batch of registration invites, one transaction for the lot.
 *
 *   pnpm invite:batch 98 --note "首批"
 *
 * ⚠️ **This generator creates administrators**, and that is why it is separate
 * from `invite:create`. The owner's first batch — account numbers
 * 10000002–10000099 — is the set of codes he hands to the people who may see
 * abandoned ledgers. `createAdminInvite` is the only function that sets that
 * flag, and this script is one of its two callers.
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
 * The codes are printed to standard output. `docs/邀请码.md` is the file the owner
 * asked them to live in, and it is **git-ignored** — a code in the repository is
 * a code in everybody's hands, and these grant accounts *and* administration.
 */
import { createAdminInvite } from "../auth/invites.js";
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
     * `createAdminInvite`, not `createReservedInvite`: this batch is the owner's
     * administrator batch. Reserving the number is part of it — the codes are
     * written down and handed out over months — but the administration is the
     * separate thing the call states, which is the whole point of the flag.
     */
    const invite = await createAdminInvite(tx, note);
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
