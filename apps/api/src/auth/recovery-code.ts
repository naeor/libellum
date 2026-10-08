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
const ACCOUNT_NUMBER_DIGITS = 8;
const ACCOUNT_NUMBER_RANGE = 90_000_000; // 8 digits, first digit 1-9
const ACCOUNT_NUMBER_MIN = 10_000_000;

/**
 * A purely numeric account number such as `48213907`.
 *
 * Numeric on purpose: it is meant to be read out loud, typed on a phone
 * keypad and remembered. Random rather than sequential, because a contiguous
 * series would let anyone enumerate accounts and count how many exist — and
 * this identifier is public, used to find people to share a ledger with.
 */
export function generateAccountNumber(): string {
  const bytes = randomBytes(4);
  const value = (bytes.readUInt32BE(0) % ACCOUNT_NUMBER_RANGE) + ACCOUNT_NUMBER_MIN;

  return String(value).padStart(ACCOUNT_NUMBER_DIGITS, "0");
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
