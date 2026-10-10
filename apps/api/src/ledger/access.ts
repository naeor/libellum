import { UNCATEGORISED_NAME, type TransactionKind } from "@libellum/shared";

import type { PrismaClient } from "../db.js";
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
 * The book this account owns.
 *
 * v1 gives every account exactly one book, so "the user's book" is well
 * defined. When sharing arrives, this becomes "the book selected in the
 * request", and only this function changes.
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
