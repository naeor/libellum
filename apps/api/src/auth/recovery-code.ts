import { randomBytes } from "node:crypto";

/**
 * Recovery codes are rendered in Crockford base32: the alphabet omits I, L, O
 * and U, so a code cannot be misread when someone copies it off paper.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16;

/** 128 bits of randomness, printed as `XXXX-XXXX-XXXX-XXXX`. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let raw = "";

  for (let index = 0; index < CODE_LENGTH; index += 1) {
    raw += ALPHABET[bytes[index]! % ALPHABET.length];
  }

  return raw.replace(/(.{4})(?=.)/g, "$1-");
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
