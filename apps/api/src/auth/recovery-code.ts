import { randomBytes } from "node:crypto";

/**
 * Recovery codes are rendered in Crockford base32: the alphabet omits I, L, O
 * and U, so a code cannot be misread when someone copies it off paper.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16;

/** `length` characters of Crockford base32 randomness. */
export function randomCrockford(length: number): string {
  const bytes = randomBytes(length);
  let raw = "";

  for (let index = 0; index < length; index += 1) {
    raw += ALPHABET[bytes[index]! % ALPHABET.length];
  }

  return raw;
}

/** 128 bits of randomness, printed as `XXXX-XXXX-XXXX-XXXX`. */
export function generateRecoveryCode(): string {
  return randomCrockford(CODE_LENGTH).replace(/(.{4})(?=.)/g, "$1-");
}

/** Digits in an account number. */
export const ACCOUNT_NUMBER_DIGITS = 8;

/**
 * Where the account series begins.
 *
 * The owner reserved this block for the first batch of invite codes, then asked
 * for everything after it to continue upwards. See the
 * `sequential_account_numbers` migration.
 */
export const ACCOUNT_NUMBER_FIRST = 10_000_000;

/** The first number that signup may allocate for itself, below the reserved block. */
export const ACCOUNT_NUMBER_COUNTER_START = 10_000_101;

/**
 * ⚠️ **Account numbers are no longer random — see the schema's note.**
 *
 * `generateAccountNumber` used to produce a random eight-digit number, and the
 * reasoning was sound: this identifier is public and people search by it, so a
 * contiguous series would let anyone enumerate accounts and count how many
 * exist.
 *
 * The owner replaced that on 2026-10-10, for a reason the randomness could not
 * satisfy: he wanted to write down a batch of invitation codes with the numbers
 * they would grant, months before anyone used them. A number that is decided at
 * registration cannot be written on the card.
 *
 * The cost is real and is recorded rather than hidden: **a sequential number can
 * be guessed from its neighbour.** What protects the directory now is the rate
 * limit on search, not the number's own unpredictability.
 */
export function formatAccountNumber(value: number): string {
  return String(value).padStart(ACCOUNT_NUMBER_DIGITS, "0");
}

/**
 * The counter codes draw on: each reserved number belongs to one code.
 */
const RESERVED_COUNTER = "account_number";

/**
 * The counter a signup draws from when its invite reserved no number.
 *
 * Deliberately a *different* counter from the one codes draw on. One counter
 * could not serve both: generating a batch of codes would push it past the
 * reserved block, and the next account without a code would then be allocated
 * inside a block the owner is still handing out.
 */
const DIRECT_COUNTER = "account_number_direct";

/** The slice of Prisma this module needs, so it can be tested without a database. */
export interface CounterClient {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * Raw account numbers, in order. Used by signup directly, and by the invite
 * generator to reserve a number for a code.
 */
export async function takeNextRawAccountNumber(
  tx: CounterClient,
  name: string,
): Promise<number> {
  /**
   * One statement, so two callers cannot read the same value.
   *
   * The owner asked for a proposal-and-adjudicate scheme — the client suggests a
   * number, the server compares it, breaks ties by arrival time and falls back
   * to something random if that fails. The intent is exactly right: **two
   * simultaneous signups must never share a number.** An atomic increment gives
   * that intent without the retry loop, the tie-break or the fallback, and the
   * unique index on `users.account_number` is the backstop if anything ever
   * bypasses this path.
   *
   * `RETURNING "next" - 1` hands back the value that was current before the
   * increment, so the row always holds *the next one to give out*.
   */
  const rows = await tx.$queryRaw<{ taken: number }[]>`
    UPDATE "counters"
       SET "next" = "next" + 1
     WHERE "name" = ${name}
    RETURNING "next" - 1 AS "taken"
  `;

  const taken = rows[0]?.taken;
  if (taken === undefined) {
    throw new Error(`the ${name} counter is missing`);
  }

  return taken;
}

/** The number given to an account at signup, when no code reserved one. */
export async function takeNextAccountNumber(tx: CounterClient): Promise<string> {
  return formatAccountNumber(await takeNextRawAccountNumber(tx, DIRECT_COUNTER));
}

/**
 * Reserve the next number for an invitation code, at the moment the code is
 * made. This is what lets a batch be written down before anyone uses it.
 */
export async function reserveAccountNumber(tx: CounterClient): Promise<string> {
  return formatAccountNumber(await takeNextRawAccountNumber(tx, RESERVED_COUNTER));
}

/**
 * Accept a code however the user typed it: lowercase, with or without dashes,
 * and with the letters Crockford treats as digits.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}
