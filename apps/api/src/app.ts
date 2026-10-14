import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { MAX_RECOGNIZE_BYTES, MAX_RECOGNIZE_IMAGES } from "@libellum/shared";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { createRequireAdmin } from "./admin/guard.js";
import { createRequireAuth, createRequireBook } from "./auth/guard.js";
import { LoginThrottle, type LoginThrottleOptions } from "./auth/login-throttle.js";
import type { PrismaClient } from "./db.js";
import { forbidden, registerErrorHandlers } from "./lib/errors.js";
import { OcrService } from "./ocr/client.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBooksRoutes } from "./routes/books.js";
import { registerClassificationRoutes } from "./routes/classification.js";
import { registerDirectoryRoutes } from "./routes/directory.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerShareRoutes } from "./routes/share.js";
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
  /**
   * ⚠️ **Test-only.** Registers one route behind `createRequireAdmin`, so the admin guard
   * can be exercised end to end — through a real session, a real cookie and a real refusal
   * — rather than only as a function.
   *
   * ⚠️ **Off unless a caller asks, and the production bootstrap never asks.** The brief is
   * explicit that no admin API should be exposed merely to prove the guard works, and the
   * honest way to honour that is for the route to **not exist** in a normal build rather
   * than to exist behind a flag that somebody could flip. `src/server.ts` does not pass
   * this option and there is no environment variable that sets it; the only caller is
   * `test/admin.test.ts`.
   *
   * ⚠️ **It deliberately does nothing but report who the guard decided you are.** A test
   * route that performed a real administrative action would need a real administrative
   * action to exist, and this round has none by design — see
   * `docs/管理员与权限边界-设计决定.md` §6.
   */
  readonly enableTestAdminRoute?: boolean;
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

    /**
     * ⚠️ **Ledgers themselves are registered with plain auth, and that is not a weaker check.**
     *
     * Every other route answers a question *inside* one ledger, so it can be guarded by asking
     * whether the caller may be in the ledger they named. These routes are how a caller discovers
     * which ledgers exist — a request asking "which books do I have" has no book to name, and
     * requiring one would be a circle. Each of them checks `book_members` for the specific book it
     * touches, and creating one grants `editor` explicitly.
     */
    registerBooksRoutes(app, { prisma: options.prisma, requireAuth });

    /**
     * ⚠️ **The account directory, referral codes and notifications are registered with plain auth.**
     *
     * Looking somebody up and minting a referral code are **account-level** questions — they must
     * work with no ledger in hand (the account screen, and a home page where "当前账本为空"). The
     * routes that *do* need a ledger — inviting somebody into one — resolve and check it themselves
     * (`requireBookForWrite`), so the guard is not weaker, it is simply not where that question is
     * asked.
     *
     * ⚠️ **`registerCollabRoutes` is gone.** It carried the account-level collaborator system, which
     * was removed in 1.10.05 — a ledger invitation no longer has an account-level relationship in
     * front of it. `POST /books/invite` moved next to the other ledger routes in `books.ts`.
     */
    registerDirectoryRoutes(app, { prisma: options.prisma, requireAuth });
    registerNotificationRoutes(app, { prisma: options.prisma, requireAuth });

    /**
     * ⚠️ **Share links are registered with plain auth, and each route resolves its own ledger.**
     * They live on a prefix whose ledger arrives in the body or in the token rather than in a
     * header — and `/share/:token` is the one route that *cannot* name a ledger, because the person
     * holding a link does not know which ledger it opens yet. That is the whole point of a link.
     */
    registerShareRoutes(app, { prisma: options.prisma, requireAuth });

    /**
     * ⚠️ **Two guards, and which one a route gets is the whole permission model.**
     *
     * `requireAuth` asks who is calling. It is for routes that are not *about* a particular
     * ledger — creating one, listing them, signing in — so there is nothing else to check.
     *
     * `requireBook` asks whether the caller may touch **the ledger they named**, which is what
     * makes `book_members` the only source of permission. It comes in two strengths:
     *
     * * **read** — membership is enough, and `viewer` is a full member;
     * * **write** — the role is checked too, so a viewer's write fails **on the server** rather
     *   than only in the UI. The owner asked for exactly that: *"即使 viewer 通过某种方式发起了
     *   更改，服务器的数据也不会被污染."*
     *
     * ⚠️ **Every ledger-scoped route must be registered with one of these.** A route that reads
     * `request.book!.bookId` while registered with the plain auth guard would throw at runtime,
     * which is why the two changed together.
     */
    const requireBookRead = createRequireBook(options.prisma, requireAuth, { write: false });
    const requireBookWrite = createRequireBook(options.prisma, requireAuth, { write: true });

    /**
     * ⚠️ **The ledger's own metadata is a *read* route, and it was a write route until 1.10.08.**
     *
     * The old note here argued it should stay a write "until the viewer/editor distinction is drawn",
     * because a viewer's copy would be identical to an editor's. **That argument was about not
     * *leaking* the distinction — but the effect was that a viewer could not open 账本信息 at all**,
     * and now that the start page's gear panel links there for every member, it is a plain defect:
     * *"查看者不应获得编辑或邀请权限"* is the rule, and **reading a ledger's name and entry count is
     * not editing it.**
     *
     * ⚠️ **`requireBookRead` is the right strength**: it answers "may the caller see this ledger",
     * which is exactly what the route needs. Whether the caller may *write* is a separate question,
     * asked by the routes that write — and the response says nothing about it, so nothing leaks.
     */
    registerLedgerRoutes(app, {
      prisma: options.prisma,
      requireAuth: requireBookRead,
      /**
       * ⚠️ **The history read is handed the *read* guard**, because a viewer must be able to see who
       * changed what — the owner's rule is that a viewer sees everything except editing. Passing the
       * write guard for the whole module made `/ledger/history` answer **403 to every viewer**, which
       * a test caught rather than a review.
       */
      requireRead: requireBookRead,
    });
    registerTransactionRoutes(app, { prisma: options.prisma, requireAuth: requireBookWrite });
    registerStatsRoutes(app, { prisma: options.prisma, requireAuth: requireBookRead });
    registerClassificationRoutes(app, { prisma: options.prisma, requireAuth: requireBookWrite });
    registerRecognizeRoutes(app, { requireAuth: requireBookRead, ocr });
    registerVoiceRoutes(app, { requireAuth: requireBookWrite, prisma: options.prisma, voice });
    registerExportRoutes(app, { prisma: options.prisma, requireAuth: requireBookWrite });
    registerImportRoutes(app, { prisma: options.prisma, requireAuth: requireBookWrite });

    /**
     * ⚠️ **Test-only, and it exists nowhere unless a test asks for it.** See the note on
     * `enableTestAdminRoute` above: the admin guard has to be exercised through a real
     * request, and the alternative — shipping an admin endpoint nobody needs yet — is the
     * thing the brief forbids.
     *
     * The route reports the guard's decision and nothing else. It reads no ledger, touches
     * no user data and has no side effects, so even if it were somehow reachable it would
     * disclose only whether the caller is an administrator — which the caller already knows
     * if they are one.
     */
    if (options.enableTestAdminRoute === true) {
      const requireAdmin = createRequireAdmin(options.prisma, requireAuth);
      app.get("/api/v1/admin/self", { preHandler: requireAdmin }, async (request) => {
        // `adminActor` is set by the guard, which is what makes it safe to read here.
        const actor = request.adminActor;
        if (actor === undefined) {
          throw forbidden("admin_forbidden", "没有权限执行这个操作。");
        }
        return { ok: true, accountNumber: actor.accountNumber, username: actor.username };
      });
    }
  }

  return app;
}
