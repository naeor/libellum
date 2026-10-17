import { APP_VERSION } from "@libellum/shared";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const VERSION = "0.1.0-test";

describe("GET /api/v1/health", () => {
  it("answers 200 and reports the database as up", async () => {
    const app = buildApp({ version: VERSION, checkDatabase: async () => true });

    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      service: "libellum-api",
      version: VERSION,
      database: "up",
    });

    await app.close();
  });

  it("reports the database as down when the check returns false", async () => {
    const app = buildApp({ version: VERSION, checkDatabase: async () => false });

    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, database: "down" });

    await app.close();
  });

  it("stays healthy when the database check throws", async () => {
    const app = buildApp({
      version: VERSION,
      checkDatabase: async () => {
        throw new Error("connection refused");
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, database: "down" });

    await app.close();
  });

  it("returns 404 for unknown routes", async () => {
    const app = buildApp({ version: VERSION, checkDatabase: async () => true });

    const response = await app.inject({ method: "GET", url: "/api/v1/nope" });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});

/**
 * **`/health` must name the version people actually see.**
 *
 * ⚠️ **The route already echoed whatever it was handed — the wrong number was handed to it.**
 * `src/server.ts` passed `process.env["npm_package_version"] ?? "0.1.0"`, which is
 * `apps/api/package.json`'s version: it says nothing about which build is deployed, so
 * *"which version is running"* could only be answered by reading a file on the server.
 *
 * The first test below is the route's half; the second is the wiring's half, read from the
 * source because the alternative — importing `server.ts` — would call `listen()` in the test.
 */
describe("the version /health reports", () => {
  it("echoes the shared APP_VERSION when that is what the server was built with", async () => {
    const app = buildApp({ version: APP_VERSION, checkDatabase: async () => true });

    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ version: APP_VERSION });
    /**
     * ⚠️ **And it is not the API package's own version**, which is the value that used to be
     * reported and the one somebody reading `/health` would have been misled by.
     */
    expect(response.json().version).not.toBe("0.1.0");

    await app.close();
  });

  it("is wired to shared's APP_VERSION in server.ts, not to npm_package_version", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

    expect(server).toContain("version: APP_VERSION");
    /**
     * ⚠️ 禁的是**读那个环境变量**，不是提到它：`server.ts` 的注释解释了为什么不再用它，
     * 而注释正是下一个人需要留着的。
     */
    expect(server).not.toContain('process.env["npm_package_version"]');
  });

  it("is a three-part number, so two builds can be compared", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
