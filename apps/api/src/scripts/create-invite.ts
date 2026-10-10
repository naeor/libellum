/**
 * Create a single-use registration invite.
 *
 * The project is open source but not open registration, so accounts are created
 * with an invite the owner generates:
 *
 *   pnpm invite:create "给妈妈"
 *
 * The note is only for your own reference and is never shown to the invitee.
 *
 * ⚠️ **The code now reserves the account number it will grant.** The owner
 * wanted to write codes on paper and hand them out before anyone used them, and
 * that only works if the number is decided when the code is made rather than
 * when it is redeemed. The number comes from the `account_number` counter inside
 * the same transaction as the code, so two runs cannot reserve the same one.
 */
import { generateInviteCode } from "../auth/invite-code.js";
import { reserveAccountNumber } from "../auth/recovery-code.js";
import { createPrismaClient } from "../db.js";
import { loadEnv } from "../env.js";

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const note = process.argv[2]?.trim();

const invite = await prisma.$transaction(async (tx) => {
  const accountNumber = await reserveAccountNumber(tx);

  return tx.registrationInvite.create({
    data: { code: generateInviteCode(), note: note ?? null, accountNumber },
  });
});

process.stdout.write(
  [
    "",
    "  邀请码已生成（只能使用一次）",
    `  邀请码：${invite.code}`,
    `  账号编号：${invite.accountNumber ?? "（未预留，注册时分配）"}`,
    note ? `  备注：${note}` : null,
    `  时间：${new Date().toLocaleString("zh-CN")}`,
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n") + "\n",
);

await prisma.$disconnect();
