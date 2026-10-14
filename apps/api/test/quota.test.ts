import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { sendNotification, withdrawNotification } from "../src/collab/notify.js";
import { PER_SUBJECT_DAILY_LIMIT, TOTAL_DAILY_LIMIT, isQuotaExempt } from "../src/collab/quota.js";
import { prisma, resetDatabase } from "./support.js";

/**
 * ⚠️ **The quota, and the reason it has tests rather than only code**: the owner set two ceilings to
 * stop somebody being harassed, and a ceiling that can be stepped over is not a ceiling. The
 * interesting cases are not "does five work" but **"does six fail"** and **"do two simultaneous
 * fifths both fail"**.
 *
 * The helpers are called directly rather than through HTTP: what is under test is the arithmetic
 * and the transaction, and a route would only add a serialisation step between the reader and the
 * thing being read.
 */
/**
 * ⚠️ **The account number is a parameter now, and the default deliberately avoids the
 * exempt range.**
 *
 * The old body was `10_000_000 + Math.floor(Math.random() * 1_000_000)`, which meant roughly
 * **one run in ten produced an account number inside `10000000`–`10000099`** — the first hundred
 * accounts, which the owner exempted from both ceilings on 2026-10-13. Every ceiling test below
 * would then have passed vacuously or failed confusingly, at random, with no code change to
 * explain it.
 *
 * A ceiling test has to be run against an account that is **subject to the ceiling**. The default
 * is above the reserved block so that stays true, and the exemption tests below ask for the
 * exempt range explicitly.
 */
let accountSeq = 0;

async function makeUser(
  username: string,
  accountNumber = String(20_000_000 + (accountSeq += 1)).padStart(8, "0"),
): Promise<string> {
  const invite = `INVITE-${username.toUpperCase()}`;

  await prisma.registrationInvite.create({ data: { code: invite, grantsAdmin: false } });

  const user = await prisma.user.create({
    data: {
      username,
      displayName: username,
      passwordHash: "not-a-real-hash",
      accountNumber,
      recoveryCodeHash: "not-a-real-hash",
    },
    select: { id: true },
  });

  return user.id;
}

