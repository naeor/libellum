import type { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "../db.js";
import type { AuditAction, AuditEntry } from "@libellum/shared";

/**
 * **Where administrative actions are written down.**
 *
 * ⚠️ **This is not a log line — it is a row in the same transaction as the change.**
 * The project already decided this shape once for ledger history (`ledger/events.ts`):
 * *"recorded in the same transaction as the insert, so the ledger can never show an entry whose
 * creation nobody performed — or a creation for an entry that was rolled back."* An
 * administrative action that happened without a record is exactly the failure mode an audit
 * trail exists to prevent, so the same rule applies here.
 *
 * ⚠️ **Nothing in here is ever a credential.** No password, no session token, no recovery code,
 * no invite plaintext. `target` names the object by something a human can read later.
 *
 * ⚠️ **The row has no foreign key to `users`** (see the migration): an audit record must outlive
 * the account it describes, and `admin_username` is the snapshot that keeps it readable.
 */
export interface AuditInput {
  readonly adminUserId: string;
  readonly adminUsername: string;
  readonly action: AuditAction;
  readonly target?: string | null;
  readonly outcome: "success" | "failed";
  /**
   * The minimum extra context, and it has to earn its place: the shape of an invite, an account
   * number, the reason a refusal happened. **Never** a value that could be replayed.
   */
  readonly detail?: Record<string, unknown> | null;
  readonly requestId?: string | null;
}

/**
 * **A Prisma client or a transaction** — the audit write joins whichever one the caller is
 * using, so it commits or rolls back with the change it describes.
 */
export type AuditWriter = Prisma.TransactionClient;

/** Prisma's JSON column wants a plain value, not `undefined`. */
function detailOf(input: AuditInput): Record<string, unknown> | null {
  return input.detail ?? null;
}

/**
 * Write one audit row.
 *
 * ⚠️ **Called inside the caller's transaction when the operation succeeds**, so the change and
 * its record commit together. On a refusal there is no transaction to join — `recordRefusal`
 * below is the best-effort path for those, and it deliberately swallows its own errors: a
 * failed attempt that could not be recorded must still be refused.
 */
export async function recordAudit(tx: AuditWriter, input: AuditInput): Promise<void> {
  const detail = detailOf(input);

  await tx.adminAuditLog.create({
    data: {
      adminUserId: input.adminUserId,
      adminUsername: input.adminUsername,
      action: input.action,
      target: input.target ?? null,
      outcome: input.outcome,
      /**
       * ⚠️ Prisma's JSON column takes `InputJsonValue`, and a plain `Record<string, unknown>` is
       * not assignable to it because `unknown` could be something JSON cannot represent. The cast
       * is the same one `ledger/events.ts` uses for `changes`; the values written here are built
       * a few lines above (strings, numbers, booleans, nulls), never arbitrary request input.
       *
       * ⚠️ **A null detail is omitted, not written as JSON `null`.** Prisma distinguishes
       * "column is NULL" (`Prisma.DbNull`) from "JSON value null" and refuses a bare `null`, and
       * "no extra detail" is the first of those.
       */
      ...(detail === null ? {} : { detail: detail as Prisma.InputJsonValue }),
      requestId: input.requestId ?? null,
    },
  });
}

/** A logger shape, kept narrow so this module does not depend on Fastify. */
export interface AuditLogger {
  error(obj: unknown, message?: string): void;
}

/**
 * Record a **refusal** — a wrong password, a refused target — without failing the response.
 *
 * ⚠️ **The failure path must never turn a clean 403 into a 500.** If the audit write breaks, the
 * request still gets refused; the operator sees the error in the server log instead of the audit
 * table. `记录失败` must not become `操作成功`.
 */
export async function recordRefusal(
  prisma: PrismaClient,
  logger: AuditLogger,
  input: AuditInput,
): Promise<void> {
  try {
    await recordAudit(prisma, { ...input, outcome: "failed" });
  } catch (error) {
    logger.error({ err: error, audit: input.action }, "审计写入失败（这条记录没有落库）");
  }
}

/** Map a row to the wire shape. */
export function toAuditEntry(row: {
  id: string;
  at: Date;
  adminUsername: string;
  action: string;
  target: string | null;
  outcome: string;
}): AuditEntry {
  return {
    id: row.id,
    at: row.at.toISOString(),
    adminUsername: row.adminUsername,
    action: row.action,
    target: row.target,
    outcome: row.outcome === "failed" ? "failed" : "success",
  };
}
