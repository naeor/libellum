import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../src/db.js";
import { registerTransactionRoutes } from "../src/routes/transactions.js";
import { registerErrorHandlers } from "../src/lib/errors.js";

// Exercise real HTTP validation, conflict judgement and settlement routes without touching a database.
describe("two-device conflict HTTP protocol", () => {
  it.each([2000, 8000])("settles test十 to %s cents and removes the shared conflict", async (chosen: number) => {
    const id = "12345678-1234-4123-8123-123456789012";
    const categoryId = "12345678-1234-4123-8123-123456789013";
    let row = { id, bookId: "book", kind: "expense", amountCents: 1000n, currency: "CNY", categoryId,
      paymentMethodId: null, occurredAt: new Date("2026-10-11T12:00:00Z"), occurredLocalDate: new Date("2026-10-11"),
      occurredTz: "Asia/Shanghai", note: "test十", version: 1, valueHistory: [],
      category: { id: categoryId, name: "餐饮", isSystem: false }, paymentMethod: null, tags: [] };
    let conflicts: Record<string, any>[] = [];
    const resolutions: Record<string, any>[] = [];
    const prisma = {
      bookMember: { findFirst: async () => ({ bookId: "book" }) },
      category: { findFirst: async () => ({ ...row.category, kind: row.kind }) },
      transaction: {
        findFirst: async () => row,
        findMany: async () => [row],
        update: async ({ data }: { data: Record<string, unknown> }) => { row = { ...row, ...data }; return row; },
      },
      transactionConflict: {
        findFirst: async () => conflicts[0] ?? null,
        findMany: async () => conflicts,
        create: async ({ data }: { data: Record<string, unknown> }) => { const conflict = { ...data, id: "conflict", createdAt: new Date() }; conflicts.push(conflict); return conflict; },
        update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(conflicts[0]!, data); return conflicts[0]; },
        delete: async () => { conflicts = []; },
      },
      conflictResolution: { create: async ({ data }: { data: Record<string, unknown> }) => { resolutions.push(data); return data; } },
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
    };
    const app = Fastify();
    registerErrorHandlers(app);
    registerTransactionRoutes(app, { prisma: prisma as unknown as PrismaClient, requireAuth: async request => {
      request.currentUser = { id: "user" } as NonNullable<typeof request.currentUser>;
    } });
    try {
      const patch = (device: string, amount: number, base: number, settlesConflict = false) => app.inject({
        method: "PATCH", url: `/api/v1/transactions/${id}`, headers: { "x-libellum-device": device },
        payload: { version: 2, amountCents: amount, categoryId, settlesConflict,
          changes: [{ field: "amountCents", base, wanted: amount, chain: [base, amount] }] },
      });
      expect((await patch("phone", 8000, 1000)).statusCode).toBe(200);
      const refused = await patch("ipad", 2000, 1000);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().details.conflicts[0].claims[0].chain).toEqual([1000, 2000]);
      const listing = await app.inject({ method: "GET", url: "/api/v1/conflicts" });
      expect(listing.json().conflicts[0].current.amountCents).toBe(8000);
      expect(listing.json().conflicts[0].fields[0].claims[0].deviceId).toBe("ipad");
      const settled = await patch("phone", chosen, 8000, true);
      expect(settled.statusCode).toBe(200);
      expect(settled.json().amountCents).toBe(chosen);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(resolutions[0]?.resolvedValue).toBe(chosen);
      expect((await app.inject({ method: "GET", url: "/api/v1/conflicts" })).json().conflicts).toEqual([]);
      // A repeated delivery after a lost response also succeeds.
      expect((await patch("phone", chosen, 8000, true)).statusCode).toBe(200);
      expect(resolutions).toHaveLength(1);
    } finally { await app.close(); }
  });
});
