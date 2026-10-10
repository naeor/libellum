import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The colour rule, enforced rather than described.
 *
 * `docs/COLORS.md` §7 says components may not contain colour literals: adding a
 * colour means deciding which block it belongs to, and a block is a token. That
 * is easy to agree with and easy to break — one `#ffffff` in a hurry, and the
 * next person copies it. So it is checked here.
 *
 * Two files are allowed to hold literals, and only two:
 *
 *  * `index.css` — the token definitions themselves;
 *  * `lib/chart/theme.ts` — the chart palettes, which must be literals because
 *    they are handed to SVG as strings and asserted in tests. They are *data*
 *    rather than theme; see §4 of the document.
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
const EXEMPT = new Set(["index.css", "theme.ts"]);

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

  it("appear only in the token file and the chart palettes", () => {
    expect(
      offenders,
      `组件里出现了硬编码颜色。请按 docs/COLORS.md §7 处理：\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the check honest by finding the files it is meant to guard", () => {
    // A guard that silently checks nothing is worse than no guard. If the walk
    // ever stops finding files — a wrong root, a renamed directory — this fails.
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((path) => path.endsWith("index.css"))).toBe(true);
  });
});
