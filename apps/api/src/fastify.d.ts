import type { SessionUser } from "@libellum/shared";

import type { AdminActor } from "./admin/guard.js";
import type { BookContext } from "./ledger/access.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by the requireAuth guard; undefined on public routes. */
    currentUser?: SessionUser;

    /**
     * Who is administering the platform, when the route requires it.
     *
     * ⚠️ **Undefined is meaningful, and it is not "no permission".** It means the route is not
     * an admin route, so nothing asked. **An admin route must never see it undefined**: those
     * are registered with `createRequireAdmin`, which refuses before the handler runs.
     *
     * ⚠️ **Handler code must read the actor from here, not re-derive it.** The guard has
     * already resolved the identity from the verified session and checked the grant, the allow
     * list, the account status and first-batch qualification. A handler that looked the user up
     * again — or worse, read an id from the request — would be the second, subtly different
     * copy of an authorization rule that this project keeps writing down as the way holes
     * appear.
     */
    adminActor?: AdminActor;

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
