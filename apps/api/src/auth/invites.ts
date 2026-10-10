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
      };
    }): Promise<{ id: string; code: string; accountNumber: string | null; expiresAt: Date | null }>;
  };
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface CreatedInvite {
  readonly id: string;
  readonly code: string;
  readonly accountNumber: string | null;
  readonly expiresAt: Date | null;
}

/**
 * Create an ordinary code: expires in seven days, revocable.
 *
 * Use this for "somebody needs an account and I am sending them a code now".
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
    },
  });
}

/**
 * Create a code that reserves the account number it will grant.
 *
 * **No expiry, and that is the point of it.** The owner asked for a batch of
 * these to be written down and handed out slowly; a code that dies in a week
 * cannot be handed out at all. The reservation is what makes the batch possible —
 * the number is decided now, so it can be printed on the card.
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
    },
  });
}

/** Whether a code may be revoked at all. */
export function isRevocable(invite: { readonly accountNumber: string | null }): boolean {
  return invite.accountNumber === null;
}
