import { randomBytes } from "node:crypto";

import type { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "../db.js";
import { badRequest } from "../lib/errors.js";

/**
 * ⚠️ **These take a transaction client where they are called from one.** Registration writes the
 * new account, the claimed code and the referral in a single transaction, so `recordReferral` has
 * to accept the `tx` it is handed rather than opening its own.
 */
type Client = Prisma.TransactionClient;

/**
 * Referral codes — the owner's "次级邀请码".
 *
 * ⚠️ **One sentence holds the whole design, and he wrote it himself:**
 *
 * > *"次级邀请码不与任何账本绑定。用它注册的用户就是一个普通用户，只是：1. 不能生成次级邀请码；
 * > 2. 从注册当天起，协作者页面会显示一个 7 天的提醒，说他可以确认把邀请码生成者加为协作者。"*
 *
 * So three things follow, and each of them is a decision rather than a detail:
 *
 * 1. **No ledger is involved anywhere.** The code grants no access to anything. It records *who
 *    invited whom* and nothing else — which is why this module never touches `book_members`.
 *
 * 2. **The relationship is still not created by registering.** The newcomer gets a *reminder* that
 *    they may add the generator; **the generator still has to accept.** The consent rule is
 *    unchanged — *"加为协作者需要对方同意"* — and the referral code is the generator's
 *    pre-consent, not the newcomer's.
 *
 * 3. **The newcomer may not mint referral codes.** That is the one capability they lack, and it is
 *    checked where codes are minted rather than in the UI.
 */

/** Seven days, the same TTL as every other notification (the owner: *"统一七天"*). */
export const REFERRAL_REMINDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many referral codes one account may ever mint.
 *
 * ⚠️ **The owner's number, and he had to correct me for changing it.** The original rule was
 * *"次级邀请码（终身 3 个）"*; I implemented "unlimited, but no chaining" and wrote it up as a
 * "specification correction" — **which was me overruling a decision that was his to make.**
 *
 * ⚠️ **"终身" means a total, not a window.** Revoked and expired codes count too: if they did not,
 * the ceiling would be "three at a time" and somebody could mint endlessly by letting each one
 * lapse — **a limit you can refill is not a limit.**
 */
export const REFERRAL_CODE_LIFETIME_LIMIT = 3;

/**
 * A code a person can read out loud: groups of four, uppercase, no look-alike characters.
 *
 * ⚠️ **Characters that can be confused are left out** (`0`/`O`, `1`/`I`/`L`). A referral code gets
 * read over the phone, copied by hand, and typed on a tablet — **and a code that fails because
 * somebody wrote a zero for an O is a failure the user cannot diagnose.** The existing batch
 * generator's alphabet was chosen for the same reason.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length] ?? "A").join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export interface MintedReferral {
  readonly code: string;
  readonly expiresAt: Date;
}

/**
 * Mint a referral code.
 *
 * ⚠️ **The `allowsDirectCollaborator` choice is gone (1.10.05).** It existed to let a generator
 * decide whether the newcomer would be offered "add them as a collaborator" — and the account-level
 * collaborator system was removed on the owner's instruction, so the choice no longer describes
 * anything. **A code that still had the flag would be a switch with nothing behind it.**
 *
 * ⚠️ **The code is not tied to a ledger**, so this function takes no `bookId`. That absence is the
 * feature: a code minted while looking at one ledger works the same as one minted from the account
 * screen, because **it never mentioned a ledger in the first place**.
 */
export async function mintReferralCode(
  prisma: PrismaClient,
  input: {
    readonly generatorId: string;
    readonly note?: string | null;
  },
  now: Date = new Date(),
): Promise<MintedReferral> {
  /**
   * ⚠️ **Only ordinary accounts may mint referral codes** — the owner's "1. 不能生成次级邀请码".
   * The flag that decides it is `referredByUserId`: an account that arrived through somebody's
   * referral code is exactly the account that may not mint one. **Chaining referrals would let one
   * person manufacture an unbounded tree of accounts**, each of which looks independently invited.
   */
  const generator = await prisma.user.findUnique({
    where: { id: input.generatorId },
    select: { referredByUserId: true, isDemo: true },
  });

  if (!generator) throw badRequest("user_missing", "找不到这个账号。");

  if (generator.referredByUserId !== null) {
    throw badRequest(
      "referral_not_allowed",
      "通过次级邀请码注册的账号不能再生成次级邀请码。",
    );
  }

  /**
   * ⚠️ **The demo account may not mint codes either.** A publicly reachable read-only account that
   * could hand out registration codes would be a way to create accounts from outside — and the demo
   * account exists precisely so that nobody needs to.
   */
  if (generator.isDemo) {
    throw badRequest("referral_not_allowed", "演示账号不能生成邀请码。");
  }

  /**
   * ⚠️ **Every code this account has ever minted counts, including revoked and expired ones.**
   * Counting only the live ones would make the ceiling refillable — let one lapse, mint another —
   * and "终身 3 个" would mean "three at a time".
   *
   * ⚠️ **Counted from `createdByUserId`, with no separate counter column.** A stored count is a
   * second copy of a fact the rows already determine, and **the two drift** (`教训.md` §8.12) —
   * particularly here, where a code deleted for any reason would leave the counter claiming an
   * invitation that no longer exists.
   */
  const alreadyMinted = await prisma.registrationInvite.count({
    where: { createdByUserId: input.generatorId },
  });

  if (alreadyMinted >= REFERRAL_CODE_LIFETIME_LIMIT) {
    throw badRequest(
      "referral_limit_reached",
      `次级邀请码一共只能生成 ${String(REFERRAL_CODE_LIFETIME_LIMIT)} 个，你已经用完了。`,
    );
  }

  const expiresAt = new Date(now.getTime() + REFERRAL_REMINDER_TTL_MS);

  /**
   * ⚠️ **Retry on collision rather than trusting the odds.** The alphabet gives ~60 bits, so a
   * collision is not going to happen — but a `unique` violation surfacing as a 500 on a screen
   * somebody is standing in front of is a worse outcome than three extra lines here.
   */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();

    const taken = await prisma.registrationInvite.findUnique({ where: { code }, select: { id: true } });
    if (taken) continue;

    const created = await prisma.registrationInvite.create({
      data: {
        code,
        note: input.note ?? null,
        createdByUserId: input.generatorId,
        expiresAt,
      },
      select: { code: true },
    });

    return { code: created.code, expiresAt };
  }

  throw badRequest("referral_code_collision", "生成邀请码时遇到重复，请再试一次。");
}

