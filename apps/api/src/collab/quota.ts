import type { Prisma } from "../generated/prisma/client.js";
import { tooManyRequests } from "../lib/errors.js";

/**
 * ⚠️ **These take a transaction client, not the whole `PrismaClient`.** The quota has to be
 * reserved **inside the same transaction as the thing it authorises** — a deletion, an invitation,
 * a relationship — because otherwise a failure after the reservation would spend somebody's quota
 * on a notification that was never sent. Every caller here either passes `prisma` (which is
 * assignable) or the `tx` it is already working in.
 */
type Client = Prisma.TransactionClient;

/**
 * How many notifications one account may send in a day.
 *
 * ⚠️ **Two ceilings, both the owner's**, and they defend different things:
 *
 * | 上限 | 防的是什么 |
 * |---|---|
 * | 对**同一个**账号每天 5 条 | 反复骚扰同一个人 |
 * | 对**所有**账号每天 20 条 | 群发骚扰 |
 *
 * He asked for the consequence to be visible rather than silent — *"超出次数直接拦下"* — so a
 * refusal is a `429` with a message saying which limit was reached. **A notification that was
 * quietly dropped would look exactly like one that was sent**, which is the failure mode
 * `教训.md` §3.1 describes.
 */
export const PER_SUBJECT_DAILY_LIMIT = 5;
export const TOTAL_DAILY_LIMIT = 20;

/**
 * The account numbers that are **not** held to either ceiling.
 *
 * ⚠️ **The owner's instruction, 2026-10-13**:
 *
 * > *"对于编号前一百（一直到 1000099）的用户取消限制，只跳过限制仍然计数。
 * > 注意其他所有账号都保持不变"*
 *
 * He then confirmed the range as **`10000000`–`10000099`**, which is this project's
 * **first hundred accounts** — his own, his family's, and the 98 codes already minted
 * with reserved numbers (`10000002`–`10000099`, see `docs/邀请码-示例.md` and
 * `pnpm invite:batch`). Everyone else keeps both ceilings exactly as before.
 *
 * ⚠️ **Account numbers are `text` in the database** (`users.account_number` is
 * `@db.VarChar`-free `String`), and the range is compared as numbers here. That is safe
 * and deliberate: the column carries a CHECK constraint pinning it to **eight digits**,
 * so `Number()` cannot lose precision (8 digits is far below `2^53`) and cannot see a
 * leading zero. Comparing the strings instead would have been correct too, but would have
 * married this rule to the width of the field — and the width is the database's business.
 *
 * ⚠️ **This is a range of account numbers, not `users.is_admin`.** The two coincide today
 * (the reserved codes grant admin, and both live accounts are inside the range), and the
 * owner was offered the `is_admin` route and did not take it. Keeping them separate means
 * promoting somebody to admin later does not silently lift their notification ceiling.
 * **Do not "simplify" this to `isAdmin`.**
 */
const EXEMPT_ACCOUNT_NUMBER_FROM = 10_000_000;
const EXEMPT_ACCOUNT_NUMBER_TO = 10_000_099;

/**
 * Is this account number inside the exempt range?
 *
 * ⚠️ **An unrecognisable number is not exempt.** The column is constrained to eight digits,
 * so a value that does not parse means something is structurally wrong — and the safe
 * direction for a **ceiling** is to keep it. The same reasoning as `BookMember.role`
 * defaulting to `viewer`: an error should fail towards less power, not more.
 */
export function isQuotaExempt(accountNumber: string | null | undefined): boolean {
  if (accountNumber === null || accountNumber === undefined) return false;

  if (!/^\d{8}$/.test(accountNumber)) return false;

  const value = Number(accountNumber);
  return value >= EXEMPT_ACCOUNT_NUMBER_FROM && value <= EXEMPT_ACCOUNT_NUMBER_TO;
}

/**
 * The subject id that means "the total across everybody".
 *
 * ⚠️ **An all-zero UUID, not NULL.** PostgreSQL treats NULLs as distinct in a unique index, so a
 * NULL subject would not be constrained to one row per day — two concurrent senders could each
 * create a "total" row, each count to five, and neither would see the other. **A quota that can be
 * doubled by sending two things at once is not a quota.**
 */
const TOTAL_SUBJECT = "00000000-0000-0000-0000-000000000000";

/**
 * The day a notification counts towards.
 *
 * ⚠️ **UTC, and stated rather than assumed.** The owner lives at UTC-7 and his family at UTC+8, so
 * "a day" is genuinely ambiguous here. A per-user local day would be more humane and would also
 * make the limit trivially bypassable by changing a setting; UTC is what the rest of the audit
 * data uses, and **the quota is about rate, not about calendars.**
 */
