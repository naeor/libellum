import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { AddEntryPage, nextEntryFields } from "./AddEntryPage.js";

/**
 * The rule restated by the project owner on 2026-10-10: **the date is never
 * carried over from the previous entry, in any circumstance.**
 *
 * The screen is checked in two halves, because the two halves fail differently.
 * What it shows when it is opened is a fact about the rendered component, and
 * is asserted through a render. What "再记一笔" resets lives in
 * `nextEntryFields`, a free function on purpose: pressing that button needs a
 * DOM, which this workspace has no test environment for (no jsdom, no
 * testing-library, and dependencies are not ours to add), and the reset is the
 * part that used to be wrong.
 */
function renderPage(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/add"]}>
        <AddEntryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The value of the 时间 field, which is the only `datetime-local` on screen. */
function shownMoment(html: string): Date {
  const match = /type="datetime-local"[^>]*value="([^"]*)"/.exec(html);

  expect(match?.[1]).toBeTruthy();

  return new Date(match?.[1] ?? "");
}

describe("AddEntryPage", () => {
  it("opens a new entry at the present moment", () => {
    // "Reopening the tab", "the first entry of the day" and "a new entry" are
    // all this one case: there is no earlier entry in the form to inherit from,
    // and there must never be a stale date left in the field either.
    const before = Date.now();
    const shown = shownMoment(renderPage());
    const after = Date.now();

    expect(Number.isNaN(shown.getTime())).toBe(false);
    expect(shown.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(shown.getTime()).toBeLessThanOrEqual(after + 1_000);
  });

  it("renders the entry form, so the assertion above reads the real screen", () => {
    // Without this, `shownMoment` could be matching nothing at all and the date
    // test would still pass on an empty string.
    expect(renderPage()).toContain('aria-label="金额"');
  });
});

describe("nextEntryFields", () => {
  const now = new Date("2026-10-10T09:12:00+08:00");

  it("starts the next entry from the clock it is given, and from nothing else", () => {
    // The moment of the entry just saved is not an input here, so a carried-over
    // date has nowhere to come from. The second line is what makes that a
    // statement rather than a hope: an implementation that read the clock
    // itself, or kept the last moment in module state, would not hand back an
    // arbitrary older time unchanged.
    const earlier = new Date("2026-10-09T16:55:00+08:00");

    expect(nextEntryFields(now).occurredAt.getTime()).toBe(now.getTime());
    expect(nextEntryFields(earlier).occurredAt.getTime()).toBe(earlier.getTime());
  });

  it("clears the amount, the note and the tags", () => {
    const next = nextEntryFields(now);

    expect(next.amountText).toBe("");
    expect(next.note).toBe("");
    expect(next.tagIds).toEqual([]);
  });
});
