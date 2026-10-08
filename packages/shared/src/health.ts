import { z } from "zod";

/** Name and version of the running API build, as reported by the health check. */
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal("libellum-api"),
  version: z.string(),
  database: z.enum(["up", "down"]),
  timestamp: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
