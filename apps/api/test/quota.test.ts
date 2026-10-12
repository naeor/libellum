import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { sendNotification, withdrawNotification } from "../src/collab/notify.js";
import { PER_SUBJECT_DAILY_LIMIT, TOTAL_DAILY_LIMIT } from "../src/collab/quota.js";
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
async function makeUser(username: string): Promise<string> {
  const invite = `INVITE-${username.toUpperCase()}`;

  await prisma.registrationInvite.create({ data: { code: invite, grantsAdmin: false } });

  const user = await prisma.user.create({
    data: {
      username,
      displayName: username,
      passwordHash: "not-a-real-hash",
      accountNumber: String(10_000_000 + Math.floor(Math.random() * 1_000_000)).padStart(8, "0"),
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
        sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "collaborator_request" }),
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
      sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "collaborator_request" }),
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
      await sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "collaborator_request" });
    }

    const extra = await makeUser("quota_one_more");
    await expect(
      sendNotification(prisma, { senderId: sender, recipientId: extra, kind: "collaborator_request" }),
    ).rejects.toMatchObject({ statusCode: 429, code: "notification_quota_total" });
  });

  it("refreshes the waiting notification instead of stacking a second one", async () => {
    const sender = await makeUser("quota_sender");
    const recipient = await makeUser("quota_recipient");

    const first = await sendNotification(prisma, {
      senderId: sender,
      recipientId: recipient,
      kind: "collaborator_request",
      message: "一起记账吧",
    });
    const second = await sendNotification(prisma, {
      senderId: sender,
      recipientId: recipient,
      kind: "collaborator_request",
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
      kind: "collaborator_request",
    });

    /**
     * ⚠️ **Tidying up must not cost anything.** The notification occupied nobody's attention once
     * it is gone, and holding its quota would punish the sender for withdrawing it — which would
     * make "cancel" a button people learn to avoid.
     */
    await withdrawNotification(prisma, sender, sent.id);

    for (let i = 0; i < PER_SUBJECT_DAILY_LIMIT; i += 1) {
      await expect(
        sendNotification(prisma, { senderId: sender, recipientId: recipient, kind: "collaborator_request" }),
      ).resolves.toBeTruthy();
    }
  });

  it("keeps two senders' totals apart", async () => {
    const alice = await makeUser("quota_alice");
    const bob = await makeUser("quota_bob");
    const recipient = await makeUser("quota_recipient");

    for (let i = 0; i < PER_SUBJECT_DAILY_LIMIT; i += 1) {
      await sendNotification(prisma, { senderId: alice, recipientId: recipient, kind: "collaborator_request" });
    }

    /**
     * ⚠️ The ceiling is on **the sender**, not on the recipient: one person's spending must not
     * silence somebody else's legitimate message.
     */
    await expect(
      sendNotification(prisma, { senderId: bob, recipientId: recipient, kind: "collaborator_request" }),
    ).resolves.toBeTruthy();
  });

  it("refuses a notification to yourself", async () => {
    const user = await makeUser("quota_self");

    await expect(
      sendNotification(prisma, { senderId: user, recipientId: user, kind: "collaborator_request" }),
    ).rejects.toMatchObject({ code: "notification_self" });
  });

  it("refuses to withdraw somebody else's notification", async () => {
    const sender = await makeUser("quota_sender");
    const other = await makeUser("quota_other");
    const recipient = await makeUser("quota_recipient");

    const sent = await sendNotification(prisma, {
      senderId: sender,
      recipientId: recipient,
      kind: "collaborator_request",
    });

    await expect(withdrawNotification(prisma, other, sent.id)).rejects.toMatchObject({
      code: "notification_not_sender",
    });
  });
});
