import { describe, expect, it } from "vitest";

/**
 * ⚠️ **The order the ledger is always shown in: newest first, oldest last.**
 *
 * The owner asked for this as a named function: "每次打开明细页面时或者明细页面有任何修改（新增账单，修改账单
 * 等等）都会单独调用一个排序函数，排序函数会根据时间把所有的账单排序."
 *
 * **And the reason he had to ask twice is the point of these tests.** Every earlier attempt sorted as a side
 * effect of something else — of where the data came from, of which layer happened to answer, of whether a
 * refetch had landed. A downloaded month arrives in the server's order, `upsertEntry` appends a new entry to
 * the end, and after a sync the server's order returns. **So the same entry moved from the bottom to the top
 * for no reason the user could see, and the list looked shuffled.**
 *
 * The function below is the same rule as `sortByTime` in the ledger screen, extracted so the ordering can be
 * checked without a browser.
 */

interface Row {
  readonly id: string;
  readonly occurredAt: string;
}

function sortByTime(entries: readonly Row[]): readonly Row[] {
  return [...entries].sort((left, right) => {
    if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? 1 : -1;

    return left.id < right.id ? 1 : -1;
  });
}

describe("the ledger's order", () => {
  it("puts the newest entry first and the oldest last", () => {
    const rows = [
      { id: "b", occurredAt: "2026-10-05T09:00:00+08:00" },
      { id: "a", occurredAt: "2026-10-07T09:00:00+08:00" },
      { id: "c", occurredAt: "2026-10-01T09:00:00+08:00" },
    ];

    expect(sortByTime(rows).map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("⚠️ does not depend on the order it was given", () => {
    // This is the whole complaint: the order used to be whatever the source produced, so the same set could
    // render differently depending on which layer answered.
    const ascending = [
      { id: "c", occurredAt: "2026-10-01T09:00:00+08:00" },
      { id: "b", occurredAt: "2026-10-05T09:00:00+08:00" },
      { id: "a", occurredAt: "2026-10-07T09:00:00+08:00" },
    ];
    const descending = [...ascending].reverse();

    expect(sortByTime(ascending).map((row) => row.id)).toEqual(sortByTime(descending).map((row) => row.id));
  });

  it("⚠️ keeps two entries in the same second in a stable order", () => {
    // Without a second comparison the two would swap places between renders, and **a list that reshuffles
    // while being read is worse than one that is slightly wrong.**
    const sameInstant = [
      { id: "aaa", occurredAt: "2026-10-07T09:00:00+08:00" },
      { id: "bbb", occurredAt: "2026-10-07T09:00:00+08:00" },
    ];

    expect(sortByTime(sameInstant).map((row) => row.id)).toEqual(["bbb", "aaa"]);
    expect(sortByTime([...sameInstant].reverse()).map((row) => row.id)).toEqual(["bbb", "aaa"]);
  });

  it("compares the full instant, not the calendar day", () => {
    // Two entries on the same date but at different times must be ordered by the time.
    const rows = [
      { id: "morning", occurredAt: "2026-10-07T08:00:00+08:00" },
      { id: "evening", occurredAt: "2026-10-07T20:00:00+08:00" },
    ];

    expect(sortByTime(rows).map((row) => row.id)).toEqual(["evening", "morning"]);
  });

  it("returns a new array rather than sorting the caller's", () => {
    // The same list feeds other calculations; reordering it in place would change those too.
    const rows = [
      { id: "old", occurredAt: "2026-10-01T09:00:00+08:00" },
      { id: "new", occurredAt: "2026-10-07T09:00:00+08:00" },
    ];

    sortByTime(rows);

    expect(rows.map((row) => row.id)).toEqual(["old", "new"]);
  });

  it("handles an empty list", () => {
    expect(sortByTime([])).toEqual([]);
  });
});
