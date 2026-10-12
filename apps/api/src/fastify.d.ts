import type { SessionUser } from "@libellum/shared";

import type { BookContext } from "./ledger/access.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by the requireAuth guard; undefined on public routes. */
    currentUser?: SessionUser;

    /**
     * Which ledger this request is about, and what the caller may do in it.
     *
     * ⚠️ **Undefined is meaningful, and it is not "no permission".** It means the route does not
     * touch a particular ledger — creating one, listing them, signing in — so there is nothing
     * to check. **A ledger-scoped route must never see it undefined**: those are registered with
     * `createRequireBook`, which refuses the request before it runs.
     *
     * ⚠️ **Routes must read `request.book.bookId` rather than calling `currentBookId`.** The
     * latter answers "which ledger does this account have", which stopped having one answer the
     * moment an account could have several.
     */
    book?: BookContext;
  }
}
