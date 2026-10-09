import type { Prisma } from "../generated/prisma/client.js";

import {
  DEFAULT_BOOK_NAME,
  PAYMENT_METHOD_NAMES,
  UNCATEGORISED,
  categoriesFor,
} from "./presets.js";

type Client = Prisma.TransactionClient;

/**
 * Give a brand-new account its ledger: one book, the membership row, the
 * preset categories and the default payment methods.
 *
 * Runs inside the registration transaction, so a failure leaves no half-built
 * account behind — either the person has a usable ledger or they have nothing.
 *
 * @returns the new book's id
 */
export async function createDefaultLedger(client: Client, userId: string): Promise<string> {
  const book = await client.book.create({
    data: { name: DEFAULT_BOOK_NAME, createdBy: userId },
    select: { id: true },
  });

  await client.bookMember.create({
    data: { bookId: book.id, userId, role: "owner" },
  });

  // Income and expense each get their own list, and each list ends with the
  // hidden system category that collects entries saved without a choice.
  const categories = (["expense", "income"] as const).flatMap((kind) => {
    const presets = [...categoriesFor(kind), UNCATEGORISED];

    return presets.map((preset, index) => ({
      bookId: book.id,
      name: preset.name,
      kind,
      sortOrder: index,
      isSystem: preset.name === UNCATEGORISED.name,
    }));
  });

  await client.category.createMany({ data: categories });

  await client.paymentMethod.createMany({
    data: PAYMENT_METHOD_NAMES.map((name, index) => ({
      bookId: book.id,
      name,
      sortOrder: index,
    })),
  });

  return book.id;
}
