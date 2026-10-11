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
    const leftAt = Date.parse(left.occurredAt);
    const rightAt = Date.parse(right.occurredAt);

    if (Number.isNaN(leftAt) || Number.isNaN(rightAt)) {
      if (Number.isNaN(leftAt) && Number.isNaN(rightAt)) return left.id < right.id ? 1 : -1;

      return Number.isNaN(leftAt) ? 1 : -1;
    }

    if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;

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

  /**
   * ⚠️ **The bug the owner found, and it is the reason this comparison parses instead of comparing strings.**
   *
   * He recorded entries at about eight in the evening, and they "被扔到了 19:09 之前、12 点之后的那个位置".
   * The cause was that his ledger holds **two different UTC offsets** — he was in California (UTC-7) while
   * other entries were recorded in UTC+8 — and a string comparison never looks at the offset:
   *
   * ```
   * "…T20:00:00.000-07:00"  → 03:00 UTC the next day   (the newest entry)
   * "…T19:09:00.000+08:00"  → 11:09 UTC that day
   * ```
   *
   * `"19" < "20"`, so the string form reads the *older* one as newer. **Two instants compare by when they
   * happened; two ISO strings compare by how they are spelled.**
   */
  it("⚠️ orders entries that were recorded in different time zones", () => {
    const rows = [
      // Eight in the evening in California = 03:00 UTC the next day. Later than everything below.
      { id: "california-evening", occurredAt: "2026-10-11T20:00:00.000-07:00" },
      { id: "utc8-evening", occurredAt: "2026-10-11T19:09:00.000+08:00" },
      { id: "utc8-noon", occurredAt: "2026-10-11T12:00:00.000+08:00" },
    ];

    expect(sortByTime(rows).map((row) => row.id)).toEqual([
      "california-evening",
      "utc8-evening",
      "utc8-noon",
    ]);
  });

  /**
   * ⚠️ **The same case, spelled so the string comparison fails — and this is why the bug survived so long.**
   *
   * The pair above happens to come out right by string too, because `"20" > "19"` and the dates match. **A
   * comparison that is wrong only for some inputs is worse than one that is always wrong**: it looks fine in
   * every example anyone tries, and then breaks on the user's real ledger.
   *
   * Here the later entry has the *smaller* clock digits, which is what happens as soon as two zones differ by
   * more than the gap between the two times — exactly the owner's case, where he is in California and other
   * entries were recorded in UTC+8.
   *
   * ```
   * "2026-10-11T20:30:00.000-07:00"  → 03:30 UTC the next day   (later)
   * "2026-10-12T10:00:00.000+08:00"  → 02:00 UTC the next day   (earlier, but starts "T10")
   * ```
   */
  it("⚠️ orders correctly when the later entry has the smaller clock digits", () => {
    const rows = [
      { id: "california-2030", occurredAt: "2026-10-11T20:30:00.000-07:00" },
      { id: "utc8-1000", occurredAt: "2026-10-12T10:00:00.000+08:00" },
    ];

    /** The old comparison, kept as the record of the defect. */
    const byString = [...rows].sort((left, right) => (left.occurredAt < right.occurredAt ? 1 : -1));

    expect(byString.map((row) => row.id)).toEqual(["utc8-1000", "california-2030"]);
    expect(sortByTime(rows).map((row) => row.id)).toEqual(["california-2030", "utc8-1000"]);
  });

  it("does not let one unreadable timestamp take the list down", () => {
    // An entry whose time cannot be parsed belongs at the bottom, not nowhere — and never a thrown error.
    const rows = [
      { id: "broken", occurredAt: "not a date" },
      { id: "real", occurredAt: "2026-10-11T20:00:00.000-07:00" },
    ];

    expect(sortByTime(rows).map((row) => row.id)).toEqual(["real", "broken"]);
  });
});
