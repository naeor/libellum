/**
 * Create a single-use registration invite.
 *
 * The project is open source but not open registration, so accounts are created
 * with an invite the owner generates:
 *
 *   pnpm invite:create "给妈妈"
 *
 * The note is only for your own reference and is never shown to the invitee.
 */
import { randomBytes } from "node:crypto";

import { createPrismaClient } from "../db.js";
import { loadEnv } from "../env.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

function generateInviteCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let raw = "";

  for (let index = 0; index < CODE_LENGTH; index += 1) {
    raw += ALPHABET[bytes[index]! % ALPHABET.length];
  }

  return raw.replace(/(.{4})(?=.)/g, "$1-");
}

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const note = process.argv[2]?.trim();

const invite = await prisma.registrationInvite.create({
  data: { code: generateInviteCode(), note: note ?? null },
});

process.stdout.write(
  [
    "",
    "  邀请码已生成（只能使用一次）",
    `  邀请码：${invite.code}`,
    note ? `  备注：${note}` : null,
    `  时间：${new Date().toLocaleString("zh-CN")}`,
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n") + "\n",
);

await prisma.$disconnect();
