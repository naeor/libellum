import { UNCATEGORISED_NAME, type TransactionKind } from "@libellum/shared";
import type { FastifyRequest } from "fastify";

import type { PrismaClient } from "../db.js";
import type { BookRole } from "../generated/prisma/enums.js";
import { forbidden, notFound } from "../lib/errors.js";

/**
 * Authorization for ledger data.
 *
 * The rule, in one line: **permission comes from `book_members` and from
 * nothing else.** A user id, book id or role sent by a client is treated as a
 * hint at most — never as a claim. Every read and every write goes through
 * these helpers first.
 */

/** Throws 403 unless this user is a member of this book. */
export async function requireBookAccess(
  prisma: PrismaClient,
  userId: string,
  bookId: string,
): Promise<void> {
  const membership = await prisma.bookMember.findUnique({
    where: { bookId_userId: { bookId, userId } },
    select: { role: true },
  });

  if (!membership) {
    // 403, not 404: the caller is authenticated and simply has no business
    // here. Returning 404 would leak which book ids exist.
    throw forbidden("book_forbidden", "无权访问该账本。");
  }
}

/**
 * The book this request is about, and what the caller may do in it.
 *
 * ⚠️ **This replaces `currentBookId`, which asked the database "which book does this user
 * have?"** — a question that had exactly one answer while an account could only have one book,
 * and has several now. It returned the *oldest* membership, so with two books every route
 * without a header would quietly operate on whichever book was joined first.
 *
 * ⚠️ **The header is the client's declaration, never its permission.** It says which book the
 * request is about; whether the caller may touch that book is decided here, by looking at
 * `book_members` — the same rule as before: *"permission comes from `book_members` and from
 * nothing else."*
 *
 * ⚠️ **`leftAt: null` is part of the membership test.** A row stays behind when somebody leaves
 * (that is how leaving is recorded), so a membership that exists is not the same as a
 * membership that is current. **Reading `book_members` without this filter would let a person
 * who left a ledger keep writing in it** — the row is still there.
 */
export interface BookContext {
  readonly bookId: string;
  readonly role: BookRole;
}

/**
 * ⚠️ `owner` is not one of the roles any more (the owner decided on two), but the enum value
 * still exists in the database. Anything that is not `viewer` is treated as able to write —
 * which is the safe direction for the two rows the migration converted, and it is asserted in
 * the tests.
 */
const WRITE_ROLES: readonly BookRole[] = ["editor", "owner"];

export async function requireBook(
  prisma: PrismaClient,
  request: FastifyRequest,
  userId: string,
): Promise<BookContext> {
  const declared = readDeclaredBookId(request);

  if (declared === null) return fallbackBook(prisma, userId);

  const membership = await prisma.bookMember.findUnique({
    where: { bookId_userId: { bookId: declared, userId } },
    select: { role: true, leftAt: true },
  });

  /**
   * 403 and not 404, for the reason the old guard already gave: the caller is authenticated and
   * simply has no business here, and answering 404 would tell them which book ids exist.
   */
  if (!membership || membership.leftAt !== null) {
    throw forbidden("book_forbidden", "无权访问该账本。");
  }

  return { bookId: declared, role: membership.role };
}

/**
 * The same thing, for a route that changes data.
 *
 * ⚠️ **The check lives on the server because the client's is only a courtesy.** The owner put
 * it plainly: *"即使 viewer 通过某种方式发起了更改，服务器的数据也不会被污染."* A viewer's UI
 * hides the buttons; this is what makes the hiding irrelevant.
 */
export async function requireBookForWrite(
  prisma: PrismaClient,
  request: FastifyRequest,
  userId: string,
): Promise<BookContext> {
  const context = await requireBook(prisma, request, userId);

  if (!WRITE_ROLES.includes(context.role)) {
    throw forbidden("book_read_only", "你是这本账的查看者，不能修改它。");
  }

  return context;
}

/**
 * The ledger id the client declared, or `null` when it declared none.
 *
 * ⚠️ **A header rather than a path segment**, which the owner chose deliberately: the ledger a
 * change belongs to has to be fixed *when the change is made*, and a header is written by the
 * one shared client wrapper, so no screen can forget it. See `apps/web/src/lib/api.ts`.
 */
