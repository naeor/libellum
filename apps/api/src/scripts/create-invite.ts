/**
 * Create a single-use registration invite.
 *
 * The project is open source but not open registration, so accounts are created
 * with an invite the owner generates:
 *
 *   pnpm invite:create "给妈妈"            # 七天后过期，可撤销，普通账号
 *   pnpm invite:create "首批" --admin      # 预留账号编号，不过期，**管理员**
 *   pnpm invite:create "爸爸" --reserved   # 预留账号编号，不过期，普通账号
 *
 * The note is only for your own reference and is never shown to the invitee.
 *
 * ⚠️ **Three shapes, because they are three different decisions.**
 *
 *  * **Ordinary** (default) — lives seven days, can be revoked, ordinary powers.
 *    For "somebody needs an account and I am sending them a code now".
 *  * **`--reserved`** — carries the account number it will grant and does not
 *    expire, so it can be written on a card and handed over months later. Still
 *    an ordinary account.
 *  * **`--admin`** — the above **plus platform administration**. This is the only
 *    way to create an administrator, and it has to be asked for by name.
 *
 * That last distinction exists because the owner caught the earlier version
 * inferring administration from "the code reserved a number", which meant any
 * command that reserved one minted an administrator.
 */
import { INVITE_VALID_DAYS } from "@libellum/shared";

import {
  createAdminInvite,
  createOrdinaryInvite,
  createReservedInvite,
} from "../auth/invites.js";
import { createPrismaClient } from "../db.js";
import { loadEnv } from "../env.js";

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const args = process.argv.slice(2);
const admin = args.includes("--admin");
const reserved = admin || args.includes("--reserved");
const note = args.find((argument) => !argument.startsWith("--"))?.trim() ?? null;

const invite = await prisma.$transaction(async (tx) => {
  if (admin) return createAdminInvite(tx, note);
  if (reserved) return createReservedInvite(tx, note);

  return createOrdinaryInvite(tx, note);
});

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
    `  权限：${invite.grantsAdmin ? "⚠️ 管理员（可访问全部数据）" : "普通账号"}`,
    note ? `  备注：${note}` : null,
    `  时间：${new Date().toLocaleString("zh-CN")}`,
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n") + "\n",
);

await prisma.$disconnect();
