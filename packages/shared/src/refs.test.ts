import { describe, expect, it } from "vitest";

import {
  EXPORT_REF_PREFIX,
  IMPORT_REF_PREFIX,
  REF_LENGTH,
  exportRefSchema,
  fileRefSchema,
  importRefSchema,
  isExportRef,
  isImportRef,
  isOurRef,
  newExportRef,
  newImportRef,
  refStamp,
} from "./refs.js";

/**
 * These tests are the contract with the database CHECK constraints. If the
 * shape changes here without changing there, rows stop being writable — so the
 * shape is pinned rather than assumed.
 */
describe("refStamp", () => {
  it("renders the date and time in UTC", () => {
    expect(refStamp(new Date("2026-10-10T15:30:12Z"))).toBe("20261010-153012");
  });

  it("pads every field, including a January morning", () => {
    expect(refStamp(new Date("2026-01-02T03:04:05Z"))).toBe("20260102-030405");
  });

  it("does not drift with the machine's time zone", () => {
    // Whatever the runner's zone, the same instant gives the same stamp.
    expect(refStamp(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe("20261231-235959");
  });
});

describe("newExportRef", () => {
  it("starts with the export prefix so the direction is readable", () => {
    expect(newExportRef().startsWith(EXPORT_REF_PREFIX)).toBe(true);
  });

  it("is exactly the length the column allows", () => {
    // "Out-" (4) + "YYYYMMDD" (8) + "-" (1) + "HHMMSS" (6) + "-" (1) + 4 hex = 24.
    const ref = newExportRef();
    expect(ref).toHaveLength(24);
    expect(ref).toHaveLength(REF_LENGTH);
    expect(REF_LENGTH).toBeLessThanOrEqual(32);
  });

  it("passes the schema the API validates with", () => {
    expect(exportRefSchema.safeParse(newExportRef()).success).toBe(true);
  });

  it("uses the stamp of the moment it is given", () => {
    expect(newExportRef(new Date("2026-10-10T15:30:12Z")).slice(4, 19)).toBe("20261010-153012");
  });

  it("does not repeat itself across many calls in the same second", () => {
    const at = new Date("2026-10-10T15:30:12Z");
    const refs = new Set(Array.from({ length: 500 }, () => newExportRef(at)));
    // Four hex digits is 65536 values; 500 draws colliding would mean the
    // suffix is not random at all.
    expect(refs.size).toBeGreaterThan(490);
  });
});

describe("newImportRef", () => {
  it("starts with the import prefix", () => {
    expect(newImportRef().startsWith(IMPORT_REF_PREFIX)).toBe(true);
  });

  it("is exactly the length the column allows", () => {
    // "In-" (3) + the same 20 characters as an export reference = 23.
    const ref = newImportRef();
    expect(ref).toHaveLength(23);
    expect(ref).toHaveLength(REF_LENGTH - 1);
  });

  it("passes the schema the API validates with", () => {
    expect(importRefSchema.safeParse(newImportRef()).success).toBe(true);
  });
});

describe("telling the three kinds of reference apart", () => {
  it("treats both of ours as ours", () => {
    expect(isOurRef(newExportRef())).toBe(true);
    expect(isOurRef(newImportRef())).toBe(true);
  });

  it("keeps the directions distinct", () => {
    const out = newExportRef();
    const into = newImportRef();

    expect(isExportRef(out)).toBe(true);
    expect(isImportRef(out)).toBe(false);

    expect(isImportRef(into)).toBe(true);
    expect(isExportRef(into)).toBe(false);
  });

  it("rejects a bare UUID — a value we did not mint says nothing about direction", () => {
    expect(isOurRef("018f3a5e-0000-7000-8000-000000000000")).toBe(false);
    expect(fileRefSchema.safeParse("018f3a5e-0000-7000-8000-000000000000").success).toBe(false);
  });

  it("rejects a reference with an unknown direction", () => {
    expect(isOurRef("Sideways-20261010-153012-a3f9")).toBe(false);
  });

  it("rejects a stamp that is the right length but not a date", () => {
    expect(isOurRef("Out-20261399-995959-a3f9")).toBe(false);
    expect(isOurRef("Out-20261010-15301-a3f9")).toBe(false);
  });

  it("rejects uppercase hex, because the constraint only allows lowercase", () => {
    expect(isOurRef("Out-20261010-153012-A3F9")).toBe(false);
  });
});
