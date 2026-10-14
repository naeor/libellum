import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **One green heading area, used by both first-level pages.**
 *
 * ⚠️ **The owner asked for this by construction, not by eye** (2026-10-13): *"不要只是把分析页的标题往上或
 * 往下挪几个像素……尽可能复用相同的标题区布局规则或共享样式，保证以后修改时不会再次出现差异."*
 *
 * ⚠️ **Before this, the two headers were byte-identical copies** — which is the arrangement that drifts:
 * somebody adjusts one, nothing fails, and the difference is only visible to a person looking at both
 * screens side by side. **A shared component is the fix; these assertions are what keep it shared.**
 *
 * ⚠️ **`TabPageHeader` is the only place the classes are written down**, and the measurement that
 * confirmed the two headers render identically (same height, same paddings, same title/subtitle
 * geometry at 390×844) is what these assertions stand in for — a unit test cannot lay out CSS.
 */
function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("一级页面顶部绿色区域", () => {
  it("is one component, imported by both pages", () => {
    for (const page of ["../pages/StatsPage.tsx", "../pages/LedgerPage.tsx"]) {
      expect(source(page), `${page} 没有用共享头部`).toContain("TabPageHeader");
    }
  });

  it("writes the visual spec down exactly once", () => {
    const header = source("../components/TabPageHeader.tsx");

    /**
      * ⚠️ **The seven things the owner listed, as they appear in the one class string**: overall height
      * and vertical padding (`pt-8 pb-6`), the horizontal rhythm (`px-6`), the fill (`bg-brand`), the
      * title's size/weight/tracking, and the subtitle's size, leading, colour and gap (`mt-1.5`).
      *
      * ⚠️ **Asserted as a whole string rather than word by word**, because the point is that there is
      * **no second copy** — a test that accepted a re-worded variant elsewhere would not be guarding
      * anything.
      *
      * ⚠️ **The title and subtitle are now semantic tokens, and this test was updated to match.**
      * It used to pin `text-xl font-semibold tracking-tight` / `text-sm leading-relaxed` — the literal
      * Tailwind classes. **That is exactly the duplication the typography rollout removed**: the same
      * heading was written out by hand in every file that needed one, so changing 20px meant finding
      * them all. `text-page-title` and `text-body-relaxed` carry **size, line-height, weight and
      * tracking** from one place. **The test still pins the spec — it pins the token now.**
      */
    expect(header).toContain('className="bg-brand px-6 pt-8 pb-6 text-white"');
    expect(header).toContain('className="text-page-title"');
    /**
      * ⚠️ **Full white, not `/80`.** See the comment in the component: white at 80% over the brand
      * green is 2.74:1, full white is 3.37:1, and **neither reaches AA** because pure white on
      * `#55997a` is itself only 3.37:1. The limit is the brand green, not this paragraph — so the
      * test pins the best available value rather than pretending a passing one exists.
      */
    expect(header).toContain('className="mt-1.5 text-body-relaxed text-white"');
  });

  it("leaves no second copy of the header markup in either page", () => {
    /**
      * ⚠️ **This is the assertion that fails if somebody "fixes" one page by pasting the old header
      * back.** Both pages must go through the component.
      */
    for (const page of ["../pages/StatsPage.tsx", "../pages/LedgerPage.tsx"]) {
      const text = source(page);

      expect(text, `${page} 又自己写了一个绿色头部`).not.toContain("bg-brand px-6 pt-8 pb-6");
      expect(text, `${page} 又自己写了标题字号`).not.toContain("text-xl font-semibold tracking-tight");
    }
  });

  it("does not bring the current-ledger line back to the analysis header", () => {
    /**
      * ⚠️ **The owner's first instruction**: *"请将这条信息从分析页顶部绿色区域中移除……分析页底部 Tab 导航栏
      * 上方已经有相同的当前账本提示，没有必要在顶部重复展示."*
      *
      * ⚠️ **The bottom one is a different element and must stay** — `TabPage` renders
      * `CurrentBookCaption` from the `currentBookName` prop, and `StatsPage` still passes it. **Both
      * halves are asserted**, because deleting the wrong one would satisfy "no duplicate" and lose the
      * only remaining indication of which ledger the figures describe.
      */
    const stats = source("../pages/StatsPage.tsx");

    expect(stats).not.toContain("当前账本：{ledger");
    /** …and the pass-through that feeds the bottom caption is still there. */
    expect(stats).toContain("currentBookName={ledger.data?.book.name}");
  });
});
