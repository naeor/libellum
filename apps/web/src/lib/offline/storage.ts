import type { SessionUser } from "@libellum/shared";

/**
 * The device's own copy of the ledger.
 *
 * **Why this exists at all.** The project owner's original intent was an offline
 * program where the server is mostly a backup — "它最开始本来就是被设计成离线软件的，
 * 服务器更多是数据备份". This is the layer that makes that true: everything the
 * server has sent is kept here, so the app can be opened, read and used with no
 * network at all.
 *
 * ⚠️ **One store, keyed by string, and that is deliberate.**
 *
 * The first design instinct is a table per entity — `transactions`, `categories`,
 * `books` — mirroring the database. It is the wrong shape for this job:
 *
 *  * **the server is the authority on the schema.** A local schema is a second
 *    definition of it, and the two drift the moment a column is added. The query
 *    cache is *a copy of responses*, so it needs a cache, not a model;
 *  * **a cache needs no queries.** Nothing here is ever asked "which entries are
 *    in October"; that question is answered in memory by the code that already
 *    knows how, over data this hands back whole.
 *
 * So the bottom layer is a key–value store, and everything above it is free to
 * decide what to put in it. The outbox — added in the next round — uses the same
 * store with its own key prefix.
 *
 * **A private browsing window, a blocked origin and a full disk all make
 * IndexedDB fail.** Every operation here reports failure rather than throwing:
 * the app then behaves exactly as it did before this file existed, which is a
 * usable app with no cache. A cache that breaks the program is worse than no
 * cache.
 */

/** The database name. Changing it abandons the old cache rather than migrating it. */
const DATABASE = "libellum";

/** The single object store. A key–value store needs one. */
const STORE = "kv";

/** The schema version. Bumping it triggers `onupgradeneeded`. */
const VERSION = 1;

/**
 * A short in-memory trace of what the storage layer did.
 *
 * ⚠️ **In memory, and synchronously written — both on purpose.**
 *
 * The owner asked for the diagnostics to be as rich as possible, and this is the layer that
 * needed them most: a read that returns nothing has half a dozen causes and one symptom. But
 * the obvious implementation — logging each read to IndexedDB — **is a read**, so it would
 * recurse, and it would do it once per entry per lookup.
 *
 * So the trace lives in an array and is flushed to the log in one go when somebody asks for a
 * report. Nothing is lost that matters: the sequence is what tells the story, and it is
 * preserved exactly.
 *
 * **What is recorded is deliberately short.** Reading the query cache produces one line, not a
 * hundred kilobytes of JSON — the point is to see *which* key was asked for and *what kind of
 * thing came back*, and a trace nobody can read is a trace nobody reads.
 */
export interface TraceLine {
  readonly at: number;
  readonly what: string;
  readonly key: string;
  readonly detail: string;
}

/** How many lines to keep. Enough for a full page load; bounded so a long session cannot grow. */
const MAX_TRACE = 120;

let traceLines: TraceLine[] = [];

function trace(what: string, key: string, detail: string): void {
  traceLines.push({ at: Date.now(), what, key, detail });

  if (traceLines.length > MAX_TRACE) traceLines = traceLines.slice(-MAX_TRACE);
}

/** The trace so far, oldest first. For the diagnostics screen. */
export function readTrace(): readonly TraceLine[] {
  return [...traceLines];
}

/** Forget it, so a reproduction can start clean. */
export function clearTrace(): void {
  traceLines = [];
}

/** One line of the trace as text. */
export function traceLine(line: TraceLine): string {
  return `${new Date(line.at).toISOString()} ${line.what} ${line.key} — ${line.detail}`;
}

let databasePromise: Promise<IDBDatabase> | null = null;

