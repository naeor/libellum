/**
 * The rules a registration code lives under.
 *
 * Kept in `shared` rather than in the API because the interface has to explain
 * them — "this code expires in seven days" is something the person sending it
 * needs to see before they send it, and the person receiving it needs to see
 * when it fails. A rule stated in two places drifts; here there is one.
 */

/**
 * How long an ordinary code lives.
 *
 * The owner's figure (2026-10-10), and the reasoning is about how a code
 * travels: it is sent through a chat window, noticed, and acted on within days.
 * A code that never expires is one somebody can use a year later, after the
 * reason for the invitation is gone.
 */
export const INVITE_VALID_DAYS = 7;

/** In milliseconds, for the arithmetic. */
export const INVITE_VALID_MS = INVITE_VALID_DAYS * 24 * 60 * 60 * 1_000;

/**
 * Why a code cannot be used. `null` means it can.
 *
 * This exists as a named type rather than a boolean because the *reason* is what
 * the interface has to show. "Invalid code" tells somebody nothing; "邀请码已过期"
 * tells them to ask for another one.
 */
export type InviteRejection = "used" | "revoked" | "expired";

/**
 * Whether a code may still be redeemed, and if not, why.
 *
 * A pure function so both the API and its tests read the same rule, and so the
 * order of the checks is decided once: a code that was both used and expired
 * should say "used", because that is the fact that ends the story.
 *
 * `now` is a parameter rather than a call to `Date.now()` inside, so the expiry
 * boundary can be tested without waiting seven days.
 */
export function rejectInvite(
  invite: {
    readonly usedAt: Date | null;
    readonly revokedAt: Date | null;
    readonly expiresAt: Date | null;
  },
  now: Date = new Date(),
): InviteRejection | null {
  if (invite.usedAt !== null) return "used";
  if (invite.revokedAt !== null) return "revoked";
  if (invite.expiresAt !== null && invite.expiresAt.getTime() <= now.getTime()) return "expired";

  return null;
}

/** The message to show for each reason. One place, so they cannot disagree. */
export const INVITE_REJECTION_MESSAGE: Readonly<Record<InviteRejection, string>> = {
  used: "该邀请码已被使用。",
  revoked: "该邀请码已被撤销。",
  expired: "该邀请码已过期，请向邀请你的人再要一个。",
};

/** The error code the API returns for each reason, so clients can branch on it. */
export const INVITE_REJECTION_CODE: Readonly<Record<InviteRejection, string>> = {
  used: "invite_used",
  revoked: "invite_revoked",
  expired: "invite_expired",
};

/**
 * How many secondary codes one account may ever create.
 *
 * The owner's limit (2026-10-10): three, for life. The purpose of secondary
 * codes is to let somebody pull in a family member who has no account yet, not
 * to let an account grow without bound — so it is a small number, and one that
 * does not renew.
 */
export const SECONDARY_INVITE_LIMIT = 3;

/**
 * Share-link limits, decided by the owner for the collaboration stage.
 *
 * Recorded here now because they are the same kind of number as the rest and
 * belong beside them; nothing enforces them yet.
 */
export const SHARE_LINK_MIN_DAYS = 1;
export const SHARE_LINK_MAX_DAYS = 7;
export const SHARE_LINK_MIN_PEOPLE = 1;
export const SHARE_LINK_MAX_PEOPLE = 10;

/**
 * A code's shape: twelve Crockford characters, printed as `XXXX-XXXX-XXXX`.
 *
 * The Zod schema for it already lives in `auth.ts` (`inviteCodeSchema`) because
 * registration parses it; this is the bare pattern for the places that only need
 * to recognise one — a log line, a document, a test.
 */
export const INVITE_CODE_PATTERN =
  /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
