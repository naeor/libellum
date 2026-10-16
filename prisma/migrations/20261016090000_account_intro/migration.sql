-- Additive and backwards-compatible: every existing account has already entered the app.
-- New registrations explicitly set false; no ledger, membership or transaction is changed.
ALTER TABLE "users" ADD COLUMN "has_completed_intro" BOOLEAN NOT NULL DEFAULT true;
