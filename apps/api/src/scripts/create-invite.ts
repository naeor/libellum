/**
 * Create a single-use registration invite.
 *
 * The project is open source but not open registration, so accounts are created
 * with an invite the owner generates:
 *
 *   pnpm invite:create "给妈妈"            # 七天后过期，可撤销
 *   pnpm invite:create "首批" --reserved  # 预留账号编号，不过期
 *
 * The note is only for your own reference and is never shown to the invitee.
 *
 * ⚠️ **Two kinds of code, and the difference matters.**
 *
 *  * **Ordinary** — lives seven days, can be revoked. For "somebody needs an
 *    account and I am sending them a code now". The owner asked for both rules
 *    on 2026-10-10, because a code travels through a chat window and the sender
 *    needs a way to take it back.
 *  * **`--reserved`** — carries the account number it will grant, and **does not
 *    expire**. This is the batch meant to be written down and handed out over
 *    months; a code that dies in a week cannot be handed out at all.
 */
import { INVITE_VALID_DAYS } from "@libellum/shared";

import { createOrdinaryInvite, createReservedInvite } from "../auth/invites.js";
import { createPrismaClient } from "../db.js";
import { loadEnv } from "../env.js";

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const args = process.argv.slice(2);
const reserved = args.includes("--reserved");
const note = args.find((argument) => !argument.startsWith("--"))?.trim() ?? null;

const invite = await prisma.$transaction(async (tx) =>
  reserved ? createReservedInvite(tx, note) : createOrdinaryInvite(tx, note),
);

const lifetime =
  invite.expiresAt === null
    ? `永不过期（预留编号 ${invite.accountNumber ?? "—"}）`
    : `${String(INVITE_VALID_DAYS)} 天后过期（${invite.expiresAt.toLocaleString("zh-CN")}）`;

process.stdout.write(
  [
    "",
    "  邀请码已生成（只能使用一次）",
    `  邀请码：${invite.code}`,
    `  有效期：${lifetime}`,
    note ? `  备注：${note}` : null,
    `  时间：${new Date().toLocaleString("zh-CN")}`,
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n") + "\n",
);

await prisma.$disconnect();
