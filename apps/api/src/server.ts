import { buildApp } from "./app.js";
import { createPrismaClient } from "./db.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const prisma = createPrismaClient(env.databaseUrl);

const app = buildApp({
  version: process.env["npm_package_version"] ?? "0.1.0",
  logger: { level: env.nodeEnv === "production" ? "info" : "debug" },
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
