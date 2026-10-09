-- Default currency per account.
--
-- Additive and safe: existing rows take the default, and the default is what
-- every account effectively assumed until now.

ALTER TABLE "users"
  ADD COLUMN "default_currency" VARCHAR(3) NOT NULL DEFAULT 'CNY';