function today(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Which ceiling was hit, for the message and for the tests. */
export type QuotaRefusal = "per_subject" | "total";

export interface QuotaReservation {
  readonly day: Date;
  readonly subjectId: string;
}

/**
 * Reserve one notification's worth of quota, or refuse.
 *
 * ⚠️ **Check and increment happen in one statement, inside one transaction.**
 *
 * The obvious implementation — count the rows, then insert — has a window between the two steps,
 * and **that window is exactly when two people send their fifth message.** Here the increment is
 * `UPDATE ... WHERE used < limit`: **zero rows affected means the ceiling was reached**, and the
 * transaction rolls back so neither counter moves. There is nothing to race with.
 *
 * ⚠️ **Both counters are reserved together or neither is.** Incrementing the subject counter and
 * then failing the total would leave the subject counter spent on a notification that was never
 * sent — a person could be locked out of messaging somebody by attempts that all failed.
 *
 * ⚠️ **⚠️ The first hundred accounts skip both ceilings** (`isQuotaExempt`), and the two halves of
 * that exception are worth separating:
 *
 * * the **counting still happens** — the owner asked for *"只跳过限制仍然计数"*, so the counters
 *   climb past the limit and the diagnostics screen keeps telling the truth about how much was
 *   actually sent;
 * * only the **refusal** is skipped, and the ceiling is dropped from the `where` clause rather
 *   than compared against: `UPDATE ... WHERE used < limit` is what makes the check atomic, so
 *   removing the predicate is the whole change and there is no second code path to keep in step.
 */
export async function reserveNotificationQuota(
  prisma: Client,
  senderId: string,
  subjectId: string,
  now: Date = new Date(),
): Promise<QuotaReservation> {
  const day = today(now);
  const reason = await prisma.$transaction(async (tx) => {
    /**
     * ⚠️ **Upsert first, then increment.** `updateMany` with a `where` on `used` can only work on
     * a row that exists, and the first notification of a day has no row yet — so the row is
     * created at zero without touching `used` when it already exists.
     */
    for (const subject of [TOTAL_SUBJECT, subjectId]) {
      await tx.notificationQuota.upsert({
        where: { userId_subjectId_day: { userId: senderId, subjectId: subject, day } },
        create: { userId: senderId, subjectId: subject, day, used: 0 },
        update: {},
      });
    }

    /**
     * ⚠️ **Read inside the transaction, so one send cannot see another's state halfway.** The
     * lookup is on the primary key of `users` and happens once per notification.
     */
    const sender = await tx.user.findUnique({
      where: { id: senderId },
      select: { accountNumber: true },
    });

    const exempt = isQuotaExempt(sender?.accountNumber);

    /**
     * ⚠️ **An empty `where` matches every row** — that is the exemption. `{}` rather than a
     * limit of `Infinity`, because "no ceiling" is the thing being expressed and a very large
     * number would just be a ceiling nobody has reached yet.
     */
    const perSubject = await tx.notificationQuota.updateMany({
      where: exempt
        ? { userId: senderId, subjectId, day }
        : { userId: senderId, subjectId, day, used: { lt: PER_SUBJECT_DAILY_LIMIT } },
      data: { used: { increment: 1 }, updatedAt: now },
    });

    if (perSubject.count !== 1) return "per_subject" satisfies QuotaRefusal;

    const total = await tx.notificationQuota.updateMany({
      where: exempt
        ? { userId: senderId, subjectId: TOTAL_SUBJECT, day }
        : { userId: senderId, subjectId: TOTAL_SUBJECT, day, used: { lt: TOTAL_DAILY_LIMIT } },
      data: { used: { increment: 1 }, updatedAt: now },
    });

    if (total.count !== 1) return "total" satisfies QuotaRefusal;

    return null;
  });

  if (reason !== null) throw refusal(reason);

  return { day, subjectId };
}

/**
 * Give one back.
 *
 * ⚠️ **Used when an invitation is withdrawn**, and only then. A notification that was sent and is
 * now cancelled did not occupy the recipient's attention for the rest of the day, so holding its
 * quota would punish somebody for tidying up. **Never used to "refund" a refusal** — a refusal
 * never spent anything, because the transaction rolled back.
 */
export async function releaseNotificationQuota(
  prisma: Client,
  senderId: string,
  subjectId: string,
  day: Date,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const subject of [TOTAL_SUBJECT, subjectId]) {
      await tx.notificationQuota.updateMany({
        where: { userId: senderId, subjectId: subject, day, used: { gt: 0 } },
        data: { used: { decrement: 1 } },
      });
    }
  });
}

function refusal(reason: QuotaRefusal): Error {
  return tooManyRequests(
    reason === "per_subject" ? "notification_quota_subject" : "notification_quota_total",
    reason === "per_subject"
      ? `今天已经给这位用户发过 ${String(PER_SUBJECT_DAILY_LIMIT)} 条通知了，请明天再试。`
      : `今天发出的通知已经达到 ${String(TOTAL_DAILY_LIMIT)} 条上限，请明天再试。`,
  );
}

/** The quota state for one sender today, for the diagnostics screen and the tests. */
export async function quotaState(
  prisma: Client,
  senderId: string,
  now: Date = new Date(),
): Promise<{ readonly totalUsed: number; readonly totalLimit: number }> {
  const day = today(now);

  const row = await prisma.notificationQuota.findUnique({
    where: { userId_subjectId_day: { userId: senderId, subjectId: TOTAL_SUBJECT, day } },
    select: { used: true },
  });

  return { totalUsed: row?.used ?? 0, totalLimit: TOTAL_DAILY_LIMIT };
}
