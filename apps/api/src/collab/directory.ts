import type { PrismaClient } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";

/**
 * Finding somebody, so they can be invited into a ledger.
 *
 * ⚠️ **This is the one place that answers a question about another account, and it is deliberately
 * the narrowest question possible**: it takes **one whole identifier** — an 8-digit account number,
 * or an exact username — and returns exactly one match or none. What it reveals is what somebody
 * needs in order to recognise who they are about to invite: the display name, the username, and the
 * number.
 *
 * ⚠️ **⚠️ Prefix search is refused for both, and that is the whole security property.**
 * Account numbers are allocated in sequence, so a prefix search would let anybody **enumerate the
 * user base one keystroke at a time**; the same is true of a name. Requiring the whole value turns
 * that back into guessing one specific person's identifier — the risk the owner already accepted
 * when he chose sequential numbers — and `requireAuth`, the rate limiter, and this endpoint's own
 * tighter limit are what keep the guessing slow.
 *
 * ⚠️ **Nothing else may ever be searchable here** (no email, no display-name substring): a display
 * name is not unique, so searching by it turns "find your friend" into "list everybody".
 */
export interface FoundAccount {
  readonly id: string;
  readonly displayName: string;
  readonly username: string;
  readonly accountNumber: string;
}

/**
 * ⚠️ **The identifier is validated by shape before it is looked up.** A malformed value is a `400`
 * and not an empty result, because *"no such user"* and *"you typed six digits"* are different
 * answers and the screen says different things for each.
 *
 * ⚠️ **⚠️ Looking yourself up is refused rather than returned flagged.** Somebody searching their
 * own identifier is either confused or testing, and either way the useful answer is to say so
 * plainly — the alternative is a card offering to invite yourself into your own ledger.
 */
export async function findByAccountNumber(
  prisma: PrismaClient,
  searcherId: string,
  raw: string,
): Promise<FoundAccount> {
  const accountNumber = raw.trim();

  if (!/^[0-9]{8}$/.test(accountNumber)) {
    throw badRequest("account_number_shape", "账号编号是 8 位数字。");
  }

  const found = await prisma.user.findUnique({
    where: { accountNumber },
    select: { id: true, displayName: true, username: true, accountNumber: true },
  });

  return finish(found, searcherId);
}

/**
 * The same question, asked with a username instead of a number.
 *
 * ⚠️ **Exact match only.** `findUnique` on a unique column, not `contains` / `startsWith` — see the
 * file header for why a partial match on a name is an enumeration primitive.
 *
 * ⚠️ **Usernames are stored as typed and are unique**, so this needs no normalisation and cannot
 * match two accounts. (Postgres is case-sensitive here; two accounts could differ only in case.
 * That is pre-existing and true of login as well, so changing it here alone would make the two
 * disagree about who a string refers to.)
 */
export async function findByUsername(
  prisma: PrismaClient,
  searcherId: string,
  raw: string,
): Promise<FoundAccount> {
  const username = raw.trim();

  if (username === "") {
    throw badRequest("username_shape", "请输入完整的用户名。");
  }

  const found = await prisma.user.findUnique({
    where: { username },
    select: { id: true, displayName: true, username: true, accountNumber: true },
  });

  return finish(found, searcherId);
}

function finish(
  found: { id: string; displayName: string; username: string; accountNumber: string } | null,
  searcherId: string,
): FoundAccount {
  if (!found) {
    throw notFound("account_not_found", "没有找到这个账号。");
  }

  if (found.id === searcherId) {
    throw badRequest("account_is_self", "这是你自己的账号。");
  }

  return {
    id: found.id,
    displayName: found.displayName,
    username: found.username,
    accountNumber: found.accountNumber,
  };
}
