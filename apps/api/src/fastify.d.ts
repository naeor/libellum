import type { SessionUser } from "@libellum/shared";

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by the requireAuth guard; undefined on public routes. */
    currentUser?: SessionUser;
  }
}
