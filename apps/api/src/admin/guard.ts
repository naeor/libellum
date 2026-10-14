/**
 * **The one place that decides whether the caller may administer the platform.**
 *
 * Every future admin operation must come through here. The reason is this project's own
 * most-repeated lesson: *"a second, subtly different copy of an authorization rule is how
 * holes appear"* (see `auth/guard.ts`). Admin checks are exactly the kind of rule that gets
 * copied, because the first version is three lines and the second one is written by
 * somebody who has not read the first.
 *
 * ## The two checks, and why they are not one check written twice
 *
 * A request is authorized only when **all** of these hold:
 *
 *   1. **a valid session** — from `requireAuth`, which reads the cookie and hits the
 *      `sessions` table. Nothing about the caller is believed from the request.
 *   2. **an active authorization** — an `admin_grants` row that exists and is not revoked.
 *   3. **membership of the allow list** — an `admin_allowlist` row that exists and is not
 *      revoked. **A different table**, and that word is doing real work — see below.
 *   4. **first-batch qualification** — the account number is inside `10000000`–`10000099`.
 *   5. **an available account** — not a demo account, which is a shared read-only login.
 *
 * ⚠️ **Checks 2 and 3 are two tables, and this is the correction that 1.10.23 exists to
 * make.**
 *
 * The first version of this guard had both halves reading `admin_grants`: check 2 asked "is
 * there a live grant?", and check 3 asked "is there a live grant *and* is the number
 * first-batch?". Two functions, two call sites, two kill switches — and **one source of
 * truth**, so a single grant satisfied both and the checks could never disagree. The owner
 * found it:
 *
 * > *"授权记录和允许名单并没有完全分离……如果未来误将另一个合格账号加入 `admin_grants`，
 * > 在默认的 first-batch 范围下，它可能同时通过所谓的两重检查。"*
 *
 * **Two questions, stored twice, revocable separately:**
 *
 * | | check 2 — `admin_grants` | check 3 — `admin_allowlist` |
 * |---|---|---|
 * | Question | *"has this account been granted the role?"* | *"is this account one of the accounts administration may currently run as?"* |
 * | Written by | `pnpm admin:grant` | `pnpm admin:allow` |
 * | Removed by | `pnpm admin:revoke` | `pnpm admin:disallow` |
 *
 * Neither command writes the other table, so an operator has to mean both. **Both can be
 * present alone, and either alone is a refusal.**
 *
 * ⚠️ **Do not "simplify" check 3 back into a query on `admin_grants`.** It would pass every
 * test in the suite except one — *"an eligible account with a live grant but no listing is
 * refused"* — which is the test that was added specifically to make this mistake fail loudly.
 *
 * The **separate kill switches** (`ADMIN_GRANT_CHECK_DISABLED`, `ADMIN_ALLOWLIST_CHECK_DISABLED`)
 * exist so a test can take either half away and watch the same request fail. Disabling either
 * must deny everything — a missing check is not a passed check.
 *
 * ## Nothing is cached
 *
 * Every request re-reads both tables. This is the brief's requirement (*"避免使用长期缓存
 * 的管理员权限结果"*) and it is also the honest reading of what revocation means: **a cached
 * admin decision is an administrator who cannot be fired.** The cost is two indexed
 * lookups on a route that runs rarely; the alternative is a revocation that takes effect at
 * some later, unspecified time.
 *
 * ## What this does *not* do
 *
 * ⚠️ **It does not grant access to anybody's ledger.** Ledger permission comes from
 * `book_members` and from nothing else — `ledger/access.ts` owns that, and being an
 * administrator is not a way around it (test 13 asserts exactly this). Administration is
 * the ability to perform *platform* operations, and each of those still has to define its
 * own scope and its own audit. See `docs/管理员与权限边界-设计决定.md` §6.
 */
import type { FastifyRequest } from "fastify";

import type { PrismaClient } from "../db.js";
import { forbidden } from "../lib/errors.js";
import { isFirstBatchAccountNumber, isGrantActive, type AdminRefusal } from "./rules.js";

/** An actor that passed every check. */
export interface AdminActor {
  /** The account's database primary key — the only identity administration is keyed on. */
  readonly userId: string;
  readonly username: string;
  readonly accountNumber: string;
}

export type AdminDecision =
  | { readonly ok: true; readonly actor: AdminActor }
  | { readonly ok: false; readonly reason: AdminRefusal };

