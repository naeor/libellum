import { describe, expect, it } from "vitest";

import { zoneOffsetLabel } from "./datetime.js";

/**
 * ⚠️ **Why a zone has to be shown at all, and why as an offset rather than a name.**
 *
 * The owner is in California (UTC-7); several of his entries are recorded in UTC+8. **The times on screen
 * were correct and the order looked wrong**, because two entries hours apart read identically without their
 * zones. Nothing was broken — something was missing. He asked for the fix precisely:
 * "把那个时区从 asia shanghai 之类的改成具体的时区（UTC+8 这样的）标准名称."
 *
 * ⚠️ **An offset rather than a name because a name cannot be checked.** `Asia/Shanghai` is a label the
 * reader has to trust; `UTC+8` can be compared against their own clock at a glance.
 *
 * These run against a fixed instant so the expected offset is stable, and they use zones whose rules have
 * not changed since: the point is the formatting, not the zone database.
 */
describe("zoneOffsetLabel", () => {
  const instant = "2026-10-07T11:34:00Z";

  it("labels a whole-hour offset without minutes", () => {
    // UTC+8 is the entry the owner was looking at.
    expect(zoneOffsetLabel(instant, "Asia/Shanghai")).toBe("UTC+8");
  });

  it("labels a negative whole-hour offset", () => {
    // UTC-7 is where he is; `America/Los_Angeles` is his zone.
    expect(zoneOffsetLabel(instant, "America/Los_Angeles")).toBe("UTC-7");
  });

  it("keeps the minutes when there are any", () => {
    // Half-hour zones exist, and dropping their minutes would make them wrong by thirty minutes.
    expect(zoneOffsetLabel(instant, "Asia/Kolkata")).toBe("UTC+5:30");
    expect(zoneOffsetLabel(instant, "Asia/Kathmandu")).toBe("UTC+5:45");
  });

  it("says plain UTC for UTC itself", () => {
    expect(zoneOffsetLabel(instant, "UTC")).toBe("UTC");
  });

  it("returns nothing rather than a broken label for an unusable zone", () => {
    // A caller showing `Invalid/Zone` would be worse than showing no zone at all.
    expect(zoneOffsetLabel(instant, "Not/AZone")).toBe("");
  });
});
