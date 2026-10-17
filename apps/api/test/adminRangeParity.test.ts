/**
 * **The first-batch range is written down twice — and this test is what keeps that honest.**
 *
 * ⚠️ **Why two copies exist at all.** The server's answer lives in `apps/api/src/admin/rules.ts`
 * and is part of the administrator permission check. The owner's rule (2026-10-17):
 *
 * > *"对于这种比较敏感的权限，新加判断方式的同时，不要删除或者动任何原有的判断……
 * > 除非得到开发者的明确指令，否则不要删除或者修改已有的任何敏感权限的判断。"*
 *
 * So the browser needed the range (it decides whether to render the console entry **without a
 * request**), and the correct move was **not** to refactor the server's check. The range was
 * copied into `shared`, and this test is the price of that copy: **the two must agree, or the
 * suite fails.**
 *
 * ⚠️ **A copy without a test is how "is this account in the first batch" gets two answers.**
 * If the range ever moves, this test is the thing that says so.
 */
import { describe, expect, it } from "vitest";

import {
  FIRST_BATCH_ACCOUNT_FIRST as SERVER_FIRST,
  FIRST_BATCH_ACCOUNT_LAST as SERVER_LAST,
  FIRST_BATCH_SIZE as SERVER_SIZE,
  isFirstBatchAccountNumber as serverSaysEligible,
} from "../src/admin/rules.js";
import {
  FIRST_BATCH_ACCOUNT_FIRST as SHARED_FIRST,
  FIRST_BATCH_ACCOUNT_LAST as SHARED_LAST,
  FIRST_BATCH_SIZE as SHARED_SIZE,
  isFirstBatchAccountNumber as sharedSaysEligible,
} from "@libellum/shared";

describe("the first-batch range: the server's copy and the browser's copy agree", () => {
  it("uses the same boundaries and the same size", () => {
    expect(SHARED_FIRST).toBe(SERVER_FIRST);
    expect(SHARED_LAST).toBe(SERVER_LAST);
    expect(SHARED_SIZE).toBe(SERVER_SIZE);
  });

  it("agrees on every value that matters", () => {
    const samples = [
      SERVER_FIRST,
      SERVER_LAST,
      "10000001",
      "10000050",
      "09999999",
      "10000100",
      "10000101",
      "10000199",
      "99999999",
      "",
      "1234567",
      "123456789",
      "abcdefgh",
      " 10000000",
      "10000000 ",
    ];

    for (const value of samples) {
      expect(sharedSaysEligible(value), value).toBe(serverSaysEligible(value));
    }
  });
});