/** The slice of Prisma the guard needs. Keeps it testable without a database. */
export interface AdminGuardClient {
  adminGrant: {
    findUnique(args: {
      where: { userId: string };
    }): Promise<{ userId: string; revokedAt: Date | null } | null>;
  };
  /**
   * ⚠️ **A second relation on a second table, not a second condition on the first.**
   * See the note on `isOnAdminAllowList`.
   */
  adminAllowEntry: {
    findUnique(args: {
      where: { userId: string };
    }): Promise<{ userId: string; revokedAt: Date | null } | null>;
  };
  user: {
    findUnique(args: {
      where: { id: string };
      select: {
        id: true;
        username: true;
        accountNumber: true;
        isDemo: true;
      };
    }): Promise<{
      id: string;
      username: string;
      accountNumber: string;
      isDemo: boolean;
    } | null>;
  };
}

/** Whether an authoritative check has been switched off by the environment. */
function disabled(name: string): boolean {
  return process.env[name] === "1";
}

/**
 * **Check 2 — the authorization half.** Reads `admin_grants`.
 *
 * Answers "has this account been granted administration, and is that grant still live".
 * It knows nothing about the allow list, the account number or the session; that is what
 * makes it half of a pair rather than the whole decision.
 */
export async function hasActiveAdminGrant(
  prisma: AdminGuardClient,
  userId: string,
): Promise<boolean> {
  // A disabled check denies; it does not pass. See the note at the top.
  if (disabled("ADMIN_GRANT_CHECK_DISABLED")) return false;

  const grant = await prisma.adminGrant.findUnique({ where: { userId } });

  return isGrantActive(grant);
}

/**
 * **Check 3 — the allow-list half.** A separate read, and a separate switch.
 *
 * ⚠️ **This half reads `admin_allowlist`, a different table, and it must never be derived
 * from `admin_grants` again.**
 *
 * The first version of this function did derive it: it answered *"is this account granted
 * **and** first-batch?"* — which reads like a pair of conditions and behaves like one. A
 * grant alone then satisfied both halves, so the two checks could never disagree, and the
 * reason for asking twice was gone. The owner caught it:
 *
 * > *"授权记录和允许名单并没有完全分离……如果未来误将另一个合格账号加入 `admin_grants`，
 * > 在默认的 first-batch 范围下，它可能同时通过所谓的两重检查。"*
 *
 * So the two halves are now **two facts stored twice**:
 *
 * | | `admin_grants` (check 2) | `admin_allowlist` (this check) |
 * |---|---|---|
 * | Question | *"has this account been granted the role?"* | *"is this account one of the accounts administration may run as?"* |
 * | Written by | `pnpm admin:grant` | `pnpm admin:allow` |
 * | Removed by | `pnpm admin:revoke` | `pnpm admin:disallow` |
 *
 * **Neither command writes the other table**, so an operator has to mean both — and the
 * regression test that pins it is *"an eligible account with a live grant but no listing is
 * refused"*. A guard that derived the list would pass every other test in the suite and fail
 * only that one.
 *
 * ⚠️ **The list starts empty and only named UUIDs are on it.** *"默认不应信任所有前 100 个
 * 账号，只信任明确列入允许名单的账号"* — the first hundred are a *qualification*, checked
 * separately; being inside that range does not put an account on this list.
 *
 * ⚠️ **Nothing about the list is cached**, so `pnpm admin:disallow` takes effect on the next
 * request rather than at some later, unspecified time. A cached allow list is an account
 * that cannot be taken off it.
 */
export async function isOnAdminAllowList(
  prisma: AdminGuardClient,
  userId: string,
): Promise<boolean> {
  // A disabled check denies; it does not pass. See the note at the top.
  if (disabled("ADMIN_ALLOWLIST_CHECK_DISABLED")) return false;

  const entry = await prisma.adminAllowEntry.findUnique({ where: { userId } });

  /**
   * ⚠️ **A missing row is a refusal, never an exception and never a pass.** This is the
   * "configured nothing" case, and it is the *default* state of a fresh deployment — a
   * guard that treated an empty list as "no restriction" would make the second check
   * vanish exactly when the system is least understood.
   */
  return isGrantActive(entry);
}

