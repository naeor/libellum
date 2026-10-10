import { describe, expect, it } from "vitest";

import { menuAfter, type MenuEvent } from "./Layouts.js";

/**
 * The recording menu's rule, tested rather than described.
 *
 * The behaviour itself lives in an effect inside `AppShell`, which a test
 * without a DOM cannot reach. The *rule* is a pure function for exactly that
 * reason: it is the part worth pinning, and pinning it here means a future
 * change to the effect has something to disagree with.
 *
 * The rule, from the owner's design goal — recording should be startable from as
 * many screens as possible:
 *
 *  * pressing the button always unfolds the three ways to record;
 *  * arriving at any screen folds them again;
 *  * scrolling down into the ledger's list folds them.
 */
describe("the recording menu", () => {
  it("unfolds the three options when the button is pressed", () => {
    expect(menuAfter(false, { type: "toggle" })).toBe(true);
  });

  it("folds them again on a second press", () => {
    expect(menuAfter(true, { type: "toggle" })).toBe(false);
  });

  it("never turns a press into a jump: the state only ever flips", () => {
    // The bug this guards: pressing the button used to navigate to the manual
    // form on some screens, which meant somebody who wanted the camera had to
    // open the menu anyway — the jump could only ever cost them a press.
    for (const before of [true, false]) {
      const after = menuAfter(before, { type: "toggle" });
      expect(after).toBe(!before);
    }
  });

  it("folds when the reader arrives at another screen", () => {
    expect(menuAfter(true, { type: "arrivedSomewhere" })).toBe(false);
  });

  it("stays folded on arrival, which is the ordinary case", () => {
    expect(menuAfter(false, { type: "arrivedSomewhere" })).toBe(false);
  });

  it("folds when the ledger scrolls down into its list", () => {
    expect(menuAfter(true, { type: "scrolledIntoList" })).toBe(false);
  });

  it("is not re-opened by anything except a press", () => {
    const events: MenuEvent[] = [{ type: "arrivedSomewhere" }, { type: "scrolledIntoList" }];

    for (const event of events) {
      expect(menuAfter(true, event)).toBe(false);
      expect(menuAfter(false, event)).toBe(false);
    }
  });

  it("reaches the open state from any starting point, in one press", () => {
    // Whoever wants to record is one press away, wherever they are — which is
    // the whole point of the menu existing on every screen.
    expect(menuAfter(false, { type: "toggle" })).toBe(true);
  });
});
