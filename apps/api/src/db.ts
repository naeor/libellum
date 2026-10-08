import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export { PrismaClient };

/**
 * Create the single Prisma client instance for this process.
 *
 * Prisma 7 requires a driver adapter, so the connection is handed to `pg`
 * through `PrismaPg` rather than being read from the schema file. One client
 * per process: multiple instances would open multiple connection pools.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({ adapter });
}
