import { readSnapshot, readValue, writeValue } from "./storage.js";

/**
 * Where the scope itself is remembered.
 *
 * ⚠️ **The scope has to be readable synchronously at startup, not only after a round trip.**
 * The persisted query cache is read once, early, and its key now depends on the scope — so a
 * scope that was still empty at that moment would mean **reading the wrong account's copy, or
 * none at all**. `storage.ts` keeps a synchronous mirror of what it has restored, and this is
 * the value that most needs to be in it.
 */
const SCOPE_KEY = "offline-scope";

/**
 * Which account and which ledger the device's offline copy belongs to.
 *
 * ⚠️ **Both halves are needed, and the account half is not decoration.**
 *
 * The owner asked for the ledger half — *"ledger-months:<userId>:<bookId>"* — and gave the reason:
 * *"同一台设备上还可能切换不同账号。如果只有 bookId，缓存读取、退出登录和身份失效时仍可能
 * 出现数据暴露或混用风险."* He is right, and the failure is worse than a mix-up: without the
 * account in the key, **signing in as somebody else on the same phone would show them the
 * previous person's ledger**, straight out of IndexedDB, with no server involved to refuse it.
 *
 * ⚠️ **Permission is still the server's job; this is about not showing the wrong thing.** Every
 * record delivered from this storage was fetched for one account and one ledger, and reading it
 * back under a different pair would be presenting stale data as current.
 *
 * ⚠️ **The store is keyed by strings, so the scope is a string prefix and nothing more.** No
 * store may be created, no index may be built — the scope is simply part of the key, which is
 * what makes it possible to add without a storage-version migration.
 */
let scope = "";

/** The account id, kept separately because some things need it without the ledger. */
let account = "";

/** The ledger id, set by whoever learns it from the server. */
let ledger = "";

function recompute(): void {
  scope = account !== "" && ledger !== "" ? `${account}:${ledger}` : "";

  /**
   * ⚠️ **Remembered as it changes, so the next startup can read it synchronously.** Losing this
   * would not lose data — it would lose the *address* of the data, which amounts to the same
   * thing on a device that is offline when it starts.
   */
  void writeValue(SCOPE_KEY, { account, ledger });
}

/**
 * Read the remembered scope back, **synchronously**.
 *
 * ⚠️ **Synchronous is the whole point.** The persisted query cache is read once, early, and which
 * key it reads now depends on the scope. Awaiting an IndexedDB round trip before that would mean
 * either reading the wrong copy or reading none, so this consults the in-memory mirror that
 * `storage.ts` fills during its own startup restore.
 *
 * ⚠️ **Called from `main.tsx` before the first render**, and it is safe to call when nothing has
 * been stored yet: the scope then stays empty, and an unscoped key is read — which is exactly the
 * behaviour before scoping existed.
 */
export function restoreOfflineScopeSync(): void {
  const stored = readSnapshot<{ account?: string; ledger?: string } | null>(SCOPE_KEY);
  if (stored === null || typeof stored !== "object") return;

  account = typeof stored.account === "string" ? stored.account : "";
  ledger = typeof stored.ledger === "string" ? stored.ledger : "";
  scope = account !== "" && ledger !== "" ? `${account}:${ledger}` : "";
}

/**
 * Which account the device's copy belongs to.
 *
 * ⚠️ **Set from the auth layer, not read from React inside the data layer.** A query function that
 * called `useAuth` would make `lib/queries.ts` unusable outside `<AuthProvider>` — which is
 * exactly how two screens' tests broke when this was first written. The account is injected here
 * instead, so the data layer stays a data layer.
 */
export function setOfflineAccount(userId: string | null): void {
  account = userId ?? "";
  recompute();
}

/** Which ledger the device's copy belongs to, set once the server says which one it is. */
export function setOfflineBook(bookId: string | null): void {
  ledger = bookId ?? "";
  recompute();
}

/**
 * Set both at once, or clear them.
 *
 * ⚠️ **Either half missing means no scope at all.** A scope built from a ledger alone would look
 * valid and isolate nothing — the one outcome worse than no scope, because it would silently read
 * another account's copy.
 */
export function setOfflineScope(userId: string | null, bookId: string | null): void {
  account = userId ?? "";
  ledger = bookId ?? "";
  recompute();
}

export function clearOfflineScope(): void {
  setOfflineScope(null, null);
}

/** The current `userId:bookId`, or `""` before either half is known. */
export function offlineScope(): string {
  return scope;
}

/**
 * The key one scope's copy of `base` is stored under.
 *
 * ⚠️ **With no scope set, the base key is returned unchanged.** That is deliberate: it keeps the
 * pre-scope key reachable so the migration below can find it, and it means an un-scoped read
 * behaves exactly as it did before this existed rather than failing.
 */
export function scopedKey(base: string): string {
  return scope === "" ? base : `${base}:${scope}`;
}

/**
 * Move the pre-scope copies into the current scope, once.
 *
 * ⚠️ **Because the old keys were global, and the data under them is not.** Everything written
 * before scoping belonged to a single account and a single ledger — there was only ever one of
 * each — so it is moved to the scope that is now current. **Without this, somebody who had 60
 * months downloaded offline would open the app and find nothing**, which is what "the cache is
 * the user's only offline copy" means in practice.
 *
 * ⚠️ **The old key is copied, not deleted.** If this runs with the wrong scope — a device whose
 * first request happens before the account is known, say — the data is still there to be moved
 * again, and nothing has been destroyed. A "cleanup" that removes the fallback is a cleanup that
 * can lose the only copy.
 *
 * Idempotent: it does nothing when the target already exists, so it is safe on every startup.
 */
export async function migrateUnscopedKeys(bases: readonly string[]): Promise<number> {
  if (scope === "") return 0;

  let moved = 0;

  for (const base of bases) {
    const target = scopedKey(base);
    if (target === base) continue;

    try {
      if ((await readValue<unknown>(target)) !== null) continue;

      const legacy = await readValue<unknown>(base);
      if (legacy === null) continue;

      await writeValue(target, legacy);
      moved += 1;
    } catch {
      // A key that cannot be read is left alone; the old copy is still the fallback.
    }
  }

  return moved;
}