function readDeclaredBookId(request: FastifyRequest): string | null {
  const raw = request.headers["x-libellum-book"];
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * What to do when the client declared no ledger.
 *
 * ⚠️ **This is a compatibility path, and it is deliberately temporary.** Every client that
 * exists today sends the header, so in practice this is only reached by an old cached bundle or
 * by a test that deliberately omits it. Until the ledger list ships, refusing the request would
 * break the whole application; answering with the oldest membership is exactly what the code
 * did before, so **nothing changes for the accounts that exist today.**
 *
 * ⚠️ **It falls back rather than guessing silently, and the request is logged.** When this path
 * is exercised in production it means a client is out of date, and that is worth seeing.
 */
async function fallbackBook(prisma: PrismaClient, userId: string): Promise<BookContext> {
  const membership = await prisma.bookMember.findFirst({
    where: { userId, leftAt: null },
    orderBy: { joinedAt: "asc" },
    select: { bookId: true, role: true },
  });

  if (!membership) throw notFound("book_missing", "找不到你的账本。");

  return { bookId: membership.bookId, role: membership.role };
}

/**
 * The book this account owns.
 *
 * @deprecated Superseded by `requireBook`, which answers the same question with the ledger the
 * request actually named. Kept only while the last callers are migrated; **do not add new ones**
 * — with more than one book this returns the oldest membership, which is a silent wrong answer.
 */
export async function currentBookId(prisma: PrismaClient, userId: string): Promise<string> {
  const membership = await prisma.bookMember.findFirst({
    where: { userId },
    orderBy: { joinedAt: "asc" },
    select: { bookId: true },
  });

  if (!membership) {
    throw notFound("book_missing", "找不到你的账本。");
  }

  return membership.bookId;
}

/**
 * Pick the category an entry should be filed under.
 *
 * A chosen category must belong to the same book and the same kind — otherwise
 * an income entry could be filed under 餐饮, and totals per category would be
 * nonsense.
 *
 * **An empty value is not an error.** "Not chosen" is the ordinary case, and the
 * owner put the reason plainly: 暂无分类 is itself a category, so an entry with
 * no choice still belongs in the ledger. It falls back to the book's hidden
 * system category for that kind, which is why `category_id` can stay mandatory.
 *
 * The two failure modes are reported **separately**, and that came from a real
 * complaint. One message used to cover both: "分类不存在或不属于该账本". When the
 * actual problem was that a ¥ expense category had been sent with an income
 * entry, that message was simply untrue — the category existed, and it did
 * belong to the book — and it sent the reader looking for a permissions problem
 * that was not there. A message that describes the wrong fault is worse than no
 * message, because it is believed.
 */
export async function resolveCategoryId(
  prisma: PrismaClient,
  bookId: string,
  kind: TransactionKind,
  requested: string | null | undefined,
): Promise<string> {
  // `""` means the same as absent. A `<select>` with an empty option hands back
  // an empty string, and the client should not have to know that.
  if (requested !== null && requested !== undefined && requested !== "") {
    const category = await prisma.category.findFirst({
      where: { id: requested, bookId },
      select: { id: true, kind: true, name: true, isSystem: true },
    });

    if (category === null) {
      throw forbidden("category_invalid", "这个分类不在这本账里，可能已被删除。");
    }

    if (category.kind !== kind) {
      // The other kind's 暂无分类 is not a mismatch worth failing over: the
      // person did not choose a category at all, so there is nothing to correct.
      // Anything else is a genuine inconsistency between the type and the
      // category, and it is named as such.
      const wantIncome = category.kind === "income";

      if (!category.isSystem) {
        throw forbidden(
          "category_kind_mismatch",
          `「${category.name}」属于${wantIncome ? "收入" : "支出"}分类，和这笔记账的收支类型不一致。`,
        );
      }
    } else {
      return category.id;
    }
  }

  const fallback = await prisma.category.findFirst({
    where: { bookId, kind, name: UNCATEGORISED_NAME, isSystem: true },
    select: { id: true },
  });

  if (!fallback) throw notFound("uncategorised_missing", "账本数据不完整，缺少默认分类。");

  return fallback.id;
}

/** A payment method must belong to the book it is used in. */
export async function resolvePaymentMethodId(
  prisma: PrismaClient,
  bookId: string,
  requested: string | null | undefined,
): Promise<string | null> {
  if (!requested) return null;

  const method = await prisma.paymentMethod.findFirst({
    where: { id: requested, bookId },
    select: { id: true },
  });

  if (!method) throw forbidden("payment_method_invalid", "支付方式不存在或不属于该账本。");

  return method.id;
}

/** Every tag must belong to the book; tags are deduplicated first. */
export async function resolveTagIds(
  prisma: PrismaClient,
  bookId: string,
  requested: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(requested)];

  if (unique.length === 0) return [];

  const found = await prisma.tag.findMany({
    where: { id: { in: unique }, bookId },
    select: { id: true },
  });

  if (found.length !== unique.length) {
    throw forbidden("tag_invalid", "标签不存在或不属于该账本。");
  }

  return unique;
}
