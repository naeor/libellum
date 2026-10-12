import type { PrismaClient } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";

/**
 * Finding somebody by their account number, so a request can be sent to them.
 *
 * ⚠️ **This is the one endpoint that answers a question about another account, and it is
 * deliberately the narrowest one possible**: it takes a *whole eight-digit number*, returns
 * exactly one match or none, and reveals only what somebody needs in order to recognise who they
 * are about to invite — the display name, the username, and the number they already typed.
 *
 * ⚠️ **Why a whole number and not a prefix.** Numbers are allocated in sequence, so a prefix
 * search would let anybody **enumerate the user base** one keystroke at a time. The full-number
 * requirement turns that into guessing a specific person's number, which is the risk the owner
 * already accepted when he chose sequential numbers — and `requireAuth` plus the rate limiter are
 * what keep the guessing slow. **Nothing else may ever be searchable here** (no display names, no
 * usernames): a name is not unique, and searching by it turns "find your friend" into "list
 * everybody".
 */

export interface FoundAccount {
  readonly id: string;
  readonly displayName: string;
  readonly username: string;
  readonly accountNumber: string;
  /** True when this account is already one of mine — the screen then says so instead of offering. */
  readonly isCollaborator: boolean;
  /** True when I already have a request waiting for them, so it is not sent twice. */
  readonly hasPendingRequest: boolean;
}

/**
 * ⚠️ **The number is validated by shape before it is looked up.** A malformed value is a 400 and
 * not an empty result, because "no such user" and "you typed six digits" are different answers and
 * the screen says different things for each.
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

  if (!found || found.accountNumber === null) {
    throw notFound("account_not_found", "没有找到这个编号对应的账号。");
  }

  /**
   * ⚠️ **Looking yourself up is refused rather than returned flagged.** Somebody searching their
   * own number is either confused or testing, and either way the useful answer is to say so
   * plainly — the alternative is a card offering to invite yourself.
   */
  if (found.id === searcherId) {
    throw badRequest("account_is_self", "这是你自己的账号编号。");
  }

  const [orderedA, orderedB] =
    searcherId < found.id ? [searcherId, found.id] : [found.id, searcherId];

  const [relationship, pending] = await Promise.all([
    prisma.collaborator.findUnique({
      where: { userA_userB: { userA: orderedA, userB: orderedB } },
      select: { userA: true },
    }),
    prisma.notification.findFirst({
      where: {
        senderId: searcherId,
        recipientId: found.id,
        kind: "collaborator_request",
        status: "pending",
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    }),
  ]);

  return {
    id: found.id,
    displayName: found.displayName,
    username: found.username,
    accountNumber: found.accountNumber,
    isCollaborator: relationship !== null,
    hasPendingRequest: pending !== null,
  };
}
