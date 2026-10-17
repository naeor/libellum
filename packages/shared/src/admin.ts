import { z } from "zod";

/**
 * The admin console's wire contract (S13).
 *
 * ⚠️ **These schemas describe what the server is allowed to send, and that list is a decision
 * rather than a description.** The owner's rule: *"管理员可以管理系统，不应因此默认拥有查看
 * 所有私人账本的权限。"* So **not one field here is a transaction, an amount, a note or a ledger
 * name** — only counts, account identifiers and management metadata.
 *
 * ⚠️ **No password hash, no recovery code, no session token, no invite plaintext** (except the
 * single creation response, which is the one moment the plaintext exists on purpose).
 */

/** The management actions that can appear in the audit log. Stable identifiers, not sentences. */
export const AUDIT_ACTIONS = [
  "invite.create",
  "invite.revoke",
  "account.suspend",
  "account.restore",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** One audit row as the console displays it. */
export const auditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  adminUsername: z.string(),
  action: z.string(),
  target: z.string().nullable(),
  outcome: z.enum(["success", "failed"]),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

/**
 * **"Am I an administrator?"** — the only thing the frontend needs to decide whether to render
 * the entry point.
 *
 * ⚠️ **This is a UI hint, never a permission.** Every admin route re-runs `createRequireAdmin`
 * on its own; hiding a row in the browser has never made an endpoint safe.
 */
export const adminSelfResponseSchema = z.object({
  isAdmin: z.boolean(),
  username: z.string(),
  accountNumber: z.string(),
});

export type AdminSelfResponse = z.infer<typeof adminSelfResponseSchema>;

/** Counts only — no user detail, no money. */
export const adminOverviewResponseSchema = z.object({
  users: z.object({
    total: z.number().int().nonnegative(),
    suspended: z.number().int().nonnegative(),
    demo: z.number().int().nonnegative(),
  }),
  books: z.object({ total: z.number().int().nonnegative() }),
  invites: z.object({
    available: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    revoked: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
  }),
  admins: z.object({
    active: z.number().int().nonnegative(),
    halfConfigured: z.number().int().nonnegative(),
  }),
  /**
   * ⚠️ **The last backup, or `null` when nothing has been recorded yet.**
   *
   * `null` is rendered as "还没有记录", never as "备份正常" — a screen that invents reassurance
   * is worse than one that admits it does not know. The writer (`backup.sh`) is not connected
   * yet; see `prisma/schema.prisma` → `BackupLog`.
   */
  lastBackup: z
    .object({
      at: z.string(),
      ok: z.boolean(),
      note: z.string().nullable(),
    })
    .nullable(),
  recentActions: z.array(auditEntrySchema),
});

export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;

/** Where an invite stands. Computed from the timestamps, never stored (see `rejectInvite`). */
export const adminInviteStatusSchema = z.enum(["available", "used", "revoked", "expired"]);

export type AdminInviteStatus = z.infer<typeof adminInviteStatusSchema>;

/**
 * One invite, **with the code masked**.
 *
 * ⚠️ **The plaintext appears in exactly one place: the creation response.** After that the
 * console shows `7K2M-••••-••••`. The owner's instruction is *"邀请码创建之后不显示"*.
 */
export const adminInviteSchema = z.object({
  /** The invite's UUID, for revoking it. */
  id: z.string(),
  /** The code with its middle groups replaced by bullets. */
  maskedCode: z.string(),
  note: z.string().nullable(),
  /** The account number this code reserves, when it reserves one. */
  accountNumber: z.string().nullable(),
  status: adminInviteStatusSchema,
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  usedAt: z.string().nullable(),
  /** Who redeemed it — a username, not a UUID. */
  usedByUsername: z.string().nullable(),
});

export type AdminInvite = z.infer<typeof adminInviteSchema>;

export const adminInviteListResponseSchema = z.object({
  invites: z.array(adminInviteSchema),
});

export type AdminInviteListResponse = z.infer<typeof adminInviteListResponseSchema>;

/**
 * The two shapes the console may create.
 *
 * ⚠️ **There is no "administrator invite" here, and that is not an omission.** Since 1.10.22 a
 * code never confers administration — `registration_invites.grants_admin` is kept for the
 * numbers it reserved and **nothing reads it to decide a privilege**. An administrator is made by
 * `pnpm admin:grant` + `pnpm admin:allow` at a server terminal, and by nothing else.
 */
export const adminInviteShapeSchema = z.enum(["ordinary", "reserved"]);

export type AdminInviteShape = z.infer<typeof adminInviteShapeSchema>;

export const adminCreateInviteRequestSchema = z.object({
  shape: adminInviteShapeSchema,
  /** Only for the owner: never shown to the invitee. */
  note: z.string().trim().max(200).optional(),
});

export type AdminCreateInviteRequest = z.infer<typeof adminCreateInviteRequestSchema>;

export const adminCreateInviteResponseSchema = z.object({
  invite: adminInviteSchema,
  /**
   * The plaintext, returned **once**, at creation.
   *
   * ⚠️ It is never stored in a readable form anywhere else: not in the audit row, not in a log,
   * not in the list. The create response is the only copy the operator will ever get.
   */
  code: z.string(),
});

export type AdminCreateInviteResponse = z.infer<typeof adminCreateInviteResponseSchema>;

/**
 * Revoking an invite.
 *
 * ⚠️ **`password` is the second factor, required server-side.** A confirmation dialog in the
 * browser protects nobody: the rule has to hold for a request that never saw the dialog.
 */
export const adminRevokeInviteRequestSchema = z.object({
  reason: z.string().trim().min(1).max(200),
  password: z.string().min(1),
  /**
   * ⚠️ **Required when the code was already redeemed.** Revoking a used code does **not** close
   * the account it created — the owner was explicit: *"注销邀请码并不意味着要注销这个账户，
   * 对应的账户依然要手动进行相关操作"* — so the client must acknowledge that it read the
   * warning, and the server refuses without it.
   */
  acknowledgeUsed: z.boolean().optional(),
});

export type AdminRevokeInviteRequest = z.infer<typeof adminRevokeInviteRequestSchema>;

/** One account's position in the administrator picture. */
export const adminRosterEntrySchema = z.object({
  userId: z.string(),
  accountNumber: z.string(),
  username: z.string(),
  displayName: z.string(),
  /**
   * `active` — both halves live.
   * `grant_only` / `allowlist_only` — **only half, which is a refusal**, shown in red.
   * `eligible` — may hold administration but does not.
   */
  status: z.enum(["active", "grant_only", "allowlist_only", "eligible"]),
  grantedAt: z.string().nullable(),
  listedAt: z.string().nullable(),
});

export type AdminRosterEntry = z.infer<typeof adminRosterEntrySchema>;

export const adminRosterResponseSchema = z.object({
  entries: z.array(adminRosterEntrySchema),
  /** How many accounts sit inside the first-batch range at all. */
  eligibleTotal: z.number().int().nonnegative(),
});

export type AdminRosterResponse = z.infer<typeof adminRosterResponseSchema>;

/** One account, as the search result shows it. Deliberately minimal. */
export const adminUserSchema = z.object({
  userId: z.string(),
  accountNumber: z.string(),
  username: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  isDemo: z.boolean(),
  /** Whether this account currently holds administration (both halves). */
  isActiveAdmin: z.boolean(),
  suspendedAt: z.string().nullable(),
  /** How many devices are signed in — useful right before suspending one. */
  activeSessions: z.number().int().nonnegative(),
});

export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUserSearchResponseSchema = z.object({
  /** Empty unless the query matched exactly; no fuzzy browsing of the account list. */
  users: z.array(adminUserSchema),
  /** True when the query was not a valid exact-match form (so the UI can say why it found nothing). */
  exactMatchOnly: z.boolean(),
});

export type AdminUserSearchResponse = z.infer<typeof adminUserSearchResponseSchema>;

export const adminSuspendRequestSchema = z.object({
  reason: z.string().trim().min(1).max(200),
  password: z.string().min(1),
});

export type AdminSuspendRequest = z.infer<typeof adminSuspendRequestSchema>;

export const adminRestoreRequestSchema = z.object({
  reason: z.string().trim().min(1).max(200),
  password: z.string().min(1),
});

export type AdminRestoreRequest = z.infer<typeof adminRestoreRequestSchema>;

export const adminAccountActionResponseSchema = z.object({
  ok: z.literal(true),
  username: z.string(),
  /** How many sessions were deleted. Zero on restore. */
  sessionsRemoved: z.number().int().nonnegative(),
});

export type AdminAccountActionResponse = z.infer<typeof adminAccountActionResponseSchema>;

export const adminAuditListResponseSchema = z.object({
  entries: z.array(auditEntrySchema),
});

export type AdminAuditListResponse = z.infer<typeof adminAuditListResponseSchema>;
/**
 * **The first-batch range — the one definition, shared by the server and the browser.**
 *
 * ⚠️ **Why it is here and not only in the API.** The owner's instruction (2026-10-17):
 * *"在客户本地端也在一条判断吧：利用客户本地端可以看到的信息……判断这个用户是不是管理员用户。
 * 如果不是管理员用户的话，直接隐藏管理入口就行，或者说压根不渲染……例如，可以通过账号编号是不是
 * 前 100 来判断之类的。"*
 *
 * The browser already holds the account number (`SessionUser.accountNumber`), so this check
 * costs a string comparison and **no request at all** — an ordinary account never even asks the
 * server whether it may see the console.
 *
 * ⚠️ **This is a UI hint and it must never grow into a permission.** The range is a
 * *qualification*, not a grant: being inside it means the account **may** hold administration,
 * not that it does. Every admin endpoint re-runs the full five-check guard on the server, and
 * nothing in this file is trusted there.
 *
 * ⚠️ **String comparison, deliberately** — numbers are zero-padded to eight digits, so
 * lexicographic and numeric order agree; a malformed value is "no", because a gate facing
 * something it does not understand should refuse.
 */
export const FIRST_BATCH_ACCOUNT_FIRST = "10000000";
export const FIRST_BATCH_ACCOUNT_LAST = "10000099";

/** How many accounts the range covers. Named so the number appears in exactly one place. */
export const FIRST_BATCH_SIZE = 100;

/** Whether an account number is inside the first batch. */
export function isFirstBatchAccountNumber(accountNumber: string): boolean {
  if (!/^\d{8}$/.test(accountNumber)) return false;

  return accountNumber >= FIRST_BATCH_ACCOUNT_FIRST && accountNumber <= FIRST_BATCH_ACCOUNT_LAST;
}