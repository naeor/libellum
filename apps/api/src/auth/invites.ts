/**
 * Registration codes: creating them, and the two ways one stops working.
 *
 * Gathered here rather than left in the routes because three callers need the
 * same rules: the one-off generator, the batch generator, and registration
 * itself. The rules are the owner's (2026-10-10):
 *
 *  * an **ordinary** code lives **seven days** and can be **revoked**;
 *  * a code that **reserves an account number** does neither — it is meant to be
 *    written down and handed out over months, which is the whole reason it
 *    exists. The owner's first batch (10000002–10000099) is exactly this.
 *
 * That distinction is *not* a database constraint, because the database cannot
 * tell which counter a reserved number came from. It is a property of how the
 * code was made, so it is decided here and nowhere else.
 */
import { INVITE_VALID_MS } from "@libellum/shared";

import { generateInviteCode } from "./invite-code.js";
import { reserveAccountNumber } from "./recovery-code.js";

/** The slice of Prisma this module needs. */
export interface InviteClient {
  registrationInvite: {
    create(args: {
      data: {
        code: string;
        note?: string | null;
        accountNumber?: string | null;
        expiresAt?: Date | null;
        grantsAdmin?: boolean;
      };
    }): Promise<{
      id: string;
      code: string;
      accountNumber: string | null;
      expiresAt: Date | null;
      grantsAdmin: boolean;
    }>;
  };
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface CreatedInvite {
  readonly id: string;
  readonly code: string;
  readonly accountNumber: string | null;
  readonly expiresAt: Date | null;
  readonly grantsAdmin: boolean;
}

/**
 * Create an ordinary code: expires in seven days, revocable, **not** an
 * administrator.
 *
 * Use this for "somebody needs an account and I am sending them a code now".
 * `grantsAdmin` is false and that is a decision, not a default that fell out of
 * the shape — see `createAdminInvite` for why the two are separate.
 */
export async function createOrdinaryInvite(
  tx: InviteClient,
  note: string | null,
  now: Date = new Date(),
): Promise<CreatedInvite> {
  return tx.registrationInvite.create({
    data: {
      code: generateInviteCode(),
      note,
      accountNumber: null,
      expiresAt: new Date(now.getTime() + INVITE_VALID_MS),
      grantsAdmin: false,
    },
  });
}

/**
 * Create a code that reserves the account number it will grant **and** produces
 * an administrator.
 *
 * **No expiry, and that is the point of it.** The owner asked for a batch of
 * these to be written down and handed out slowly; a code that dies in a week
 * cannot be handed out at all. The reservation is what makes the batch possible —
 * the number is decided now, so it can be printed on the card.
 *
 * ⚠️ **This is the only way to create an administrator**, deliberately. It used
 * to be that *any* code reserving a number did it, which meant ordinary commands
 * minted administrators by accident. Now the privilege is asked for by name.
 */
export async function createAdminInvite(
  tx: InviteClient,
  note: string | null,
): Promise<CreatedInvite> {
  return tx.registrationInvite.create({
    data: {
      code: generateInviteCode(),
      note,
      accountNumber: await reserveAccountNumber(tx),
      expiresAt: null,
      grantsAdmin: true,
    },
  });
}

/**
 * Create a code that reserves a number **without** granting administration.
 *
 * The case the owner's correction made room for: the reserved number is a
 * convenience — it can be printed on a card and handed over months later — while
 * being an administrator is a separate thing somebody has to decide. A code can
 * have either, both, or neither.
 */
export async function createReservedInvite(
  tx: InviteClient,
  note: string | null,
): Promise<CreatedInvite> {
  return tx.registrationInvite.create({
    data: {
      code: generateInviteCode(),
      note,
      accountNumber: await reserveAccountNumber(tx),
      expiresAt: null,
      grantsAdmin: false,
    },
  });
}

/** Whether a code may be revoked at all. */
export function isRevocable(invite: { readonly accountNumber: string | null }): boolean {
  return invite.accountNumber === null;
}
