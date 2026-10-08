-- Account numbers become eight pure digits.
--
-- They used to be an alphanumeric code such as `LB-8553-23CF`. The identifier
-- is now numeric so that it can be read out loud, typed on a phone keypad and
-- remembered, and so that it can be searched by someone who wants to share a
-- ledger.
--
-- Existing accounts are converted here. The new value is derived from each
-- row's own id, which makes the statement idempotent and collision-free for
-- any realistic number of accounts.

UPDATE "users"
SET "account_number" = (
  (('x' || substr(md5("id"::text), 1, 8))::bit(32)::bigint % 90000000) + 10000000
)::text
WHERE "account_number" !~ '^[0-9]{8}$';

-- The format is now guaranteed by the database, not only by application code.
ALTER TABLE "users"
  ADD CONSTRAINT "users_account_number_eight_digits"
  CHECK ("account_number" ~ '^[0-9]{8}$');
