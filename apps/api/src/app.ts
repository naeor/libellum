import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { MAX_RECOGNIZE_BYTES, MAX_RECOGNIZE_IMAGES } from "@libellum/shared";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { createRequireAuth } from "./auth/guard.js";
import { LoginThrottle, type LoginThrottleOptions } from "./auth/login-throttle.js";
import type { PrismaClient } from "./db.js";
import { forbidden, registerErrorHandlers } from "./lib/errors.js";
import { OcrService } from "./ocr/client.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerClassificationRoutes } from "./routes/classification.js";
import { registerExportRoutes } from "./routes/export.js";
import { registerHealthRoute, type HealthDeps } from "./routes/health.js";
import { registerImportRoutes } from "./routes/import.js";
import { registerLedgerRoutes } from "./routes/ledger.js";
import { registerRecognizeRoutes } from "./routes/recognize.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerTransactionRoutes } from "./routes/transactions.js";
import { registerVoiceRoutes } from "./routes/voice.js";
import { VoiceService } from "./voice/client.js";

export interface BuildAppOptions extends HealthDeps {
  readonly logger?: FastifyServerOptions["logger"];
  /** Required for the auth routes; omit only in tests that do not touch accounts. */
  readonly prisma?: PrismaClient;
  readonly webOrigin?: string;
  readonly cookieSecure?: boolean;
  readonly loginThrottleOptions?: LoginThrottleOptions;
  /**
   * Screenshot recogniser. Supplied by tests as a stub; the real one spawns a
   * Python process, which is not something a unit test should depend on.
   */
  readonly ocr?: Pick<OcrService, "recognize" | "stop">;
  /**
   * The speech recogniser, for the same reason: it is a long-lived Python
   * process, and a test that does not exercise transcription should not have to
   * have a 147 MB model on disk.
   */
  readonly voice?: Pick<VoiceService, "transcribe" | "stop">;
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
  // Screenshots are read into memory; the limits are declared here as well so
  // an oversized upload is refused while it is still arriving rather than
  // after it has all been buffered.
  //
  // The file count is a backstop, deliberately higher than the limit the route
  // enforces. The plugin's own error is a bare 413 with no explanation; the
  // route can say how many screenshots are allowed, which is the part a user
  // can act on. This still stops a hundred-file upload before it is buffered.
  void app.register(multipart, {
    limits: {
      fileSize: MAX_RECOGNIZE_BYTES,
      files: MAX_RECOGNIZE_IMAGES + 5,
    },
  });
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
   *
   * "Somewhere else" is judged by comparing against the Host the request
   * arrived on, not against a fixed URL. A request from this very server is
   * same-origin by definition — which is what lets the app run on
   * `localhost`, on a LAN address for phone testing, or behind a tunnel
   * without teaching the server about each of those addresses in advance.
   */
  app.addHook("onRequest", async (request) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      return;
    }

    const origin = request.headers.origin;
    if (origin === undefined) return;

    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === request.headers.host;
    } catch {
      sameOrigin = false;
    }

    if (!sameOrigin && origin !== webOrigin) {
      // Log the pair, not just the fact of the rejection. Diagnosing a rejected
      // write from the client side alone is guesswork: the browser shows the
      // wrapper's fallback text, which says "网络连接异常" whatever actually went
      // wrong, and the server used to answer with an unexplained 403. One line
      // here turns that into an answer.
      request.log.warn(
        { origin, host: request.headers.host, path: request.url },
        "state-changing request rejected: origin does not match the host it arrived on",
      );

      // The message names the address the request actually came from. That is
      // safe — it is the caller's own address — and it is the one fact that
      // makes the problem fixable by whoever is holding the phone.
      throw forbidden(
        "origin_not_allowed",
        `请求来源不被允许：浏览器报告 ${origin}，而请求到达的地址是 ${String(request.headers.host)}。` +
          "如果你是通过 IP 或另一个域名访问，请用同一个地址打开页面。",
      );
    }
  });

  registerHealthRoute(app, options);

  if (options.prisma) {
    const requireAuth = createRequireAuth(options.prisma);

    /**
     * Started on first use, not here.
     *
     * The recogniser holds a few hundred megabytes of models. A deployment
     * that never uploads a screenshot should not pay for that, and the two
     * seconds of loading are better spent once, behind the first request,
     * than on every server start.
     *
     * Injectable so tests can supply a stub. Loading real models in every test
     * run would add a minute to the suite and couple the API's tests to a
     * Python environment being installed.
     */
    const ocr = options.ocr ?? new OcrService();
    app.addHook("onClose", () => {
      ocr.stop();
    });

    const voice = options.voice ?? new VoiceService();
    app.addHook("onClose", () => {
      voice.stop();
    });

    registerAuthRoutes(app, {
      prisma: options.prisma,
      throttle: new LoginThrottle(options.loginThrottleOptions ?? DEFAULT_THROTTLE),
      cookieSecure: options.cookieSecure ?? false,
    });

    registerLedgerRoutes(app, { prisma: options.prisma, requireAuth });
    registerTransactionRoutes(app, { prisma: options.prisma, requireAuth });
    registerStatsRoutes(app, { prisma: options.prisma, requireAuth });
    registerClassificationRoutes(app, { prisma: options.prisma, requireAuth });
    registerRecognizeRoutes(app, { requireAuth, ocr });
    registerVoiceRoutes(app, { requireAuth, voice });
    registerExportRoutes(app, { prisma: options.prisma, requireAuth });
    registerImportRoutes(app, { prisma: options.prisma, requireAuth });
  }

  return app;
}
