-- The reference shapes, tightened.
--
-- The previous migration accepted any eight digits as a date, so
-- `Out-20261399-995959-a3f9` was a valid reference: not a real date, but
-- writable, and therefore a row that looks traceable and is not. A regression
-- test in `packages/shared/src/refs.test.ts` caught it.
--
-- The ranges below do not try to be a calendar — the 31st of February still
-- passes — they stop a value that reads as a plausible date without being one.
-- Both prefixes are constrained to the same shape, since a reference is
-- traceable only if it is always exactly this.
--
-- Both tables are empty (export and import do not exist yet), so tightening the
-- constraints cannot reject data that is already there.

ALTER TABLE "transactions" DROP CONSTRAINT "transactions_import_ref_format";
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_ref_format"
  CHECK ("import_ref" IS NULL
         OR "import_ref" ~ '^In-[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])-([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]-[0-9a-f]{4}$');

ALTER TABLE "export_logs" DROP CONSTRAINT "export_logs_file_ref_format";
ALTER TABLE "export_logs" ADD CONSTRAINT "export_logs_file_ref_format"
  CHECK ("file_ref" ~ '^Out-[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])-([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]-[0-9a-f]{4}$');

ALTER TABLE "import_logs" DROP CONSTRAINT "import_logs_file_ref_format";
ALTER TABLE "import_logs" ADD CONSTRAINT "import_logs_file_ref_format"
  CHECK ("file_ref" ~ '^In-[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])-([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]-[0-9a-f]{4}$');

ALTER TABLE "import_logs" DROP CONSTRAINT "import_logs_exported_ref_format";
ALTER TABLE "import_logs" ADD CONSTRAINT "import_logs_exported_ref_format"
  CHECK ("exported_file_ref" IS NULL
         OR "exported_file_ref" ~ '^Out-[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])-([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]-[0-9a-f]{4}$');
