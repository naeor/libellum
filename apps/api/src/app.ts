import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { LoginThrottle, type LoginThrottleOptions } from "./auth/login-throttle.js";
import type { PrismaClient } from "./db.js";
import { forbidden, registerErrorHandlers } from "./lib/errors.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoute, type HealthDeps } from "./routes/health.js";

export interface BuildAppOptions extends HealthDeps {
  readonly logger?: FastifyServerOptions["logger"];
  /** Required for the auth routes; omit only in tests that do not touch accounts. */
  readonly prisma?: PrismaClient;
  readonly webOrigin?: string;
  readonly cookieSecure?: boolean;
  readonly loginThrottleOptions?: LoginThrottleOptions;
}

const DEFAULT_THROTTLE: LoginThrottleOptions = {
  maxFailures: 5,
  lockoutMs: 60_000,
  windowMs: 15 * 60_000,
};

/**
 * Build a fully wired Fastify instance without starting a listener.
 *
 * Keeping construction separate from `listen()` is what lets integration tests
 * exercise real routes through `app.inject()` — no port, no network, no flakiness.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: true,
  });

  registerErrorHandlers(app);

  void app.register(cookie);
  void app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  const webOrigin = options.webOrigin ?? "http://localhost:5173";

  /**
   * Defence in depth against CSRF.
   *
   * The session cookie is SameSite=Lax, so a browser will not attach it to a
   * cross-site POST. This hook adds a second lock: a state-changing request
   * that carries an Origin header from somewhere else is rejected outright.
   */
  app.addHook("onRequest", async (request) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      return;
    }

    const origin = request.headers.origin;
    if (origin !== undefined && origin !== webOrigin) {
      throw forbidden("origin_not_allowed", "请求来源不被允许");
    }
  });

  registerHealthRoute(app, options);

  if (options.prisma) {
    registerAuthRoutes(app, {
      prisma: options.prisma,
      throttle: new LoginThrottle(options.loginThrottleOptions ?? DEFAULT_THROTTLE),
      cookieSecure: options.cookieSecure ?? false,
    });
  }

  return app;
}
