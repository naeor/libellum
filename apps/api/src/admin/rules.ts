/**
 * **Who may administer the platform**, expressed as rules rather than as checks.
 *
 * This file holds the *definitions* — what a first-batch account is, what a valid grant
 * means — and nothing that touches a request. `guard.ts` next to it composes them into
 * the actual authorization step. The split exists so the rules can be reasoned about and
 * **tested without a server**, which is where most of the interesting cases live.
 *
 * See `docs/开发过程记录/管理员与权限边界-设计决定.md` for the decisions behind all of this.
 */

/**
 * The first hundred account numbers, and therefore the only accounts that may **ever**
 * hold administration.
 *
 * ⚠️ **This is a qualification, not a promotion, and the distinction is the whole point.**
 * Being inside this range means an account *may* be granted administration. It does not
 * mean it has any. The owner's instruction is explicit: *"具有管理员资格，不等于自动成为
 * 管理员"* — account 1 qualifies and is not an administrator; account 50 qualifies and is
 * not an administrator; account 101 does not qualify and normally cannot become one.
 *
 * ⚠️ **Why the range is trustworthy, when the registration order was not.** It would be
 * easy — and wrong — to "rank" accounts by `created_at`, by UUID sort order, or by
 * pretending the account number *is* the order. None of those is a fact. What *is* a fact
 * is that this project allocates numbers from **counter blocks that the migrations seed**
 * (`auth/recovery-code.ts` → `COUNTER_SEEDS`): `10000000`–`10000099` is the block the owner
 * reserved for the first batch, the direct counter starts above it at `10000101`, and
 * migration `20261010163000` is where that shape came from. So the range is not a guess
 * about who arrived first — **it is the project's own definition of the first batch**, and
 * it is the same range `collab/quota.ts` already uses for the notification exemption.
 *
 * ⚠️ **It is stable against everything section 2 of the brief worried about**: account
 * numbers never change, so deleting an account, renaming one, or changing a display name
 * cannot move anybody in or out of the range. `users.account_number` is `@unique` and
 * `NOT NULL`, and nothing in the application writes it after signup.
 */
export const FIRST_BATCH_ACCOUNT_FIRST = "10000000";
export const FIRST_BATCH_ACCOUNT_LAST = "10000099";

/** How many accounts the range covers. Named so the number appears in exactly one place. */
export const FIRST_BATCH_SIZE = 100;

/**
 * Whether an account number is inside the first batch.
 *
 * ⚠️ **String comparison, deliberately.** Account numbers are zero-padded to eight digits
 * (`formatAccountNumber` in `auth/recovery-code.ts`), so lexicographic order and numeric
 * order agree for every value the application can produce. Comparing as numbers would work
 * too; comparing as strings avoids a `Number()` on a value that came out of the database
 * and would silently do something surprising with a leading sign or a stray space.
 *
 * A malformed value — not eight digits — is **not** eligible rather than throwing: this
 * function is a gate, and the safe answer for a gate facing something it does not
 * understand is "no".
 */
export function isFirstBatchAccountNumber(accountNumber: string): boolean {
  if (!/^\d{8}$/.test(accountNumber)) return false;

  return accountNumber >= FIRST_BATCH_ACCOUNT_FIRST && accountNumber <= FIRST_BATCH_ACCOUNT_LAST;
}

/**
 * A dated, revocable record — the shape shared by `admin_grants` and `admin_allowlist`.
 *
 * ⚠️ **Both tables have this shape, and that is a coincidence of form rather than of
 * meaning.** They answer different questions, are written by different commands, and are
 * revoked separately; what they share is only "a row that is either live or withdrawn".
 * Reusing *this function* is therefore fine — reusing *one table* for both questions was the
 * bug that 1.10.23 fixed. See `admin/guard.ts`.
 *
 * Deliberately a plain shape rather than the Prisma type: the guard must be testable with a
 * literal, and importing the generated client here would drag a database into a module whose
 * whole job is to answer a question.
 */
export interface RevocableRecord {
  readonly userId: string;
  readonly revokedAt: Date | null;
}

/** Whether such a record is live right now. */
export function isGrantActive(record: RevocableRecord | null): boolean {
  return record !== null && record.revokedAt === null;
}

/**
 * Why an admin request was refused.
 *
 * ⚠️ **These reasons are for logs and tests, never for responses.** The brief is explicit
 * that a refusal must not tell an ordinary user *which* check they failed — the difference
 * between "no grant" and "not on the list" is a map of the authorization system, and
 * handing it out turns one failed probe into reconnaissance. The route layer throws a flat
 * 403 with a fixed message; this type exists so our own tests can tell the two independent
 * halves apart and prove they are independently enforced.
 */
export type AdminRefusal =
  | "not_authenticated"
  | "no_grant"
  | "grant_revoked"
  | "not_allowlisted"
  | "not_first_batch"
  | "account_unavailable";