describe("notification quota", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("allows exactly the per-subject limit, then refuses", async () => {
    const sender = await makeUser("quota_sender");
    const recipient = await makeUser("quota_recipient");

    for (let i = 0; i < PER_SUBJECT_DAILY_LIMIT; i += 1) {
      await expect(
        sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "book_invite" }),
      ).resolves.toBeTruthy();
    }

    /**
     * ⚠️ **The sixth is refused**, and the code says which ceiling — "超出次数直接拦下" was the
     * owner's instruction, and a silent drop would look exactly like a successful send.
     *
     * ⚠️ Repeated sends refresh the same row, so there is one notification and five units of
     * quota spent: **the quota bounds how often somebody may push something, not how many rows
     * exist.**
     */
    await expect(
      sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "book_invite" }),
    ).rejects.toMatchObject({ statusCode: 429, code: "notification_quota_subject" });

    expect(
      await prisma.notification.count({ where: { senderId: sender, recipientId: recipient } }),
    ).toBe(1);
  });

  it("does not let a second subject be reached once the daily total is spent", async () => {
    const sender = await makeUser("quota_sender");
    const recipients = await Promise.all(
      Array.from({ length: TOTAL_DAILY_LIMIT }, (_, index) => makeUser(`quota_r${String(index)}`)),
    );

    /**
     * ⚠️ **One to each of twenty different people**: the per-subject ceiling never fires, so this is
     * the total ceiling doing the work. Without it, the per-subject limit would be trivially
     * bypassed by spreading the same behaviour across a list of names.
     */
    for (const recipient of recipients) {
      await sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "book_invite" });
    }

    const extra = await makeUser("quota_one_more");
    await expect(
      sendNotification(prisma, { senderId: sender, recipientId: extra, kind: "book_invite" }),
    ).rejects.toMatchObject({ statusCode: 429, code: "notification_quota_total" });
  });

  it("refreshes the waiting notification instead of stacking a second one", async () => {
    const sender = await makeUser("quota_sender");
    const recipient = await makeUser("quota_recipient");

    const first = await sendNotification(prisma, {
      senderId: sender,
      recipientId: recipient,
      kind: "book_invite",
      message: "一起记账吧",
    });
    const second = await sendNotification(prisma, {
      senderId: sender,
      recipientId: recipient,
      kind: "book_invite",
      message: "再说一次",
    });

    /**
     * ⚠️ **Same row, and `refreshed` says so.** Two rows would ask the recipient to decide the same
     * question twice, and the two could be answered differently — the same class of bug as a queue
     * that disagrees with the marks it was derived from.
     */
    expect(second.id).toBe(first.id);
    expect(second.refreshed).toBe(true);
    expect(await prisma.notification.count()).toBe(1);

    const stored = await prisma.notification.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.message).toBe("再说一次");
  });

  it("gives the quota back when an invitation is withdrawn", async () => {
    const sender = await makeUser("quota_sender");
    const recipient = await makeUser("quota_recipient");

    const sent = await sendNotification(prisma, {
      senderId: sender,
      recipientId: recipient,
      kind: "book_invite",
    });

    /**
     * ⚠️ **Tidying up must not cost anything.** The notification occupied nobody's attention once
     * it is gone, and holding its quota would punish the sender for withdrawing it — which would
     * make "cancel" a button people learn to avoid.
     */
    await withdrawNotification(prisma, sender, sent.id);

    for (let i = 0; i < PER_SUBJECT_DAILY_LIMIT; i += 1) {
      await expect(
        sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "book_invite" }),
      ).resolves.toBeTruthy();
    }
  });

  it("keeps two senders' totals apart", async () => {
    const alice = await makeUser("quota_alice");
    const bob = await makeUser("quota_bob");
    const recipient = await makeUser("quota_recipient");

    for (let i = 0; i < PER_SUBJECT_DAILY_LIMIT; i += 1) {
      await sendNotification(prisma, { senderId: alice, recipientId: recipient, kind: "book_invite" });
    }

    /**
     * ⚠️ The ceiling is on **the sender**, not on the recipient: one person's spending must not
     * silence somebody else's legitimate message.
     */
    await expect(
      sendNotification(prisma, { senderId: bob, recipientId: recipient, kind: "book_invite" }),
    ).resolves.toBeTruthy();
  });

  it("refuses a notification to yourself", async () => {
    const user = await makeUser("quota_self");

    await expect(
      sendNotification(prisma, { senderId: user, recipientId: user, kind: "book_invite" }),
    ).rejects.toMatchObject({ code: "notification_self" });
  });

  it("refuses to withdraw somebody else's notification", async () => {
    const sender = await makeUser("quota_sender");
    const other = await makeUser("quota_other");
    const recipient = await makeUser("quota_recipient");

    const sent = await sendNotification(prisma, {
      senderId: sender,
      recipientId: recipient,
      kind: "book_invite",
    });

    await expect(withdrawNotification(prisma, other, sent.id)).rejects.toMatchObject({
      code: "notification_not_sender",
    });
  });
});

/**
 * ⚠️ **The first hundred accounts are not held to either ceiling** — the owner's instruction on
 * 2026-10-13, given as *"对于编号前一百（一直到 1000099）的用户取消限制，只跳过限制仍然计数"*, with the
 * range confirmed as `10000000`–`10000099`.
 *
 * Two things have to hold at once, and they pull in opposite directions, which is why they get
 * tests of their own:
 *
 * * **the refusal is skipped** — that is the request;
 * * **everything else is unchanged** — the *"注意其他所有账号都保持不变"* half, which is the half
 *   that would rot silently. An exemption is easy to write too wide, and an account that should
 *   still be capped is exactly the kind of thing nobody notices until somebody is harassed.
 */
