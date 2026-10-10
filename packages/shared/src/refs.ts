import { z } from "zod";

/**
 * Traceable references for anything that crosses the ledger's boundary.
 *
 * Every file that leaves carries an `Out-…` reference, and every import run
 * mints an `In-…` one. The two prefixes are what make a row answerable: the
 * owner's requirement was that data be *traceable*, and a bare UUID is not
 * traceable — it says nothing about which direction the data travelled.
 *
 *     Out-20261010-153012-a3f9
 *     │   │        │      └─ four random hex digits: two runs inside the same
 *     │   │        │         second cannot collide
 *     │   │        └─ HHMMSS, UTC
 *     │   └─ YYYYMMDD, UTC
 *     └─ direction: Out = left this book, In = arrived in it
 *
 * Two deliberate choices:
 *
 *  * **UTC, not local time.** The stamp is not the authoritative time — the
 *    `created_at` column is, and the interface shows that, not this. Using UTC
 *    makes the reference identical no matter where the server runs, which
 *    matters because the same reference is stored in a file the user keeps for
 *    years.
 *  * **Opaque but readable.** It sorts chronologically as text, it can be read
 *    aloud, and its length is fixed by direction — 24 characters for `Out-`,
 *    23 for `In-`, both well inside the 32 the column allows. The database
 *    enforces the shape with a CHECK constraint, so a reference that cannot be
 *    traced cannot be written in the first place.
 */

/**
 * `YYYYMMDD-HHMMSS` plus four random hex digits.
 *
 * The ranges are deliberate: `[0-1][0-9]` for the month and `[0-3][0-9]` for
 * the day do not try to be a calendar (the 31st of February passes), they stop
 * a typo turning into something that reads as a plausible date. Anything
 * stronger belongs in code that can actually reason about months, and by then
 * the reference has already been minted by `newExportRef`/`newImportRef`.
 */
const STAMP = "[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])-([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]-[0-9a-f]{4}";

export const EXPORT_REF_PREFIX = "Out-";
export const IMPORT_REF_PREFIX = "In-";

/** `fileRef` is VARCHAR(32) in the database; this is the whole of it. */
export const REF_PATTERN = `^(Out|In)-${STAMP}$`;

/**
 * The date and time halves in UTC, as a plain string, for the case where the
 * server is the only thing that knows the pattern.
 *
 * Exported because the database CHECK constraints quote the same expression:
 * `prisma/migrations/20261010124000_tighten_reference_shape/migration.sql` holds
 * the literal. If one changes and the other does not, writes start failing, so
 * they are kept next to each other on purpose.
 */
export const REF_STAMP_SQL = STAMP;
/** `Out-…` is 24 characters; `In-…` is one shorter. Pinned by the tests. */
export const REF_LENGTH = 24;

export const exportRefSchema = z.string().regex(new RegExp(`^Out-${STAMP}$`), "导出编号格式不正确");
export const importRefSchema = z.string().regex(new RegExp(`^In-${STAMP}$`), "导入编号格式不正确");
export const fileRefSchema = z.union([exportRefSchema, importRefSchema]);

export type ExportRef = z.infer<typeof exportRefSchema>;
export type ImportRef = z.infer<typeof importRefSchema>;
export type FileRef = z.infer<typeof fileRefSchema>;

/** True when this reference was minted by us rather than carried in from outside. */
export function isOurRef(value: string): value is FileRef {
  return new RegExp(REF_PATTERN).test(value);
}

/** True when the reference is one of our exports — i.e. a file coming home. */
export function isExportRef(value: string): value is ExportRef {
  return exportRefSchema.safeParse(value).success;
}

/** True when the reference is one of our import runs. */
export function isImportRef(value: string): value is ImportRef {
  return importRefSchema.safeParse(value).success;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * The `YYYYMMDD-HHMMSS` half, always in UTC.
 *
 * Exported for tests: the format is a contract with the database CHECK
 * constraint, so it is worth pinning down rather than trusting.
 */
export function refStamp(at: Date): string {
  return (
    `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}` +
    `-${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}`
  );
}

/**
 * Four random hex digits.
 *
 * `globalThis.crypto` exists in both Node 22+ and every browser this app
 * targets, so one implementation serves the API and the client.
 */
function randomSuffix(): string {
  const bytes = new Uint8Array(2);
  globalThis.crypto.getRandomValues(bytes);
  return ((bytes[0] ?? 0) * 256 + (bytes[1] ?? 0)).toString(16).padStart(4, "0");
}

export function newExportRef(at: Date = new Date()): ExportRef {
  return `${EXPORT_REF_PREFIX}${refStamp(at)}-${randomSuffix()}` as ExportRef;
}

export function newImportRef(at: Date = new Date()): ImportRef {
  return `${IMPORT_REF_PREFIX}${refStamp(at)}-${randomSuffix()}` as ImportRef;
}
