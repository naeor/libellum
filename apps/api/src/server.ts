import { APP_VERSION } from "@libellum/shared";
import { buildApp } from "./app.js";
import { createPrismaClient } from "./db.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const app = buildApp({
  /**
   * ⚠️ **`/health` 报告的版本来自 `shared`，不是 `npm_package_version`。**
   *
   * 后者是 `apps/api/package.json` 的版本（`0.1.0`），与用户看到的版本号无关，于是
   * "服务器上跑的是哪一版"只能靠登录服务器读文件回答。`APP_VERSION` 是网页与应用共用的
   * 那一个数（见 `packages/shared/src/version.ts`），让一次 `curl /health` 就能回答。
   */
  version: APP_VERSION,
  logger: { level: env.nodeEnv === "production" ? "info" : "debug" },
  prisma,
  webOrigin: env.webOrigin,
  cookieSecure: env.cookieSecure,
  loginThrottleOptions: {
    maxFailures: env.loginMaxFailures,
    lockoutMs: env.loginLockoutMs,
    windowMs: env.loginWindowMs,
  },
  checkDatabase: async () => {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  },
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: env.apiHost, port: env.apiPort });
} catch (error) {
  app.log.error(error, "failed to start");
  await prisma.$disconnect();
  process.exit(1);
}
