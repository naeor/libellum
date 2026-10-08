import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

/**
 * Integration tests talk to a real PostgreSQL database, so they must never be
 * pointed at the development one: the suite truncates tables between cases.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
config({ path: resolve(here, "../../../.env"), quiet: true });

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
if (testDatabaseUrl) {
  process.env["DATABASE_URL"] = testDatabaseUrl;
}

process.env["NODE_ENV"] = "test";
