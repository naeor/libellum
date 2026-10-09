import { defineConfig } from "vitest/config";

/**
 * Tests for the web app.
 *
 * The chart foundation is deliberately pure arithmetic, so most of it is
 * tested as plain functions. Components are checked by rendering them to
 * static markup — that needs no DOM, no jsdom and no testing library, and it
 * catches the failures that matter here: a chart that renders nothing, a label
 * that is never thinned, a legend that communicates by colour alone.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
