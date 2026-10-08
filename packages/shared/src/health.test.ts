import { describe, expect, it } from "vitest";

import { healthResponseSchema } from "./health.js";

const VALID = {
  ok: true,
  service: "libellum-api",
  version: "0.1.0",
  database: "up",
  timestamp: "2026-10-08T07:00:00.000Z",
} as const;

describe("healthResponseSchema", () => {
  it("accepts a well-formed payload", () => {
    expect(healthResponseSchema.parse(VALID)).toEqual(VALID);
  });

  it("rejects an unknown database state", () => {
    expect(() => healthResponseSchema.parse({ ...VALID, database: "maybe" })).toThrow();
  });

  it("rejects a wrong service name", () => {
    expect(() => healthResponseSchema.parse({ ...VALID, service: "other-api" })).toThrow();
  });
});
