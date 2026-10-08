import { hash, verify } from "@node-rs/argon2";

/**
 * argon2id with the parameters OWASP recommends for interactive logins
 * (19 MiB of memory, 2 iterations, 1 lane). Memory hardness is what makes
 * GPU cracking expensive, which is why bcrypt is no longer the first choice.
 *
 * `algorithm` is left at the library default, which is Argon2id. It is not
 * passed explicitly because the library declares it as an ambient const enum,
 * and this project compiles with `isolatedModules`.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS);
  } catch {
    // A malformed hash must read as "wrong password", never as a crash.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * A throwaway hash used when the account does not exist.
 *
 * Hashing is deliberately slow, so "unknown user" would otherwise answer much
 * faster than "wrong password" and leak which usernames are registered. Doing
 * the same work in both branches removes that signal.
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("libellum-timing-equaliser");
  return dummyHash;
}
