/**
 * Which ledger this device is looking at.
 *
 * ⚠️ **Why this exists as its own module rather than as a field on some screen's state.**
 *
 * Every request that touches ledger data has to name its ledger — that is the owner's rule, and
 * `api.ts` sends it as a header. A header cannot await, and it cannot be read out of a React
 * component either: **the offline queue delivers changes while nobody is looking at a screen.**
 * So the answer lives here, in memory, next to the value it feeds.
 *
 * ⚠️ **It is also remembered on the device**, because "which ledger was I in" has to survive a
 * reload while offline. Clearing storage or signing out clears it — see `forgetCurrentBook`.
 *
 * ⚠️ **Two sources of truth, and the separation is deliberate**:
 *
 * * the **server** keeps the owner's last ledger (`users.lastBookId`) so signing in on a new
 *   phone returns to it — that is what he asked for;
 * * the **device** keeps its own copy so it can answer immediately, without a round trip.
 *
 * Today only the device copy is wired up: the server side arrives with the ledger list. The
 * device copy is written first because every request needs it, including the very first one.
 */

import { readSnapshot, readValue, writeValue } from "./offline/storage.js";

const KEY = "current-book";

let current: string | null = null;
const listeners = new Set<() => void>();

/** The ledger id in use, or `null` when nothing has been chosen yet. */
export function currentBookId(): string | null {
  return current;
}

/**
 * Remember which ledger this device is in.
 *
 * ⚠️ **This module deliberately does not know about the request header.** `api.ts` keeps the
 * header value, and the two are joined at the entry point (`main.tsx`) instead of importing
 * each other — otherwise `queries.ts → currentBook → api → …` becomes a cycle, and a cycle in
 * module initialisation is the kind of bug that only shows up on somebody else's phone.
 *
 * ⚠️ **Notifies on every call, even when the value is unchanged**, because callers use it as
 * "the ledger is known now" rather than only as "the ledger changed" — and the request that
 * needs the header may be waiting on precisely that.
 */
export function setCurrentBook(id: string | null): void {
  current = id;
  void writeValue(KEY, id);
  for (const listener of listeners) listener();
}

/**
 * Read the remembered ledger back at startup.
 *
 * ⚠️ **The snapshot is consulted first and synchronously.** `storage.ts` keeps a synchronous
 * mirror of everything it has read or written in this session, so the startup path can often
 * answer before the asynchronous read resolves. When it cannot, the async read still fills it
 * in — and `useLedger` sets it again once the server answers.
 */
export async function restoreCurrentBook(): Promise<string | null> {
  const mirrored = readSnapshot<string | null>(KEY);
  if (typeof mirrored === "string" && mirrored !== "") applyRestored(mirrored);

  const stored = await readValue<string | null>(KEY);
  if (typeof stored === "string" && stored !== "") return applyRestored(stored);

  return current;
}

function applyRestored(id: string): string {
  if (current !== id) {
    current = id;
    for (const listener of listeners) listener();
  }

  return id;
}

/**
 * Forget it — on sign-out, and on "clear this app's local data".
 *
 * ⚠️ Signing out must forget it: the next account to sign in on this device is a different
 * person, and inheriting the previous one's ledger would point their requests at somebody
 * else's book. The server would refuse (permission comes from membership, not from a header),
 * but the client should not ask in the first place.
 */
export function forgetCurrentBook(): void {
  setCurrentBook(null);
}

/** Subscribe, for `useSyncExternalStore`. */
export function subscribeCurrentBook(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
