import { ledgerMetaResponseSchema } from "@libellum/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { PrismaClient } from "../db.js";
import { currentBookId } from "../ledger/access.js";

export interface LedgerRouteOptions {
  readonly prisma: PrismaClient;
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
}

/**
 * Everything the record-an-entry screen needs, in one request.
 *
 * The form needs the book, both category lists, the payment methods and the
 * tags before it can render. Fetching them separately would mean four round
 * trips on a phone, which is exactly the wrong place to spend them.
 */
export function registerLedgerRoutes(app: FastifyInstance, options: LedgerRouteOptions): void {
  const { prisma, requireAuth } = options;

  app.get("/api/v1/ledger", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    const bookId = await currentBookId(prisma, userId);

    const [book, categories, paymentMethods, tags] = await Promise.all([
      prisma.book.findUniqueOrThrow({ where: { id: bookId }, select: { id: true, name: true } }),
      prisma.category.findMany({
        where: { bookId },
        orderBy: [{ kind: "asc" }, { sortOrder: "asc" }],
        select: {
          id: true,
          name: true,
          kind: true,
          description: true,
          isSystem: true,
          isArchived: true,
          sortOrder: true,
        },
      }),
      prisma.paymentMethod.findMany({
        where: { bookId },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, isArchived: true, sortOrder: true },
      }),
      prisma.tag.findMany({
        where: { bookId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, color: true },
      }),
    ]);

    return ledgerMetaResponseSchema.parse({ book, categories, paymentMethods, tags });
  });
}
