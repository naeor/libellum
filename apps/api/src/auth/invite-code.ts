/**
 * Generating invitation codes, without touching a database.
 *
 * Split out from the two scripts that use it — one code at a time, and a batch —
 * because a script that connects to PostgreSQL at import time cannot be tested,
 * and the code format is worth testing: it is read off paper and typed by hand.
 */
import { randomBytes } from "node:crypto";

/**
 * Crockford base32, the same alphabet recovery codes use: no I, L, O or U, so a
 * code cannot be misread when somebody copies it from a card.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

/** Twelve characters, printed as `XXXX-XXXX-XXXX`. */
export function generateInviteCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let raw = "";

  for (let index = 0; index < CODE_LENGTH; index += 1) {
    raw += ALPHABET[bytes[index]! % ALPHABET.length];
  }

  return raw.replace(/(.{4})(?=.)/g, "$1-");
}
