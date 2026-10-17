import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The colour rule, enforced rather than described.
 *
 * `docs/开发过程记录/颜色清单.md` §7 says components may not contain colour literals: adding a
 * colour means deciding which block it belongs to, and a block is a token. That
 * is easy to agree with and easy to break — one `#ffffff` in a hurry, and the
 * next person copies it. So it is checked here.
 *
 * Four files are allowed to hold literals, and only four:
 *
 *  * `index.css` — the token definitions themselves;
 *  * `lib/chart/theme.ts` — the chart palettes, which must be literals because
 *    they are handed to SVG as strings and asserted in tests. They are *data*
 *    rather than theme; see §4 of the document.
 *  * `components/QrCodeView.tsx` — **and this one is an optical requirement, not a
 *    colour choice.** A QR symbol is read by a camera's thresholding step, which
 *    wants the modules near 0% and the plate near 100% reflectance. **A near-black
 *    theme token is a different value and a real scanning risk**, and the failure
 *    would appear as "the QR code sometimes does not work on some phones" — the
 *    least diagnosable kind. The owner asked for these codes *"方便当面扫码加入"*,
 *    so they have to read.
 *
 *  * `components/OceanBackdrop.tsx` — **the sea's four fills, and they are a drawing rather than a
 *    theme.** The owner specified the subject: brand green `#55997a` mixed towards white by depth,
 *    *"而不是常见的科技粒子动画"*. Reading them from tokens would mean **four tokens that exist for
 *    one illustration**, and the day a token changes the sea changes shape — **which is not what a
 *    brand palette is for.**
 *
 * Comments are stripped before checking, so the document and the code may talk
 * about a colour without tripping the rule.
 */

/**
 * Where to look.
 *
 * `import.meta.dirname` is the directory of this file (`src/lib`), so the
 * source root is its parent. Written this way because the first version used
 * `new URL("../", import.meta.url)` — a real URL object, where `fileURLToPath`
 * and `resolve` both expect a string, which failed at load time rather than at
 * an assertion.
 */
const SRC = resolve(import.meta.dirname, "..");

/** Files permitted to define colour literals. */
const EXEMPT = new Set(["index.css", "theme.ts", "QrCodeView.tsx", "OceanBackdrop.tsx"]);

/**
 * ⚠️ **One file may hardcode `rgb()`, and the reason is the same kind as `OceanBackdrop`'s.**
 *
 * `detail-motion.css` `.detail-currency-card` sets `background: rgb(255 255 255 / 0.14)` — a white
 * *glass* laid over the 明细页's green header so the currency cards read as frosted panels rather than
 * as another shade of green.
 *
 * ⚠️ **It is not a theme colour, because it is not a colour at all: it is a light effect.** Its whole
 * job is to be 14% white over *whatever is behind it*, and the thing behind it is a header whose
 * background is **interpolating on every frame of the transition**. A token would have to be a fixed
 * colour, and a fixed colour over a moving background is a different design.
 *
 * ⚠️ **And this file is inside the owner's protected range** — *"明细页动态头部……保留其已有颜色层次和动态过渡"* —
 * so the right move is to record it, not to route it through the palette for the sake of tidiness.
 */
const ALLOWED_RGBA_FILES: readonly string[] = ["detail-motion.css"];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // A line comment, but not the `//` inside a URL like `https://`.
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(entry)) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    found.push(path);
  }

  return found;
}

