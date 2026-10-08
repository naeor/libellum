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
