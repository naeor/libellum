-- Being an administrator becomes something a code says, not something inferred.
--
-- ⚠️ **This fixes a real privilege bug the owner spotted.** Registration decided
-- `isAdmin` from `invite.accountNumber !== null` — "this code reserved an account
-- number" — and that is a different fact from "the person using it should be an
-- administrator". Tying them together meant **any command that reserved a number
-- minted an administrator**, including `pnpm invite:create --reserved` and the
-- whole batch generator. Neither is meant to be a privilege-granting operation;
-- they are ordinary commands somebody runs to let a family member register.
--
-- A privilege should be granted deliberately. `grants_admin` is that deliberate
-- act, and the registration path now reads it instead of inferring.

ALTER TABLE "registration_invites" ADD COLUMN "grants_admin" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Backfill: only the codes the owner reserved for administrators
-- ---------------------------------------------------------------------------
--
-- The backfill is narrow on purpose. It grants the flag to the batch he actually
-- handed out (the reserved block 10000002–10000099) and to nothing else — so the
-- codes that were already issued keep the meaning he gave them, and no code
-- acquires a privilege it was not created with.
--
-- Scoped by the reserved **block** rather than by "has a number at all", because
-- a later batch would get its flag when it is created, not from this migration.

UPDATE "registration_invites"
   SET "grants_admin" = true
 WHERE "account_number" IS NOT NULL
   AND "account_number" BETWEEN '10000002' AND '10000099';
