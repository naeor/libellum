import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeApp, prisma, resetDatabase, signUp } from "./support.js";

/**
 * Share links.
 *
 * ⚠️ **The first test is the one that matters most, and it is not about behaviour at all**: it
 * reads the database and asserts the plaintext token is not in it. Everything else here could pass
 * while the column quietly held the token in clear — and **the whole reason a link is safe to hand
 * around is that a stolen dump cannot be used to open a ledger.**
 */
describe("share links", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function account(username: string) {
    const cookie = await signUp(app, username);
    const user = await prisma.user.findUniqueOrThrow({ where: { username }, select: { id: true } });
    const membership = await prisma.bookMember.findFirstOrThrow({
      where: { userId: user.id },
      select: { bookId: true },
    });
    return { cookie, userId: user.id, bookId: membership.bookId };
  }

  function mint(cookie: string, bookId: string, role: "editor" | "viewer") {
    return app.inject({
      method: "POST",
      url: "/api/v1/share/links",
      headers: { cookie, "x-libellum-book": bookId },
      payload: { role },
    });
  }

  it("never stores the token itself", async () => {
    const owner = await account("share_owner");

    const created = await mint(owner.cookie, owner.bookId, "viewer");
    expect(created.statusCode).toBe(201);

    const { token } = created.json() as { token: string };
    expect(token.length).toBeGreaterThan(20);

    /**
     * ⚠️ **Read every column of every row and assert the token appears in none of them.** Checking
     * only `token_hash` would pass even if a second column had been added and filled with the
     * plaintext — and it is exactly that kind of "we also log it for debugging" column that turns a
     * hashed credential back into a usable one.
     */
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "book_share_links"
    `;

    expect(rows).toHaveLength(1);
    const serialised = JSON.stringify(rows, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialised).not.toContain(token);
  });

  it("joins the ledger with the role the link was minted for", async () => {
    const owner = await account("share_owner");
    const guest = await account("share_guest");

    const { token } = (await mint(owner.cookie, owner.bookId, "viewer")).json() as { token: string };

    /**
     * ⚠️ **Reading first, joining second.** The owner's flow shows the person *which ledger and what
     * permission* before they confirm — and a version that joined on open would add people to
     * ledgers from a stray tap on a link in a chat window.
     */
    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/share/${token}`,
      headers: { cookie: guest.cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect((preview.json() as { role: string; alreadyMember: boolean }).role).toBe("viewer");
    expect((preview.json() as { alreadyMember: boolean }).alreadyMember).toBe(false);

    // Nothing has happened yet.
    expect(await prisma.bookMember.count({ where: { bookId: owner.bookId, userId: guest.userId } })).toBe(0);

    const joined = await app.inject({
      method: "POST",
      url: `/api/v1/share/${token}/join`,
      headers: { cookie: guest.cookie },
    });
    expect(joined.statusCode).toBe(200);

    /**
     * ⚠️ **`viewer` comes from the link and cannot be requested.** If the caller could name the
     * role, "here is a read-only link" would become a way to hand out write access.
     */
    const membership = await prisma.bookMember.findUniqueOrThrow({
      where: { bookId_userId: { bookId: owner.bookId, userId: guest.userId } },
      select: { role: true },
    });
    expect(membership.role).toBe("viewer");
  });

  it("stops working the moment it is revoked", async () => {
    const owner = await account("share_owner");
    const guest = await account("share_guest");

    const created = (await mint(owner.cookie, owner.bookId, "editor")).json() as { id: string; token: string };

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/share/links/${created.id}/revoke`,
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
    });
    expect(revoked.statusCode).toBe(200);

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/share/${created.token}`,
      headers: { cookie: guest.cookie },
    });
    expect(preview.statusCode).toBe(404);

    const joined = await app.inject({
      method: "POST",
      url: `/api/v1/share/${created.token}/join`,
      headers: { cookie: guest.cookie },
    });
    expect(joined.statusCode).toBe(404);
    expect(await prisma.bookMember.count({ where: { bookId: owner.bookId, userId: guest.userId } })).toBe(0);
  });

  it("keeps a revoked link in the list, so the history survives", async () => {
    const owner = await account("share_owner");
    const created = (await mint(owner.cookie, owner.bookId, "viewer")).json() as { id: string };

    await app.inject({
      method: "POST",
      url: `/api/v1/share/links/${created.id}/revoke`,
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/share/links",
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
    });

    /**
     * ⚠️ **Revoking is not deleting.** The row keeps when and by whom, which is what somebody
     * auditing "how did this person get in" needs — and what a soft delete would have thrown away.
     */
    const links = (listed.json() as { links: { id: string; revokedAt: string | null }[] }).links;
    expect(links).toHaveLength(1);
    expect(links[0]?.revokedAt).not.toBeNull();
  });

  it("refuses to let a viewer mint a link", async () => {
    const owner = await account("share_owner");
    const viewer = await account("share_viewer");

    await prisma.bookMember.create({
      data: { bookId: owner.bookId, userId: viewer.userId, role: "viewer" },
    });

    /**
     * ⚠️ **A link is a standing invitation to read somebody's ledger**, so minting one is a write.
     * The server refuses it — the missing button in the UI is a courtesy, not the control.
     */
    const refused = await mint(viewer.cookie, owner.bookId, "viewer");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("book_read_only");
    expect(await prisma.bookShareLink.count()).toBe(0);
  });

  it("lets a guest leave a shared ledger, but not the creator", async () => {
    const owner = await account("share_owner");
    const guest = await account("share_guest");

    const { token } = (await mint(owner.cookie, owner.bookId, "editor")).json() as { token: string };
    await app.inject({ method: "POST", url: `/api/v1/share/${token}/join`, headers: { cookie: guest.cookie } });

    const left = await app.inject({
      method: "POST",
      url: `/api/v1/books/${owner.bookId}/leave`,
      headers: { cookie: guest.cookie },
    });
    expect(left.statusCode).toBe(200);

    /**
     * ⚠️ **The row stays with a `leftAt` timestamp** — it is what the permission guard checks, and
     * also the record that this person was once here. A deleted row would answer neither question.
     */
    const membership = await prisma.bookMember.findUniqueOrThrow({
      where: { bookId_userId: { bookId: owner.bookId, userId: guest.userId } },
      select: { leftAt: true },
    });
    expect(membership.leftAt).not.toBeNull();

    // And they can no longer read it.
    const refused = await app.inject({
      method: "GET",
      url: "/api/v1/stats?from=2026-10-01&to=2026-10-31&currency=CNY",
      headers: { cookie: guest.cookie, "x-libellum-book": owner.bookId },
    });
    expect(refused.statusCode).toBe(403);

    /**
     * ⚠️ **The creator may not leave their own ledger.** Doing so would produce a ledger with no
     * member who can write in it — nobody able to edit, invite or dispose of it. The owner's answer
     * for that case is the other meaning he asked to keep apart: **整本弃置**.
     */
    const ownerRefused = await app.inject({
      method: "POST",
      url: `/api/v1/books/${owner.bookId}/leave`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerRefused.statusCode).toBe(400);
    expect(ownerRefused.json().code).toBe("creator_cannot_leave");
  });

  it("refuses the eleventh person once a ten-person link is full", async () => {
    const owner = await account("share_owner");
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/share/links",
        headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
        payload: { role: "viewer", days: 7, maxUses: 2 },
      })
    ).json() as { token: string };

    /**
     * ⚠️ **This is the owner's S9 acceptance criterion *"分享链接……满员后无法再加入"*, and it had
     * been missing entirely** — only revocation was implemented. Two people join a two-person link;
     * the third must be refused.
     */
    for (const name of ["share_g1", "share_g2"]) {
      const guest = await account(name);
      const joined = await app.inject({
        method: "POST",
        url: `/api/v1/share/${created.token}/join`,
        headers: { cookie: guest.cookie },
      });
      expect(joined.statusCode).toBe(200);
    }

    const latecomer = await account("share_g3");

    /**
     * ⚠️ **The preview refuses too, and that is a separate assertion from the join.** A dead link
     * that still showed a confirmation screen would have the person read "you are about to join
     * 家庭账本" and only then be turned away.
     */
    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/share/${created.token}`,
      headers: { cookie: latecomer.cookie },
    });
    expect(preview.statusCode).toBe(404);

    const refused = await app.inject({
      method: "POST",
      url: `/api/v1/share/${created.token}/join`,
      headers: { cookie: latecomer.cookie },
    });
    expect(refused.statusCode).toBe(404);
    /**
     * ⚠️ **Three, not one**: the owner plus the two who got in. Written out because the first
     * version of this assertion said `1` — the count a *refusal* would leave — and **it failed,
     * which is the assertion doing its job.** What matters is that the third person is not among
     * them.
     */
    expect(await prisma.bookMember.count({ where: { bookId: owner.bookId } })).toBe(3);
    expect(
      await prisma.bookMember.count({ where: { bookId: owner.bookId, userId: latecomer.userId } }),
    ).toBe(0);
  });

  it("stops a link working after its days are up, and says how long it had", async () => {
    const owner = await account("share_owner");
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/share/links",
        headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
        payload: { role: "viewer", days: 1, maxUses: 5 },
      })
    ).json() as { id: string; token: string };

    /**
     * ⚠️ **Aging the row rather than waiting a day.** What is under test is the arithmetic
     * `createdAt + days <= now`, and **a test that slept for 24 hours would never be run.**
     */
    await prisma.bookShareLink.update({
      where: { id: created.id },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });

    const guest = await account("share_guest");
    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/share/${created.token}`,
      headers: { cookie: guest.cookie },
    });
    expect(preview.statusCode).toBe(404);

    /**
     * ⚠️ **And the list still says it was a one-day link.** That is why `days` is stored rather than
     * an absolute expiry: the owner can see *why* it stopped, instead of having to work it out.
     */
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/share/links",
      headers: { cookie: owner.cookie, "x-libellum-book": owner.bookId },
    });
    const link = (listed.json() as { links: { days: number; active: boolean }[] }).links[0];
    expect(link?.days).toBe(1);
    expect(link?.active).toBe(false);
  });
});
