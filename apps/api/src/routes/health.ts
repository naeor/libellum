import { healthResponseSchema } from "@libellum/shared";
import type { FastifyInstance } from "fastify";

/** Everything the health route needs from the outside world. */
export interface HealthDeps {
  /** Resolves to `true` when the database answers, `false` otherwise. */
  readonly checkDatabase: () => Promise<boolean>;
  /** Version string reported back to callers. */
  readonly version: string;
}

/**
 * `GET /api/v1/health`
 *
 * Deliberately reports process health and database health separately: the
 * process can be up while the database is unreachable, and the caller usually
 * wants to tell those two apart. Always answers 200 so that a probe can read
 * the body instead of guessing from the status code.
 */
export function registerHealthRoute(app: FastifyInstance, deps: HealthDeps): void {
  app.get("/api/v1/health", async () => {
    let databaseUp = false;
    try {
      databaseUp = await deps.checkDatabase();
    } catch {
      databaseUp = false;
    }

    return healthResponseSchema.parse({
      ok: true,
      service: "libellum-api",
      version: deps.version,
      database: databaseUp ? "up" : "down",
      timestamp: new Date().toISOString(),
    });
  });
}
