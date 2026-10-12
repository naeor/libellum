import type { Prisma } from "../generated/prisma/client.js";

import { takeNextBookNumber } from "../auth/recovery-code.js";
import {
  DEFAULT_BOOK_NAME,
  PAYMENT_METHOD_NAMES,
  UNCATEGORISED,
  categoriesFor,
} from "./presets.js";

type Client = Prisma.TransactionClient;

/**
 * Give an account a ledger: one book, the membership row, the preset categories and the default
 * payment methods.
 *
 * ⚠️ **Used twice now** — once inside the registration transaction, and once when somebody makes
 * a *second* ledger. That is why the name is a parameter rather than a constant: a second book
 * called "我的账本" alongside an existing "我的账本" is indistinguishable on the home screen.
 *
 * ⚠️ **Nothing is copied between ledgers.** A new book gets its own presets, so customising one
 * does not leak into the other.
 *
 * @returns the new book's id
 */
export async function createDefaultLedger(
  client: Client,
  userId: string,
  name: string = DEFAULT_BOOK_NAME,
): Promise<string> {
  const book = await client.book.create({
    data: {
      name,
      createdBy: userId,
      bookNumber: await takeNextBookNumber(client),
    },
    select: { id: true },
  });

  /**
   * ⚠️ **`role: "editor"` is written explicitly, and that is the owner's instruction.**
   *
   * The column's default is `viewer` (it used to be `owner`, which meant a
   * forgotten role handed out ownership). **Changing the default is not enough**:
   * the person who creates a ledger must be able to use it, so the grant is
   * spelled out here rather than inherited from whatever the default happens to
   * be. A ledger whose only member is a viewer is a dead ledger — nobody can
   * write in it and nobody can hand the right back.
   *
   * `owner` is no longer written anywhere: the two roles are `editor` and
   * `viewer`. The migration converted the rows that still said `owner`.
   */
  await client.bookMember.create({
    data: { bookId: book.id, userId, role: "editor" },
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
      // The hidden fallback needs no explanation; the presets do.
      description: preset.name === UNCATEGORISED.name ? null : preset.description,
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
