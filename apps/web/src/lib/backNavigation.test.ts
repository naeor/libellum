import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ⚠️ **The owner reported this as a live bug** (2026-10-13):
 *
 * > *"点击关于 libellum 时会出现那个经典的老 bug：从关于退出会进到设置，从设置退出又会回到关于界面；
 * >  记录一下：从开始界面直接进入关于界面时，点击返回是返回开始界面."*
 *
 * ⚠️ **It is a history loop, and no single screen is wrong.** 关于's `backTo` is `/settings`; the start
 * page's footer is a third way in. Preferring history means the answer depends on how the reader
 * arrived — so 关于 and 设置 can point at each other and pressing back walks a circle.
 *
 * ⚠️ **The fix is a declared origin (`location.state.from`) that beats history**, and it lives in two
 * places that have to agree: `useGoBack` reads it, and every footer link has to set it. **A test that
 * only checked one of them would pass while the bug was still there**, which is why both are asserted.
 *
 * ⚠️ Asserted against source rather than by rendering, because this project's web tests run in plain
 * Node with no DOM (`vitest.config.ts`) — the same choice the copy tests make.
 */
function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("退出一个二级页面时去哪里", () => {
  it("prefers a declared origin over history", () => {
    const connectivity = source("./connectivity.ts");

    /**
      * ⚠️ **The order is the fix**: `from` is checked before `location.key`, so a screen reached from
      * two different places can say which one it was opened from.
      */
    const fromIndex = connectivity.indexOf("if (from !== null)");
    const historyIndex = connectivity.indexOf('if (location.key !== "default")');

    expect(fromIndex).toBeGreaterThan(-1);
    expect(historyIndex).toBeGreaterThan(-1);
    expect(fromIndex).toBeLessThan(historyIndex);
  });

  it("reads the state defensively", () => {
    /**
      * ⚠️ **`state` is `unknown` at runtime.** A screen that crashed because somebody passed a number
      * as `from` would be a worse bug than the one being fixed, so the type is checked rather than
      * asserted.
      */
    expect(source("./connectivity.ts")).toContain('typeof declared === "string"');
  });

  it("has the start page's footer declaring where it came from", () => {
    /**
      * ⚠️ **All three footer links, not just 关于.** 隐私政策 and 使用条款 sit in the same footer and
      * would inherit the identical bounce — **the owner reported it for 关于 because that is the one he
      * tapped.**
      */
    const start = source("../pages/LedgerSpacePage.tsx");

    const declared = start.match(/state=\{\{ from: "\/start" \}\}/g) ?? [];
    expect(declared).toHaveLength(3);

    /**
      * ⚠️ **And they are `Link`, not `<a>`.** A raw anchor is a full page load: it resets history, so
      * the declared origin would never be delivered and the fallback would win — **the bug, restored
      * silently.**
      */
    expect(start).not.toContain('href="/about"');
    expect(start).not.toContain('href="/legal/');
  });

  it("falls back to where a deep link should land", () => {
    /**
      * ⚠️ **The fallback is for a deep link, which is the only case it was ever for.** Somebody opening
      * `/about` directly has no origin to honour, and 设置 is still the sensible parent there.
      */
    expect(source("../pages/AboutPage.tsx")).toContain('backTo={from ?? "/settings"}');
    expect(source("../pages/LegalPage.tsx")).toContain('backTo={from ?? "/settings"}');
  });
});
