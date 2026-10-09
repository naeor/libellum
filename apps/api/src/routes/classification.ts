import {
  createCategorySchema,
  createPaymentMethodSchema,
  createTagSchema,
  updateCategorySchema,
  updatePaymentMethodSchema,
  updateTagSchema,
} from "@libellum/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { PrismaClient } from "../db.js";
import { currentBookId } from "../ledger/access.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";

export interface ClassificationRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
}

const CATEGORY_FIELDS = {
  id: true,
  name: true,
  kind: true,
  isSystem: true,
  isArchived: true,
  sortOrder: true,
} as const;

const PAYMENT_METHOD_FIELDS = {
  id: true,
  name: true,
  isArchived: true,
  sortOrder: true,
} as const;

const TAG_FIELDS = { id: true, name: true, color: true } as const;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Managing the three things that organise entries: categories, payment methods
 * and tags.
 *
 * The shared rule, and the reason all three live in one file: **nothing here
 * is ever really deleted.** A category or payment method is archived, because
 * past entries still point at it and must keep rendering; a tag may be removed
 * outright, because removing a label does not change any amount.
 */
export function registerClassificationRoutes(
  app: FastifyInstance,
  options: ClassificationRouteOptions,
): void {
  const { prisma, requireAuth } = options;

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------
  app.post("/api/v1/categories", { preHandler: requireAuth }, async (request, reply) => {
    const body = createCategorySchema.parse(request.body);
    const bookId = await currentBookId(prisma, request.currentUser!.id);

    // New items go last unless the client says otherwise.
    const highest = await prisma.category.aggregate({
      where: { bookId, kind: body.kind },
      _max: { sortOrder: true },
    });

    try {
      const created = await prisma.category.create({
        data: {
          bookId,
          name: body.name,
          kind: body.kind,
          sortOrder: body.sortOrder ?? (highest._max.sortOrder ?? -1) + 1,
        },
        select: CATEGORY_FIELDS,
      });

      reply.status(201);
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("category_exists", "同类型下已经有同名分类了。");
      }
      throw error;
    }
  });

  app.patch("/api/v1/categories/:id", { preHandler: requireAuth }, async (request) => {
    const body = updateCategorySchema.parse(request.body);
    const bookId = await currentBookId(prisma, request.currentUser!.id);
    const { id } = request.params as { id: string };

    const existing = await prisma.category.findFirst({
      where: { id, bookId },
      select: { id: true, isSystem: true },
    });

    if (!existing) throw notFound("category_missing", "找不到该分类。");
    // 暂无分类 is infrastructure, not user data.
    if (existing.isSystem) throw forbidden("category_system", "系统分类不可修改。");

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data["name"] = body.name;
    if (body.sortOrder !== undefined) data["sortOrder"] = body.sortOrder;
    if (body.isArchived !== undefined) data["isArchived"] = body.isArchived;

    try {
      return await prisma.category.update({ where: { id }, data, select: CATEGORY_FIELDS });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("category_exists", "同类型下已经有同名分类了。");
      }
      throw error;
    }
  });

  /**
   * Archiving, not deleting: entries recorded months ago still reference this
   * category and must keep showing its name.
   */
  app.delete("/api/v1/categories/:id", { preHandler: requireAuth }, async (request, reply) => {
    const bookId = await currentBookId(prisma, request.currentUser!.id);
    const { id } = request.params as { id: string };

    const existing = await prisma.category.findFirst({
      where: { id, bookId },
      select: { id: true, isSystem: true },
    });

    if (!existing) throw notFound("category_missing", "找不到该分类。");
    if (existing.isSystem) throw forbidden("category_system", "系统分类不可删除。");

    await prisma.category.update({ where: { id }, data: { isArchived: true } });

    reply.status(204);
    return null;
  });

  // -------------------------------------------------------------------------
  // Payment methods
  // -------------------------------------------------------------------------
  app.post("/api/v1/payment-methods", { preHandler: requireAuth }, async (request, reply) => {
    const body = createPaymentMethodSchema.parse(request.body);
    const bookId = await currentBookId(prisma, request.currentUser!.id);

    const highest = await prisma.paymentMethod.aggregate({
      where: { bookId },
      _max: { sortOrder: true },
    });

    try {
      const created = await prisma.paymentMethod.create({
        data: {
          bookId,
          name: body.name,
          sortOrder: body.sortOrder ?? (highest._max.sortOrder ?? -1) + 1,
        },
        select: PAYMENT_METHOD_FIELDS,
      });

      reply.status(201);
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("payment_method_exists", "已经有同名支付方式了。");
      }
      throw error;
    }
  });

  app.patch("/api/v1/payment-methods/:id", { preHandler: requireAuth }, async (request) => {
    const body = updatePaymentMethodSchema.parse(request.body);
    const bookId = await currentBookId(prisma, request.currentUser!.id);
    const { id } = request.params as { id: string };

    const existing = await prisma.paymentMethod.findFirst({ where: { id, bookId }, select: { id: true } });
    if (!existing) throw notFound("payment_method_missing", "找不到该支付方式。");

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data["name"] = body.name;
    if (body.sortOrder !== undefined) data["sortOrder"] = body.sortOrder;
    if (body.isArchived !== undefined) data["isArchived"] = body.isArchived;

    try {
      return await prisma.paymentMethod.update({ where: { id }, data, select: PAYMENT_METHOD_FIELDS });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("payment_method_exists", "已经有同名支付方式了。");
      }
      throw error;
    }
  });

  app.delete("/api/v1/payment-methods/:id", { preHandler: requireAuth }, async (request, reply) => {
    const bookId = await currentBookId(prisma, request.currentUser!.id);
    const { id } = request.params as { id: string };

    const existing = await prisma.paymentMethod.findFirst({ where: { id, bookId }, select: { id: true } });
    if (!existing) throw notFound("payment_method_missing", "找不到该支付方式。");

    await prisma.paymentMethod.update({ where: { id }, data: { isArchived: true } });

    reply.status(204);
    return null;
  });

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------
  app.post("/api/v1/tags", { preHandler: requireAuth }, async (request, reply) => {
    const body = createTagSchema.parse(request.body);
    const bookId = await currentBookId(prisma, request.currentUser!.id);

    try {
      const created = await prisma.tag.create({
        data: { bookId, name: body.name, color: body.color },
        select: TAG_FIELDS,
      });

      reply.status(201);
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("tag_exists", "已经有同名标签了。");
      throw error;
    }
  });

  app.patch("/api/v1/tags/:id", { preHandler: requireAuth }, async (request) => {
    const body = updateTagSchema.parse(request.body);
    const bookId = await currentBookId(prisma, request.currentUser!.id);
    const { id } = request.params as { id: string };

    const existing = await prisma.tag.findFirst({ where: { id, bookId }, select: { id: true } });
    if (!existing) throw notFound("tag_missing", "找不到该标签。");

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data["name"] = body.name;
    if (body.color !== undefined) data["color"] = body.color;

    try {
      return await prisma.tag.update({ where: { id }, data, select: TAG_FIELDS });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("tag_exists", "已经有同名标签了。");
      throw error;
    }
  });

  /**
   * A tag really is deleted — removing a label does not alter any amount, so
   * there is nothing to preserve. The entries themselves are untouched; only
   * the links go. The count comes back so the interface can say how many
   * entries were affected before the user commits.
   */
  app.delete("/api/v1/tags/:id", { preHandler: requireAuth }, async (request) => {
    const bookId = await currentBookId(prisma, request.currentUser!.id);
    const { id } = request.params as { id: string };

    const existing = await prisma.tag.findFirst({ where: { id, bookId }, select: { id: true } });
    if (!existing) throw notFound("tag_missing", "找不到该标签。");

    const affectedEntries = await prisma.transactionTag.count({ where: { tagId: id } });

    await prisma.tag.delete({ where: { id } });

    return { affectedEntries };
  });
}