/** Whether this environment has IndexedDB at all. */
export function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise !== null) return databasePromise;

  trace("open", DATABASE, "开始打开");

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      trace("open", DATABASE, `升级到版本 ${String(VERSION)}`);

      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE);
      }
    };

    request.onsuccess = () => {
      const database = request.result;

      trace("open", DATABASE, "成功");

      /**
       * A second tab opening a newer version asks this one to close.
       *
       * Without this handler the other tab blocks forever on `onblocked` and the
       * user sees a page that never loads — with no error and nothing to click.
       */
      database.onversionchange = () => {
        trace("open", DATABASE, "另一个页面要求升级，已关闭连接");
        database.close();
        databasePromise = null;
      };

      resolve(database);
    };

    request.onerror = () => {
      const detail = request.error?.name ?? "unknown";

      trace("open", DATABASE, `失败：${detail}`);

      reject(request.error ?? new Error("indexeddb_open_failed"));
    };

    request.onblocked = () => {
      /**
       * ⚠️ **Blocked is traced separately from failed, because it means something different.**
       *
       * A blocked open is another tab holding an older version of the database — which on a
       * tablet is an easy state to be in, with the app open in two windows. It looks identical
       * to a broken database from the outside, and it resolves itself once the other tab
       * closes.
       */
      trace("open", DATABASE, "被阻塞：另一个页面占着旧版本");

      reject(new Error("indexeddb_blocked"));
    };
  });

  // A failed open must not be remembered as the permanent answer: the next call
  // should try again, since the usual causes (a full disk, another tab mid
  // upgrade) are temporary.
  databasePromise = databasePromise.catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });

  return databasePromise;
}

/**
 * Run `work` inside one transaction and resolve with its result.
 *
 * `readonly` is not a nicety: a read-only transaction can run several at once,
 * where a read-write one takes a lock over the store. Everything that only reads
 * passes `true`.
 */
async function withStore<T>(
  readonly: boolean,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();

  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE, readonly ? "readonly" : "readwrite");
    const request = work(transaction.objectStore(STORE));

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("indexeddb_request_failed"));
    };

    transaction.onabort = () => {
      reject(transaction.error ?? new Error("indexeddb_transaction_aborted"));
    };
  });
}

/**
 * Read one value.
 *
 * Returns `null` for both "not there" and "could not be read", because the caller
 * does the same thing either way: treat it as a miss.
 */
export async function readValue<T>(key: string): Promise<T | null> {
  if (!hasIndexedDb()) {
    trace("read", key, "没有 IndexedDB");

    return null;
  }

  try {
    const value = await withStore(true, (store) => store.get(key) as IDBRequest<T | undefined>);

    trace("read", key, value === undefined ? "键不存在" : summarize(value));

    return value === undefined ? null : value;
  } catch (error) {
    /**
     * ⚠️ **The failure is traced, and that is the reason this function has a `trace` at all.**
     *
     * An empty ledger offline has several causes and exactly one symptom, and **a read that
     * threw** is one of them: a private-browsing window, a blocked origin, a database being
     * upgraded in another tab. Swallowing the error is right for the caller — it has nothing
     * better to do — but swallowing it *silently* is what made this take three rounds to find.
     */
    trace(
      "read",
      key,
      `失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );

    return null;
  }
}

/**
 * What a stored value looks like, in one line.
 *
 * Strings are described rather than printed: the query cache is a hundred kilobytes of JSON,
 * and a diagnostic that dumps it is a diagnostic nobody can read. Length and a short prefix
 * are enough to tell "the wrong thing is stored" from "the right thing is stored".
 */
function summarize(value: unknown): string {
  if (typeof value === "string") {
    return `${String(value.length)} 字节字符串「${value.slice(0, 40)}…」`;
  }

  if (Array.isArray(value)) return `数组 ${String(value.length)} 项`;

  if (typeof value === "object" && value !== null) return `对象，键：${Object.keys(value).join(",")}`;

  return String(value);
}

/**
 * Write one value.
 *
 * Returns whether it worked rather than throwing. Callers that care — the outbox
 * will — can check; callers that do not, ignore it.
 */
export async function writeValue(key: string, value: unknown): Promise<boolean> {
  if (!hasIndexedDb()) {
    trace("write", key, "没有 IndexedDB，未写入");

    return false;
  }

  try {
    await withStore(false, (store) => store.put(value, key));

    trace("write", key, summarize(value));

    return true;
  } catch (error) {
    trace(
      "write",
      key,
      `失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );

    return false;
  }
}

