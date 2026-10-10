-- Ordinary registration codes expire; any code can be withdrawn.
--
-- The owner's decision (2026-10-10): a code generated for somebody without an
-- account lives **seven days**, and can be **revoked** before it is used.
--
-- Both exist for the same reason, and it is worth writing down because it
-- explains why the rule is not "codes never expire". A code is a **credential
-- that travels through a chat window**. Its useful life is days — enough to send
-- it, have it noticed, and have the person register — and the sender needs a way
-- to take it back when it reaches the wrong chat, the wrong person, or nobody at
-- all.
--
-- ⚠️ **The reserved-account codes are the exception, and the exception is the
-- point of them.** The owner asked for the first batch (account numbers
-- 10000002–10000099) to be written down and handed out slowly over months. A
-- code that expires in a week cannot do that, so those are created without an
-- expiry by the generator and the API refuses to revoke them. That distinction is
-- enforced in the application, not here, because the database cannot tell which
-- counter a number came from.

ALTER TABLE "registration_invites" ADD COLUMN "revoked_at" TIMESTAMPTZ(6);

-- Index the two columns the "may this code still be used?" check reads, so the
-- question stays a lookup rather than a scan as codes accumulate.
CREATE INDEX "registration_invites_code_live_idx"
  ON "registration_invites"("code")
  WHERE "used_at" IS NULL AND "revoked_at" IS NULL;