describe("quota exemption for the first hundred accounts", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lets an exempt sender pass the per-subject ceiling, and keeps counting", async () => {
    const sender = await makeUser("quota_exempt", "10000050");
    const recipient = await makeUser("quota_recipient");

    /**
     * ⚠️ **Well past the ceiling, not just up to it.** Stopping at `PER_SUBJECT_DAILY_LIMIT`
     * would pass even if the exemption did nothing, because the limit is inclusive.
     */
    for (let i = 0; i < PER_SUBJECT_DAILY_LIMIT + 3; i += 1) {
      await expect(
        sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "book_invite" }),
      ).resolves.toBeTruthy();
    }

    /**
     * ⚠️ **And the counter is still real** — *"只跳过限制仍然计数"*. This is the assertion that
     * separates "exemption" from "the quota stopped working", and it is what keeps the
     * diagnostics screen honest about how much was actually sent.
     *
     * ⚠️ **The `TOTAL_SUBJECT` row specifically, not the sum of the rows.** There are two
     * counters per send — one per recipient, one for the day's total — so summing them double
     * counts. (Getting this wrong is how the first version of this test failed: 16 against an
     * expected 8, which looked like an over-count in the code and was an over-count in the
     * assertion.)
     */
    const day = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const total = await prisma.notificationQuota.findFirst({
      where: {
        userId: sender,
        day,
        subjectId: "00000000-0000-0000-0000-000000000000",
      },
      select: { used: true },
    });

    expect(total?.used).toBe(PER_SUBJECT_DAILY_LIMIT + 3);
  });

  it("lets an exempt sender pass the daily total, across many recipients", async () => {
    const sender = await makeUser("quota_exempt", "10000000");
    const recipients = await Promise.all(
      Array.from({ length: TOTAL_DAILY_LIMIT + 2 }, (_, index) =>
        makeUser(`quota_ex_r${String(index)}`),
      ),
    );

    for (const recipient of recipients) {
      await expect(
        sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "book_invite" }),
      ).resolves.toBeTruthy();
    }
  });

  it("exempts the whole reserved block, at both ends", async () => {
    /**
     * ⚠️ **The boundaries are the interesting part.** An off-by-one here would either exempt one
     * account too many or leave the last reserved code capped — and both would be invisible
     * until somebody hit it.
     */
    for (const number of ["10000000", "10000099"]) {
      const sender = await makeUser(`quota_edge_${number}`, number);
      const recipient = await makeUser(`quota_edge_r_${number}`);

      for (let i = 0; i < PER_SUBJECT_DAILY_LIMIT + 1; i += 1) {
        await expect(
          sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "book_invite" }),
        ).resolves.toBeTruthy();
      }
    }
  });

  it("keeps the ceiling for the very next account number", async () => {
    /**
     * ⚠️ **`10000100`, one past the end** — "其他所有账号都保持不变" is only true if the range
     * actually ends somewhere.
     */
    const sender = await makeUser("quota_just_outside", "10000100");
    const recipient = await makeUser("quota_recipient");

    for (let i = 0; i < PER_SUBJECT_DAILY_LIMIT; i += 1) {
      await sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "book_invite" });
    }

    await expect(
      sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "book_invite" }),
    ).rejects.toMatchObject({ statusCode: 429, code: "notification_quota_subject" });
  });

  it("keeps the ceiling for an ordinary account far outside the range", async () => {
    // The default fixture number, i.e. the case every other test in this file relies on.
    const sender = await makeUser("quota_ordinary");
    const recipient = await makeUser("quota_recipient");

    for (let i = 0; i < PER_SUBJECT_DAILY_LIMIT; i += 1) {
      await sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "book_invite" });
    }

    await expect(
      sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "book_invite" }),
    ).rejects.toMatchObject({ statusCode: 429, code: "notification_quota_subject" });
  });

  it("treats an unparseable account number as not exempt", async () => {
    /**
     * ⚠️ **The safe direction for a ceiling is to keep it.** The column is CHECK-constrained to
     * eight digits, so a value that does not parse means something is structurally wrong — and
     * failing open would turn a data problem into a harassment vector. Same reasoning as
     * `BookMember.role` defaulting to `viewer`.
     */
    expect(isQuotaExempt(null)).toBe(false);
    expect(isQuotaExempt(undefined)).toBe(false);
    expect(isQuotaExempt("")).toBe(false);
    expect(isQuotaExempt("ABCDEFGH")).toBe(false);
    expect(isQuotaExempt("1000005")).toBe(false); // seven digits
    expect(isQuotaExempt("100000500")).toBe(false); // nine digits
    expect(isQuotaExempt("10000099")).toBe(true);
  });
});