/** Remove one value. */
export async function removeValue(key: string): Promise<boolean> {
  if (!hasIndexedDb()) return false;

  try {
    await withStore(false, (store) => store.delete(key));
    return true;
  } catch {
    return false;
  }
}

/** Every key currently stored. Used by the tests and by "clear the cache". */
export async function listKeys(): Promise<readonly string[]> {
  if (!hasIndexedDb()) return [];

  try {
    const keys = await withStore(false, (store) => store.getAllKeys() as IDBRequest<IDBValidKey[]>);

    return keys.map((key) => String(key));
  } catch {
    return [];
  }
}

/**
 * Everything, as a key–value map.
 *
 * The outbox answer to "what has not been sent yet" is one call, not a scan per
 * record — and a single pass over the store is also the only way to do it without
 * a transaction per key.
 */
export async function readAll<T>(): Promise<ReadonlyMap<string, T>> {
  const found = new Map<string, T>();
  if (!hasIndexedDb()) return found;

  try {
    const database = await openDatabase();

    const pairs = await new Promise<readonly (readonly [string, T])[]>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readonly");
      const store = transaction.objectStore(STORE);
      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();

      transaction.oncomplete = () => {
        const keys = keysRequest.result;
        const values = valuesRequest.result as T[];

        resolve(keys.map((key, index) => [String(key), values[index]!] as const));
      };

      transaction.onerror = () => {
        reject(transaction.error ?? new Error("indexeddb_read_failed"));
      };
    });

    for (const [key, value] of pairs) found.set(key, value);
  } catch {
    // Same reasoning as `readValue`: a miss and a failure are the same thing here.
  }

  return found;
}

/**
 * Delete the whole database.
 *
 * ⚠️ **Used on sign-out, and that is a privacy decision rather than bookkeeping.**
 * The cache holds somebody's spending history on a device that may be shared, and
 * leaving it behind after they log out means the next person to open the app can
 * read it — the offline feature must not become the reason that happens.
 */
export async function clearDatabase(): Promise<boolean> {
  if (!hasIndexedDb()) return false;

  try {
    /**
     * Close first. Deleting a database with an open connection raises
     * `onblocked` and waits forever; this is the one place where keeping a cached
     * promise would deadlock the operation.
     */
    databasePromise = null;

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DATABASE);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error ?? new Error("indexeddb_delete_failed"));
      };
      request.onblocked = () => {
        reject(new Error("indexeddb_delete_blocked"));
      };
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Who was signed in last, kept on the device.
 *
 * ⚠️ **This exists because "offline" and "signed out" were being treated as the
 * same thing**, and they are opposites. `GET /auth/me` fails offline, and the
 * handler that answered it set the user to `null` on *any* failure — so opening
 * the app without a network logged the user out, hid their cached ledger behind
 * the login screen, and left them unable to log back in because logging in also
 * needs a network.
 *
 * Storing this is **not** a security decision: it grants nothing. Every request
 * still carries the session cookie, and the server still decides. It only lets the
 * app show the interface the user already had, instead of a login screen they
 * cannot use.
 *
 * The stored type is whatever the *server* said a session user is, taken from the
 * shared schema rather than described again here. A hand-written copy of it would
 * be a second definition of the same shape, and it would be the one that goes
 * stale when a field is added.
 */
export type RememberedUser = SessionUser;
/** The key the remembered user occupies in the store. */
export const REMEMBERED_USER_KEY = "auth-user";

/** Keep the signed-in user, so a launch without a network can still show them. */
export async function rememberUser(user: RememberedUser): Promise<void> {
  await writeValue(REMEMBERED_USER_KEY, user);
}

/** Who was signed in, or `null` if nobody was or the store is unavailable. */
export async function readRememberedUser(): Promise<RememberedUser | null> {
  return readValue<RememberedUser>(REMEMBERED_USER_KEY);
}

/** Forget the user. Called on sign-out and on a 401. */
export async function forgetUser(): Promise<void> {
  await removeValue(REMEMBERED_USER_KEY);
}