describe("colour literals", () => {
  const offenders: string[] = [];

  for (const path of sourceFiles(SRC)) {
    const name = path.split(/[\\/]/).pop() ?? "";
    if (EXEMPT.has(name)) continue;

    const source = stripComments(readFileSync(path, "utf8"));
    for (const match of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${relative(SRC, path).replace(/\\/g, "/")}:${String(line)} ${match[0]}`);
    }
  }

  it("appear only in the token file, the chart palettes, the QR code and the ocean", () => {
    expect(
      offenders,
      `组件里出现了硬编码颜色。请按 docs/开发过程记录/颜色清单.md §7 处理：\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  /**
   * ⚠️ **The hex rule had a hole: it only looked for hex.**
   *
   * `rgb()` and `rgba()` are the same mistake wearing a different hat — and the audit found the two
   * shadows in this project were written that way (`rgba(36,49,43,0.04)`), precisely because
   * **nothing was checking for them.** A guard that names one spelling of a colour teaches people the
   * other spelling is fine.
   *
   * ⚠️ **The `rgba(…, 0)` exemption is not a loophole, it is the point.** Tailwind's `box-shadow` and
   * `ring` utilities compose their value from transparent placeholders:
   * `rgba(0, 0, 0, 0) 0px 0px 0px 0px`. **That is not a colour, it is an empty slot** — and flagging it
   * would make the rule unpassable for any component using `shadow-*` or `ring-*`.
   */
  it("do not slip through as rgb() or rgba() either", () => {
    const rgbaOffenders: string[] = [];

    for (const path of sourceFiles(SRC)) {
      const name = path.split(/[\\/]/).pop() ?? "";
      if (EXEMPT.has(name)) continue;
      if (ALLOWED_RGBA_FILES.includes(relative(SRC, path).replace(/\\/g, "/"))) continue;

      const source = stripComments(readFileSync(path, "utf8"));
      for (const match of source.matchAll(/rgba?\(\s*[\d.]+\s*[\s,/]+[^)]*\)/g)) {
        const value = match[0].replace(/\s+/g, " ");
        // ⚠️ `rgba(0, 0, 0, 0)` and `transparent` placeholders are structure, not colour.
        if (/rgba?\(\s*0[\s,]+0[\s,]+0\s*[\s,/]+0\s*\)/.test(value)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        rgbaOffenders.push(`${relative(SRC, path).replace(/\\/g, "/")}:${String(line)} ${value}`);
      }
    }

    expect(
      rgbaOffenders,
      `组件里出现了 rgb()/rgba() 硬编码颜色。颜色应来自 @theme token：\n  ${rgbaOffenders.join("\n  ")}`,
    ).toEqual([]);
  });

  /**
   * ⚠️ **This test is deliberately narrow, and the limit is worth writing down** — the owner asked
   * whether the check could cover *inline styles*, *unexpected Tailwind built-ins* and *ad-hoc opacity
   * combinations*, and the honest answer is **mostly no, not cheaply**:
   *
   *  * **Inline styles are legitimate here.** `style={{ backgroundColor: tag.color }}` is *user data*
   *    read from the database; `backgroundColor: heatColor(level)` is a computed chart value. A rule
   *    against inline colour would flag the two cases the palette cannot own, and the honest repair
   *    would be suppression comments — which is how a rule becomes noise.
   *  * **Tailwind built-ins cannot be told apart by name alone.** `text-white` is correct on the green
   *    header; `text-red-500` would be a mistake. Both are "a built-in", so a name-based rule needs an
   *    allowlist of correct ones, which then has to be maintained — and the maintenance is the cost.
   *  * **Opacity combinations are not wrong in themselves.** `text-white/80` on the brand header is a
   *    deliberate, documented limitation; a rule banning `/NN` would force it to be written some other
   *    way without making it more readable.
   *
   * **So the constraint is recorded in the design document instead** (`颜色语义与配色规范.md` §4.3 and
   * §9.3), where a reader gets the *reason*, rather than encoded as a rule that misfires. **This is the
   * choice the owner offered: low-cost and reliable, or documented — not a complicated rule that
   * generates false alarms.**
   */
  it("stops where a rule would start misfiring, and says so", () => {
    expect(EXEMPT.size).toBe(4);
    expect(ALLOWED_RGBA_FILES).toEqual(["detail-motion.css"]);
    /**
      * ⚠️ **The one allowed `rgb()` is a translucency, and that is the shape of the whole exception.**
      * If this list ever grows a *solid* colour, the exception was not needed — a solid colour can be a
      * token, and the test above exists to say so.
      */
    const allowed = readFileSync(join(SRC, "detail-motion.css"), "utf8");
    for (const match of allowed.matchAll(/rgba?\([^)]*\)/g)) {
      expect(match[0], "白名单里的颜色必须带透明度（是光效，不是主题色）").toMatch(/\/\s*[\d.]+|,\s*[\d.]+\s*\)$/);
    }
  });

  it("keeps the check honest by finding the files it is meant to guard", () => {
    // A guard that silently checks nothing is worse than no guard. If the walk
    // ever stops finding files — a wrong root, a renamed directory — this fails.
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((path) => path.endsWith("index.css"))).toBe(true);
  });
});
