import type { Prisma } from "../generated/prisma/client.js";

/**
 * Handing out the number a person reads: `#000001`, `#000002`, …
 *
 * ⚠️ **The owner's rule, and it is the whole design**: *"所有的编号都由服务器统一分配——
 * 换言之，所有的账目都是在服务器同步时，由服务器给予的编号."*
 *
 * So the number is **not** minted where the entry is written. An entry created offline has no
 * number until it reaches the server, and it gets one at that moment — which is why nothing on the
 * client may invent one, and why this file has no counterpart on the web side.
 *
 * ⚠️ **The number is not the id.** He drew the distinction himself: *"编号跟之前的账目内部 ID 是
 * 不一样的……编号更多是给用户看的。**程序所有的操作仍然用内部 ID**."* Every route, every relation,
 * every offline mark still addresses entries by `id`; `seq` is a label that happens to be unique.
 *
 * ⚠️ **It cannot be edited.** Nothing in the API accepts a `seq` from a client — there is no field
 * for it in any request schema, and adding one would defeat the point of a server-assigned number.
 */

type Tx = Prisma.TransactionClient;

/**
 * Allocate the next number for one ledger.
 *
 * ⚠️ **One statement, and that is what makes it safe.** `UPDATE … RETURNING` takes a row lock on
 * the ledger that is **held until the surrounding transaction commits**, so two entries arriving
 * for the same ledger are serialised and cannot be handed the same number. Different ledgers lock
 * different rows, so **two families' ledgers never queue behind each other.**
 *
 * ⚠️ **This must be called inside the transaction that inserts the entry.** Called on its own, the
 * lock is released the instant the statement returns — the next caller would read the same value,
 * and both entries would be numbered identically. The unique constraint on `(book_id, seq)` would
 * then refuse the second insert, so the failure would be loud rather than silent — **but it would
 * be a bug that only appears under concurrency, which is the worst kind to find later.**
 *
 * ⚠️ **The counter is not `MAX(seq) + 1`.** A deleted entry keeps its number (a number is history),
 * so "the next number" is a fact of its own and is stored as one — `教训.md` §8.12.
 *
 * @returns the number this entry will carry, starting at `1`
 */
export async function allocateTransactionSeq(tx: Tx, bookId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ next_transaction_seq: number }[]>`
    UPDATE "books"
    SET "next_transaction_seq" = "next_transaction_seq" + 1
    WHERE "id" = ${bookId}::uuid
    RETURNING "next_transaction_seq"
  `;

  const row = rows[0];
  if (row === undefined) {
    /**
     * ⚠️ **A book that does not exist is a programming error here, not a user error.** Every caller
     * has already resolved the ledger from the request and checked membership, so reaching this
     * means the ledger was deleted between that check and this call — and **throwing is better than
     * returning a number that belongs to no ledger.**
     */
    throw new Error(`账本不存在，无法分配编号：${bookId}`);
  }

  /**
   * ⚠️ **`- 1` because the column means "the next one to hand out".** After the increment it holds
   * the number *after* ours, so ours is one less. Storing "next" rather than "last" means a freshly
   * created ledger needs no initialisation beyond its default of `1` — **the first entry is
   * `#000001` with no special case** (the owner: *"A 账本的第一个账目编号就是 #000001"*).
   */
  return row.next_transaction_seq - 1;
}

/**
 * The number as a person sees it: `#000001`.
 *
 * ⚠️ **Rendered here rather than stored.** The database holds `1`; the `#` and the zero padding are
 * presentation. **Storing `"#000001"` would put a formatting decision in the data**, and the first
 * time somebody wanted seven digits the stored strings would all have to be rewritten.
 *
 * ⚠️ **Six digits, so it overflows at a million entries — and it overflows loudly.** `String(1000000)`
 * is seven characters, so the label simply becomes `#1000000` rather than truncating or wrapping.
 * **A household ledger will not reach it; a genuinely busy one would rather get a longer number
 * than a repeated one.**
 */
export function formatTransactionNumber(seq: number): string {
  return `#${String(seq).padStart(6, "0")}`;
}