/**
 * Run every check and report the decision.
 *
 * ⚠️ **`authenticatedUserId` is passed in rather than read from the request here.** The
 * identity must come from the session the auth guard already verified; accepting it as a
 * parameter makes that dependency visible in the signature, and makes it impossible to
 * write a caller that accidentally trusts a header. There is deliberately **no** overload
 * that reads a request body, a query parameter or a header.
 */
export async function decideAdmin(
  prisma: AdminGuardClient,
  authenticatedUserId: string,
): Promise<AdminDecision> {
  /**
   * ⚠️ **Check 2 and check 3 read two different tables, and neither implies the other.**
   * They were once both served by `admin_grants` — one derivation, reported as two checks —
   * and that is exactly what this shape replaced. See `isOnAdminAllowList`.
   *
   * The kill switches (`ADMIN_GRANT_CHECK_DISABLED` × `ADMIN_ALLOWLIST_CHECK_DISABLED`) exist
   * so a test can remove either half and watch the same request fail: **a missing check is a
   * refusal, not a pass.**
   *
   * ⚠️ **The order below is deliberate, and it is about which refusal gets reported.**
   *
   * A gate that always reported "not on the list" for an account that is *also* ineligible
   * would hide the more specific reason, and — worse — a future reader could conclude the
   * qualification rule was unreachable and delete it. So the account-level facts (does it
   * exist, is it a demo, is its number first-batch) are settled **first**, and the two
   * independent checks follow. Nothing about ordering leaks anything: the reasons never reach
   * the caller (see `createRequireAdmin`), and all four lookups are single indexed reads.
   */

  /* Check 5 — the account has to exist and be usable. */
  const user = await prisma.user.findUnique({
    where: { id: authenticatedUserId },
    select: { id: true, username: true, accountNumber: true, isDemo: true },
  });

  if (user === null) return { ok: false, reason: "account_unavailable" };

  /**
   * ⚠️ **A demo account can never administer, whatever its number.** Demo accounts are
   * shared, read-only logins for showing the product to strangers — the credential is
   * public by design, so treating one as an administrator would be publishing the
   * privilege. There are none in the database today; this is the rule that keeps the
   * future honest.
   */
  if (user.isDemo) return { ok: false, reason: "account_unavailable" };

  /* Check 4 — first-batch qualification. A gate, never a grant. */
  if (!isFirstBatchAccountNumber(user.accountNumber)) {
    return { ok: false, reason: "not_first_batch" };
  }

  /* Check 2 — authorization. Table: `admin_grants`. */
  if (!(await hasActiveAdminGrant(prisma, authenticatedUserId))) {
    return { ok: false, reason: "no_grant" };
  }

  /* Check 3 — the allow list. Table: `admin_allowlist`. */
  if (!(await isOnAdminAllowList(prisma, authenticatedUserId))) {
    return { ok: false, reason: "not_allowlisted" };
  }

  return {
    ok: true,
    actor: {
      userId: user.id,
      username: user.username,
      accountNumber: user.accountNumber,
    },
  };
}

/**
 * Build the Fastify pre-handler for admin routes.
 *
 * ⚠️ **Every refusal is the same 403 with the same body.** The brief requires that an
 * ordinary user learns nothing about the allow list, the internal UUIDs or the shape of
 * the rules; a response that distinguished "no grant" from "not on the list" would answer
 * the question *"am I close?"*, which is the question an attacker is asking. The real
 * reason is returned by `decideAdmin` and is available to tests and to a server-side log —
 * just never to the caller.
 *
 * ⚠️ **`requireAuth` runs first and separately**, so an unauthenticated request is a 401
 * (*"who are you"*) and an authenticated but unauthorized one is a 403 (*"not you"*).
 * Collapsing them would be a small lie that makes login bugs look like permission bugs.
 */
export function createRequireAdmin(
  prisma: PrismaClient,
  requireAuth: (request: FastifyRequest) => Promise<void>,
): (request: FastifyRequest) => Promise<void> {
  return async function requireAdmin(request: FastifyRequest): Promise<void> {
    await requireAuth(request);

    const userId = request.currentUser?.id;
    if (userId === undefined) {
      // `requireAuth` sets this or throws; reaching here means the two disagreed.
      throw forbidden("admin_forbidden", "没有权限执行这个操作。");
    }

    const decision = await decideAdmin(prisma, userId);

    if (!decision.ok) {
      throw forbidden("admin_forbidden", "没有权限执行这个操作。");
    }

    request.adminActor = decision.actor;
  };
}
