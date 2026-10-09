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
 * nonsense. No choice at all is not an error: it falls back to the book's
 * hidden 暂无分类 for that kind, which is why `category_id` can stay mandatory.
 */
export async function resolveCategoryId(
  prisma: PrismaClient,
  bookId: string,
  kind: TransactionKind,
  requested: string | null | undefined,
): Promise<string> {
  if (requested) {
    const category = await prisma.category.findFirst({
      where: { id: requested, bookId, kind },
      select: { id: true },
    });

    if (!category) throw forbidden("category_invalid", "分类不存在或不属于该账本。");

    return category.id;
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
