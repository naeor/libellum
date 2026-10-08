import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { registerHealthRoute, type HealthDeps } from "./routes/health.js";

export interface BuildAppOptions extends HealthDeps {
  readonly logger?: FastifyServerOptions["logger"];
}

/**
 * Build a fully wired Fastify instance without starting a listener.
 *
 * Keeping construction separate from `listen()` is what lets integration tests
 * exercise real routes through `app.inject()` — no port, no network, no flakiness.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  registerHealthRoute(app, options);

  return app;
}
