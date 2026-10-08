// Prisma 7 moved the connection URL out of schema.prisma and into this config
// file, and made driver adapters mandatory for the client.
//
// `dotenv/config` is imported first so that DATABASE_URL is available to the
// Prisma CLI from the repo-root .env (which is git-ignored).

import "dotenv/config";

import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
