import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // The auth suite shares one PostgreSQL database, so files run one at a time.
    fileParallelism: false,
  },
});
