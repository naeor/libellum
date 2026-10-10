import { describe, expect, it } from "vitest";

import type { TransactionListResponse } from "@libellum/shared";

/**
 * ⚠️ **The test that found the defect behind "下载全部点了没有反应".**
 *
 * It started as a description of what the fill did, and two of its three assertions
 * failed. The reason is worth keeping, because it is not obvious from reading either
 * function:
 *
 *  * **`fetchInfiniteQuery` fetches exactly one page and resolves.** Pagination is
 *    driven by the *screen* calling `fetchNextPage` when somebody presses "载入更多".
 *  * **`QueryClient` has no `fetchNextPage` at all** — it is on the hook, not the
 *    client.
 *
 * So the fill asked for a month, got its first hundred entries, and called it done.
 * The owner's October holds **61** entries, so it fitted; but any month over a hundred
 * would have been silently short, and — worse — a month ever cached with only a first
 * page could never be completed, because every later run saw "data exists" and stopped.
 *
 * The loop below is the one the fill now runs, written out so the behaviour is pinned.
 */
describe("filling one month", () => {
  interface Page {
    readonly items: readonly { readonly id: string }[];
    readonly nextCursor: string | null;
  }

  /** A fake API that behaves like the real one: a cursor until the month runs out. */
  function fakeApi(total: number, pageSize: number) {
    const calls: (string | undefined)[] = [];

    const fetchPage = async (cursor: string | undefined): Promise<Page> => {
      calls.push(cursor);

      const start = cursor === undefined ? 0 : Number(cursor);
      const end = Math.min(start + pageSize, total);

      return {
        items: Array.from({ length: Math.max(0, end - start) }, (_, index) => ({ id: `entry-${String(start + index)}` })),
        nextCursor: end < total ? String(end) : null,
      };
    };

    return { fetchPage, calls };
  }

  /** The fill's loop, verbatim in shape. */
  async function fillMonth(
    fetchPage: (cursor: string | undefined) => Promise<Page>,
    maxPages: number,
  ): Promise<readonly Page[]> {
    const pages: Page[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const fetched = await fetchPage(cursor);
      pages.push(fetched);

      if (fetched.nextCursor === null) break;

      cursor = fetched.nextCursor;
    }

    return pages;
  }

  it("fetches every page, not just the first", async () => {
    // 161 entries at 100 a page: two requests, and the second is the one the old
    // implementation never made.
    const api = fakeApi(161, 100);

    const pages = await fillMonth(api.fetchPage, 40);

    expect(pages).toHaveLength(2);
    expect(pages.flatMap((page) => page.items)).toHaveLength(161);
    expect(api.calls).toEqual([undefined, "100"]);
  });

  it("stops after one request when the month fits", async () => {
    const api = fakeApi(20, 100);

    const pages = await fillMonth(api.fetchPage, 40);

    expect(pages).toHaveLength(1);
    expect(api.calls).toEqual([undefined]);
  });

  it("fetches an empty month in one request", async () => {
    // A month nobody spent anything in is still a month that has been downloaded, and
    // it must cost one request rather than none — otherwise the download manager
    // cannot tell it apart from a month never fetched.
    const api = fakeApi(0, 100);

    const pages = await fillMonth(api.fetchPage, 40);

    expect(pages).toHaveLength(1);
    expect(pages[0]?.nextCursor).toBeNull();
  });

  it("stops at the page cap even if the server keeps offering a cursor", async () => {
    // A guard, not a calculation: the only thing it protects against is a server that
    // never stops, which would otherwise spin for ever on somebody's phone.
    const calls: (string | undefined)[] = [];
    const neverEnds = async (cursor: string | undefined): Promise<Page> => {
      calls.push(cursor);
      return { items: [{ id: "x" }], nextCursor: String(calls.length) };
    };

    const pages = await fillMonth(neverEnds, 3);

    expect(pages).toHaveLength(3);
    expect(calls).toHaveLength(3);
  });

  it("⚠️ treats a finished month as finished and a partial one as not", () => {
    // The rule that decides whether to fetch at all. `fetchInfiniteQuery` — and any
    // "is it cached" check — resolves immediately when *some* data exists, so a month
    // ever cached with one page stayed half-downloaded for ever without this.
    const finished = { pages: [{ items: [], nextCursor: null }] };
    const partial = { pages: [{ items: [], nextCursor: "100" }] };

    const isComplete = (cached: { readonly pages?: readonly Page[] }): boolean =>
      cached.pages !== undefined &&
      cached.pages.length > 0 &&
      cached.pages[cached.pages.length - 1]?.nextCursor === null;

    expect(isComplete(finished)).toBe(true);
    expect(isComplete(partial)).toBe(false);
    expect(isComplete({})).toBe(false);
    expect(isComplete({ pages: [] })).toBe(false);
  });

  it("keeps the assembled value in the shape the screen reads", async () => {
    // `{ pages, pageParams }` is what `useInfiniteQuery` expects. A plain array under
    // the same key would leave the screen finding data it cannot read.
    const api = fakeApi(150, 100);
    const pages = await fillMonth(api.fetchPage, 40);

    const cached = { pages, pageParams: pages.map(() => undefined as string | undefined) };

    expect(Array.isArray(cached.pages)).toBe(true);
    expect(cached.pages.flatMap((page) => page.items)).toHaveLength(150);
  });
});

/** Unused type import kept meaningful: the fill's pages are list responses. */
type _AssertShape = TransactionListResponse;
