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

/**
 * A short public identifier for an account, shown in the interface as 账号编号.
 *
 * Deliberately looks nothing like a recovery code: it is safe to read aloud or
 * paste into a message, whereas a recovery code must stay secret.
 */
export function generateAccountNumber(): string {
  const raw = randomCrockford(8);

  return `LB-${raw.slice(0, 4)}-${raw.slice(4)}`;
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
