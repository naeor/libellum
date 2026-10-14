/**
 * **Show who can administer the platform — and, separately, who merely qualifies.**
 *
 * Read-only. It exists because two pairs of things are constantly confused, and both pairs
 * matter:
 *
 *   * **授权 vs 允许名单** — an account can hold the role without being on the list, or be on
 *     the list without holding the role. **Either alone is a refusal.** Printing them in two
 *     columns is the whole point of the command.
 *   * **管理员 vs 有资格** — the first hundred account numbers may *be granted* administration.
 *     They do not have it. Printing the qualified-but-not-administered accounts separately is
 *     how that sentence stops being a claim and becomes something you can look at.
 *
 * ⚠️ **No secrets are printed.** A UUID and an account number identify an account; they do not
 * authenticate as one. The output is safe to paste into a chat window, which is where this
 * kind of question usually gets answered.
 *
 * ```bash
 * pnpm admin:list
 * ```
 */
import { createPrismaClient } from "../db.js";
import { loadEnv } from "../env.js";
import {
  FIRST_BATCH_ACCOUNT_FIRST,
  FIRST_BATCH_ACCOUNT_LAST,
  FIRST_BATCH_SIZE,
  isFirstBatchAccountNumber,
} from "../admin/rules.js";

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const users = await prisma.user.findMany({
  select: {
    id: true,
    username: true,
    accountNumber: true,
    isAdmin: true,
    isDemo: true,
    adminGrant: { select: { grantedAt: true, grantedBy: true, revokedAt: true, revokedBy: true } },
    adminAllowEntry: {
      select: { listedAt: true, listedBy: true, revokedAt: true, revokedBy: true },
    },
  },
  orderBy: { accountNumber: "asc" },
});

type Row = (typeof users)[number];

const live = (record: { revokedAt: Date | null } | null): boolean =>
  record !== null && record.revokedAt === null;

const granted = (user: Row): boolean => live(user.adminGrant);
const listed = (user: Row): boolean => live(user.adminAllowEntry);

/** Only both halves together actually pass the guard. */
const administrators = users.filter((user) => granted(user) && listed(user));
const qualified = users.filter(
  (user) => !user.isDemo && isFirstBatchAccountNumber(user.accountNumber),
);

/**
 * ⚠️ **This section is the one that would have caught the bug 1.10.23 fixed.**
 * Before that version the second check was derived from the first, so this list could only
 * ever be empty — and an empty "half-applied" section is easy to read as "nothing to see".
 * Now it is a real state, and printing it is how a mis-typed UUID becomes visible.
 */
const halfApplied = users.filter((user) => granted(user) !== listed(user));

function row(user: Row): string {
  const flags = [
    user.isDemo ? "演示" : null,
    user.isAdmin ? "is_admin" : null,
    granted(user) ? "已授权" : "未授权",
    listed(user) ? "在名单" : "不在名单",
  ]
    .filter((flag): flag is string => flag !== null)
    .join("  ");
  return `  ${user.username.padEnd(16)} ${user.accountNumber}  ${user.id}  ${flags}`;
}

const lines: string[] = [
  "",
  "  ==================== 真正的管理员（授权 + 名单，两者都有） ====================",
  `  资格区间：${FIRST_BATCH_ACCOUNT_FIRST}–${FIRST_BATCH_ACCOUNT_LAST}（共 ${String(FIRST_BATCH_SIZE)} 个）`,
  "",
  administrators.length === 0
    ? "  ⚠️ 当前没有任何账号同时持有授权与名单记录——也就是没有任何管理员。"
    : administrators
        .map(
          (user) =>
            `${row(user)}\n      授权：${user.adminGrant?.grantedAt.toLocaleString("zh-CN") ?? "?"}` +
            `（${user.adminGrant?.grantedBy ?? "?"}）` +
            `   名单：${user.adminAllowEntry?.listedAt.toLocaleString("zh-CN") ?? "?"}` +
            `（${user.adminAllowEntry?.listedBy ?? "?"}）`,
        )
        .join("\n"),
  "",
  "  ==================== ⚠️ 只满足一半（不会通过校验） ====================",
  "  授权与名单是两件事。下面这些账号只满足其中一项，**管理员操作一律被拒**。",
  "",
  halfApplied.length === 0
    ? "  （没有——两边的记录目前一致）"
    : halfApplied
        .map(
          (user) =>
            `${row(user)}\n      ${
              granted(user)
                ? "有授权但不在名单 → 拒绝（需要 pnpm admin:allow）"
                : "在名单但没有授权 → 拒绝（需要 pnpm admin:grant）"
            }`,
        )
        .join("\n"),
  "",
  `  ==================== 有资格但未授权（${String(qualified.length)} 个）= ` +
    "===================",
  "  ⚠️ 有资格 ≠ 是管理员。这些账号只是「可以被授权」。",
  "",
  qualified.length === 0
    ? "  （没有）"
    : qualified
        .filter((user) => !administrators.some((admin) => admin.id === user.id))
        .map(row)
        .join("\n") || "  （都已经是管理员）",
  "",
  "  ==================== 已撤销 / 已移出的记录 ====================",
  "",
  users
    .filter(
      (user) => user.adminGrant?.revokedAt != null || user.adminAllowEntry?.revokedAt != null,
    )
    .map((user) => {
      const parts: string[] = [`  ${user.username.padEnd(16)} ${user.accountNumber}`];
      if (user.adminGrant?.revokedAt != null) {
        parts.push(
          `      授权已撤销 ${user.adminGrant.revokedAt.toLocaleString("zh-CN")}` +
            `（${user.adminGrant.revokedBy ?? "?"}）`,
        );
      }
      if (user.adminAllowEntry?.revokedAt != null) {
        parts.push(
          `      已移出名单 ${user.adminAllowEntry.revokedAt.toLocaleString("zh-CN")}` +
            `（${user.adminAllowEntry.revokedBy ?? "?"}）`,
        );
      }
      return parts.join("\n");
    })
    .join("\n") || "  （没有）",
  "",
];

process.stdout.write(lines.join("\n"));

await prisma.$disconnect();
