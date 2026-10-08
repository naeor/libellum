import { z } from "zod";

/**
 * Account rules live in the shared package so the browser and the API enforce
 * exactly the same constraints — the client for fast feedback, the server
 * because it is the only side that actually matters.
 */

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;
export const DISPLAY_NAME_MAX_LENGTH = 40;

export const usernameSchema = z
  .string()
  .trim()
  .regex(USERNAME_PATTERN, "用户名需为 3–20 位字母、数字或下划线");

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${String(PASSWORD_MIN_LENGTH)} 位`)
  .max(PASSWORD_MAX_LENGTH, `密码最多 ${String(PASSWORD_MAX_LENGTH)} 位`);

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "请填写显示名称")
  .max(DISPLAY_NAME_MAX_LENGTH, `显示名称最多 ${String(DISPLAY_NAME_MAX_LENGTH)} 个字符`);

export const inviteCodeSchema = z.string().trim().min(4, "请填写邀请码");

export const registerRequestSchema = z.object({
  inviteCode: inviteCodeSchema,
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
});

export const loginRequestSchema = z.object({
  username: z.string().trim().min(1, "请填写用户名"),
  password: z.string().min(1, "请填写密码"),
});

export const recoverRequestSchema = z.object({
  username: usernameSchema,
  recoveryCode: z.string().trim().min(1, "请填写恢复码"),
  newPassword: passwordSchema,
});

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, "请输入当前密码"),
  newPassword: passwordSchema,
});

export const regenerateRecoveryCodeRequestSchema = z.object({
  password: z.string().min(1, "请输入当前密码"),
});

/** Fields of the signed-in user that the browser is allowed to see. */
export const sessionUserSchema = z.object({
  id: z.string(),
  /** Eight-digit public account number such as `48213907`. */
  accountNumber: z.string(),
  username: z.string(),
  displayName: z.string(),
  isDemo: z.boolean(),
  createdAt: z.string(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

export const meResponseSchema = z.object({ user: sessionUserSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const authResponseSchema = z.object({
  user: sessionUserSchema,
  /** Present only immediately after registration — shown once, never again. */
  recoveryCode: z.string().optional(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const recoveryCodeResponseSchema = z.object({ recoveryCode: z.string() });
export type RecoveryCodeResponse = z.infer<typeof recoveryCodeResponseSchema>;

/** Uniform error body returned by every endpoint. */
export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
