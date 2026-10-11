import type { Transaction } from "@libellum/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ConflictScreen } from "../../components/ConflictScreen.js";
import { ApiRequestError, apiFetch } from "../api.js";
import { readMarks, readStoredMonths, setMark, upsertEntry, conflictsValue } from "./localLedger.js";
import { pullConflicts, syncAll, syncMonth } from "./sync.js";
import { applyConflictChoices, conflictQuestions } from "./conflictChoices.js";
import { resolveConflict } from "./write.js";

vi.mock("../api.js", async (original) => ({ ...await original<typeof import("../api.js")>(), apiFetch: vi.fn() }));
vi.mock("./diagnostics.js", () => ({ logOffline: vi.fn(async () => undefined) }));
vi.mock("./storage.js", () => {
  const data = new Map<string, unknown>();
  return {
    readSnapshot: (key: string) => data.get(key) ?? null,
    readValue: async (key: string) => data.get(key) ?? null,
    writeValue: async (key: string, value: unknown) => { data.set(key, value); return true; },
  };
});

const id = "12345678-1234-4123-8123-123456789012";
function entry(amountCents: number): Transaction {
  return { id, kind: "expense", amountCents, currency: "CNY", categoryId: "cat", categoryName: "餐饮",
    categoryIsSystem: false, paymentMethodId: null, paymentMethodName: null,
    occurredAt: "2026-10-11T12:00:00.000Z", occurredLocalDate: "2026-10-11", occurredTz: "Asia/Shanghai",
    note: "test十", tags: [], version: 2 };
}
const fields = [{ field: "amountCents", serverValue: 8000,
  claims: [{ deviceId: "ipad", chain: [1000, 2000], at: "2026-10-11T12:01:00Z" }], history: [1000, 8000] }];
let server = entry(8000);
let open = true;
beforeEach(async () => {
  vi.mocked(apiFetch).mockReset();
  server = entry(8000); open = true;
  await setMark(id, null);
  await upsertEntry(entry(8000));
  vi.mocked(apiFetch).mockImplementation(async (path: string, options?: Parameters<typeof apiFetch>[1]) => {
    if (path === "/conflicts") return { conflicts: open ? [{ transactionId: id, current: server, fields }] : [] } as never;
    if (path === `/transactions/${id}` && options?.method === "PATCH") {
      const body = options.body as { settlesConflict?: boolean; amountCents: number };
      if (open && body.settlesConflict !== true) throw new ApiRequestError(409, "version_conflict", "冲突", { current: server, conflicts: fields });
      server = { ...server, amountCents: body.amountCents, version: server.version + 1 }; open = false;
      return server as never;
    }
    if (path === `/transactions/${id}`) return server as never;
    if (path === "/transactions") return { items: [server], nextCursor: null } as never;
    throw new Error(`Unexpected request: ${path}`);
  });
});

