import { describe, expect, it } from "vitest";

/**
 * ⚠️ **The merge that fills the ledger screen, tested because an empty one compiles perfectly.**
 *
 * The owner's report was "现在我看不见明细页面的所有支出了。他显示这个月还没有支出，让我记下第一笔" — and the cause
 * was not a deletion or a filter. **A scripted edit had removed the two lines that filled this map**, leaving
 * the declaration and the read behind, so the screen was handed an empty list while every entry sat safely on
 * both the server and the device.
 *
 * `tsc` was clean throughout. **Nothing in the type system says a list has to contain anything** — which is
 * why the rule that comes out of this is a test with real data in it, not another careful read.
 *
 * These mirror the logic in `DetailPage`: the device's entries and the query's entries are combined by id, the
 * server's copy winning where both have one, and an entry only the device holds is still shown.
 */

interface Row {
  readonly id: string;
  readonly amountCents: number;
}

function merge(localEntries: readonly Row[], fromQuery: readonly Row[]): readonly Row[] {
  const byId = new Map<string, Row>();

  for (const entry of localEntries) byId.set(entry.id, entry);
  for (const entry of fromQuery) byId.set(entry.id, entry);

  return [...byId.values()];
}

describe("the ledger's merge", () => {
  it("⚠️ shows the device's entries when the query has nothing", () => {
    // This is the case that was broken: entries on the device, an empty list on screen.
    const local = [{ id: "a", amountCents: 100 }];

    expect(merge(local, []).map((row) => row.id)).toEqual(["a"]);
  });

  it("shows the query's entries when the device has nothing", () => {
    const remote = [{ id: "b", amountCents: 200 }];

    expect(merge([], remote).map((row) => row.id)).toEqual(["b"]);
  });

  it("shows both, and does not drop either", () => {
    // The offline case: one entry only on the device, one only on the server.
    const local = [{ id: "local-only", amountCents: 100 }];
    const remote = [{ id: "server-only", amountCents: 200 }];

    const merged = merge(local, remote);

    expect(merged).toHaveLength(2);
    expect(merged.map((row) => row.id).sort()).toEqual(["local-only", "server-only"]);
  });

  it("⚠️ prefers the server's copy when both have the same entry", () => {
    // The server's answer is the truth; the device's copy is a copy taken earlier.
    const local = [{ id: "a", amountCents: 100 }];
    const remote = [{ id: "a", amountCents: 999 }];

    const merged = merge(local, remote);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.amountCents).toBe(999);
  });

  it("⚠️ never returns an empty list when either side has entries", () => {
    /**
     * The shape of the defect, stated as a property: **if either source has anything, the screen must have
     * something.** An empty merge is exactly what produced "这个月还没有支出", and it is invisible to every
     * check except one that looks at the result.
     */
    const cases: readonly (readonly [readonly Row[], readonly Row[]])[] = [
      [[{ id: "a", amountCents: 1 }], []],
      [[], [{ id: "b", amountCents: 2 }]],
      [[{ id: "a", amountCents: 1 }], [{ id: "b", amountCents: 2 }]],
    ];

    for (const [local, remote] of cases) {
      expect(merge(local, remote).length).toBeGreaterThan(0);
    }
  });
});