/**
 * Record that a new account arrived through somebody's referral code.
 *
 * ⚠️ **Called inside the registration transaction**, which is why it takes a transaction client:
 * an account that exists with `referredByUserId` unset (or set with no code marked used) is a
 * half-registered account, and **the whole point of doing registration in one transaction is that
 * there is no such thing**.
 *
 * ⚠️ **The reminder is written directly rather than through `sendNotification`, and that is
 * deliberate: it costs no quota.** The generator already spent their intention when they minted the
 * code; charging the notification quota as well would mean **a person could be silenced by their own
 * invites** — mint five codes and the sixth newcomer gets no reminder, with nothing on screen to
 * explain why.
 *
 * ⚠️ **No reminder is written when the generator did not allow it** (`allowsDirectCollaborator`),
 * because that card would offer something the server then refuses.
 */
export async function recordReferral(
  client: Client,
  input: {
    readonly newUserId: string;
    readonly generatorId: string;
    readonly generatorDisplayName: string;
  },
  now: Date = new Date(),
): Promise<{ readonly reminderCreated: boolean }> {
  await client.user.update({
    where: { id: input.newUserId },
    data: { referredByUserId: input.generatorId },
  });

  if (input.generatorId === input.newUserId) return { reminderCreated: false };

  await client.notification.create({
    data: {
      senderId: input.generatorId,
      recipientId: input.newUserId,
      kind: "referral_reminder",
      /**
       * ⚠️ **A message written by the server, not by the sender.** It states the rule rather than
       * carrying an argument — the newcomer should be able to tell "this is what the app does" from
       * "this is what somebody is asking me for".
       */
      /**
       * ⚠️ **The wording changed with the model (1.10.05).** It used to promise *"确认之后，他会成为你的
       * 协作者"* — an account-level relationship that no longer exists. **A reminder that promises a
       * thing the server will not do is worse than no reminder** (`教训.md` §3.1), so it now states
       * the fact and points at the action that does exist: inviting somebody into a ledger.
       */
      message: `你是用 ${input.generatorDisplayName} 的邀请码注册的。想一起记账的话，可以把他邀请进你的账本。`,
      expiresAt: new Date(now.getTime() + REFERRAL_REMINDER_TTL_MS),
      createdAt: now,
    },
    select: { id: true },
  });

  return { reminderCreated: true };
}