describe("test十: iPad 20 / phone 80 conflict delivery", () => {
  it("shows 20 and 80 on the phone even though its local entry equals the server", async () => {
    await pullConflicts();
    const conflict = conflictsValue()[0]!;
    const html = renderToStaticMarkup(createElement(ConflictScreen, { conflict, onResolve: () => undefined, onLater: () => undefined }));
    expect(html).toContain("20.00");
    expect(html).toContain("80.00");
    expect(html).toContain("还有 1 处没选");
  });
  it.each([2000, 8000])("transmits the settlement flag and closes the conflict when choosing %s cents", async (amount: number) => {
    await pullConflicts();
    const conflict = conflictsValue()[0]!;
    const question = conflictQuestions(conflict)[0]!;
    const selected = question.options.find(option => option.value === amount)!;
    const result = applyConflictChoices(conflict.theirs, new Map([[question.field, selected.value]]), {}, [conflict.mine, conflict.theirs]);
    await resolveConflict(id, result, server);
    expect(open).toBe(false);
    expect(server.amountCents).toBe(amount);
    expect((await readMarks())[id]).toBeUndefined();
    await pullConflicts();
    expect(conflictsValue()).toHaveLength(0);
  });
  it("keeps the offline amount through repeated refreshes until a choice is made", async () => {
    await upsertEntry(entry(2000));
    await setMark(id, { pending: true, synced: true, chain: { amountCents: [1000, 2000] } });
    await syncAll();
    await syncMonth("2026-10");
    await pullConflicts();
    expect((await readStoredMonths())["2026-10"]?.find(row => row.id === id)?.amountCents).toBe(2000);
    expect(conflictsValue()[0]?.fields).toEqual(fields);
  });
  it("does not overwrite a queued offline settlement when polling old server conflicts", async () => {
    await upsertEntry(entry(2000));
    await setMark(id, { pending: true, synced: true, settlesConflict: true, chain: { amountCents: [8000, 2000] } });
    await pullConflicts();
    expect((await readMarks())[id]?.settlesConflict).toBe(true);
    expect((await readMarks())[id]?.conflict).toBeUndefined();
    await syncAll();
    expect(open).toBe(false);
  });
  it("adopts a decision made on the other device before clearing its yellow mark", async () => {
    await pullConflicts();
    open = false; server = entry(2000);
    await pullConflicts();
    expect((await readStoredMonths())["2026-10"]?.find(row => row.id === id)?.amountCents).toBe(2000);
    expect(conflictsValue()).toHaveLength(0);
  });
  it("keeps the user's choice queued and reports failure when the network fails during saving", async () => {
    await pullConflicts();
    vi.mocked(apiFetch).mockRejectedValue(new ApiRequestError(0, "offline", "离线"));
    await expect(resolveConflict(id, entry(2000), server)).rejects.toThrow("服务器尚未确认");
    expect((await readMarks())[id]?.settlesConflict).toBe(true);
    expect((await readStoredMonths())["2026-10"]?.find(row => row.id === id)?.amountCents).toBe(2000);
  });
  it("keeps every distinct device candidate and maps tagIds to the tag question", () => {
    const questions = conflictQuestions({ mine: entry(8000), theirs: entry(8000), base: null, at: 0,
      fields: [ { ...fields[0]!, claims: [...fields[0]!.claims,
        { deviceId: "third", chain: [1000, 5000], at: "now" }] },
        { field: "tagIds", serverValue: [], claims: [{ deviceId: "ipad", chain: [[], ["tag-a"]], at: "now" }] },
        { field: "occurredAt", serverValue: "old", claims: [{ deviceId: "ipad", chain: ["old", "new"], at: "now" }] },
      ] });
    expect(questions.map(question => question.field)).toEqual(["amountCents", "tags"]);
    expect(questions[0]?.options.map(option => option.value)).toEqual([8000, 2000, 5000]);
  });
  it("only clears a mark after a write acknowledgement, never from an unrelated month list", async () => {
    await setMark(id, { pending: true, synced: true, chain: { amountCents: [1000, 2000] } });
    vi.mocked(apiFetch).mockResolvedValue({ items: [], nextCursor: null } as never);
    await syncMonth("2026-09");
    expect((await readMarks())[id]?.pending).toBe(true);
  });
  it("fetches all pages before replacing a month's entries", async () => {
    const other = { ...entry(3000), id: "other" };
    vi.mocked(apiFetch).mockImplementation(async (path: string, options?: Parameters<typeof apiFetch>[1]) => {
      if (path !== "/transactions") throw new Error("Unexpected request");
      return (options?.query?.cursor === "page2" ? { items: [other], nextCursor: null } :
        { items: [server], nextCursor: "page2" }) as never;
    });
    expect(await syncMonth("2026-10")).toBe(2);
    expect((await readStoredMonths())["2026-10"]?.map(row => row.id)).toContain("other");
  });

  it("acknowledges an absent deletion only after its own complete month is fetched, retaining a tombstone", async () => {
    await setMark(id, { pending: true, deleted: true });
    vi.mocked(apiFetch).mockResolvedValue({ items: [], nextCursor: null } as never);
    await syncMonth("2026-09");
    expect((await readMarks())[id]?.pending).toBe(true);
    await syncMonth("2026-10");
    expect((await readMarks())[id]).toEqual({ pending: false, deleted: true, synced: true });
    vi.mocked(apiFetch).mockClear();
    await syncAll();
    expect(apiFetch).not.toHaveBeenCalled();
  });

});
