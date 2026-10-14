import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **No new arbitrary font sizes.**
 *
 * ⚠️ **This is the guard that keeps the typography system from eroding**, and it exists because the
 * erosion already happened once. The S11 audit found:
 *
 * * `text-xs` used **186 times, 53 of them with an extra `leading-relaxed`** — the same 12px rendering
 *   at **16px or 19.5px** depending on whether the author happened to add a class;
 * * `text-[11px]` used **24 times** — a real, needed size that had **no name**, so it could not be
 *   found, could not be adjusted, and was re-invented at 10px in two more places.
 *
 * ⚠️ **A token that anybody may bypass is not a system.** The audit's own recommendation was this
 * check, in as many words: *"没有这条检查，token 会在几个月内被新的任意值绕过."*
 *
 * ⚠️ **Modeled on `colors.test.ts`**, which has guarded hex literals the same way since S6 — including
 * its second test, which exists because **a guard that silently checks nothing is worse than no
 * guard.**
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * ⚠️ **Every file allowed to name a pixel size, and why.**
 *
 * ⚠️ **An allowlist rather than a blanket ban, on the owner's instruction**: *"不要一刀切禁止所有任意值。
 * 动画插值、图表、必要的技术例外可以明确列入白名单."* Each entry below is a **reason**, not a
 * permission — adding one should feel like adding an exception to a rule, because that is what it is.
 */
const ALLOWED: readonly { readonly file: string; readonly why: string }[] = [
  {
    file: "pages/DetailPage.tsx",
    why: "明细页动态头部：字号随 `--p` 插值、币种卡与提示的本轮保护范围（所有者 §8.2）",
  },
  {
    file: "pages/ExportPage.tsx",
    why: "16px 是 input 的**防 iOS 聚焦缩放**阈值，与 `index.css` 的全局规则同义（所有者 §8.4）",
  },
  {
    file: "components/CopyButton.tsx",
    why: "**待归并**：10px 的复制按钮不在图表里，没有理由比底部导航还小。记在这里而不是忘掉",
  },
  {
    file: "components/InfoHint.tsx",
    why: "**待归并**：`size-4` 的圆形问号徽标，属于「紧凑徽标」例外，但 10px 偏小",
  },
];

/** ⚠️ The chart components, taken as a directory rather than one by one. */
const ALLOWED_DIRS: readonly { readonly dir: string; readonly why: string }[] = [
  {
    dir: "components/charts",
    why: "图表刻度 / 图例 / 浮层：字号受 SVG 密度约束，10px 是为在 390px 内容纳刻度（所有者 §8.5）",
  },
];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(tsx|ts)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    found.push(path);
  }

  return found;
}

/**
 * ⚠️ **Comments are stripped before searching, and that matters here more than usual.**
 * This project explains its decisions **in the code**, so a comment that says
 * *"it used to be `text-[11px]`"* is documentation, not a use. Counting it would make the guard
 * **punish the explanation** — and the honest repair would be to delete the explanation, which is the
 * opposite of what the documentation rules ask for.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("任意字号", () => {
  const offenders: string[] = [];
  let scanned = 0;

  for (const path of sourceFiles(SRC)) {
    const rel = relative(SRC, path).replace(/\\/g, "/");
    if (ALLOWED.some((entry) => entry.file === rel)) continue;
    if (ALLOWED_DIRS.some((entry) => rel.startsWith(`${entry.dir}/`))) continue;

    scanned += 1;
    const source = stripComments(readFileSync(path, "utf8"));

    for (const match of source.matchAll(/text-\[\d+px\]/g)) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${rel}:${String(line)} ${match[0]}`);
    }
  }

  it("只在白名单文件里出现", () => {
    expect(
      offenders,
      [
        "组件里出现了任意字号。请改用语义 token（见 docs/文字语义与排版规范.md §3）：",
        "  正文 text-body ｜ 辅助 text-helper ｜ 微文字 text-micro ｜ 功能区标题 text-section-title",
        "确实需要新尺寸时，先加语义 token，再把它加进本测试的白名单并写明理由。",
        `  ${offenders.join("\n  ")}`,
      ].join("\n"),
    ).toEqual([]);
  });

  it("每个白名单条目都还写得有理由", () => {
    /**
      * ⚠️ **An allowlist entry without a reason is a hole, not an exception.** This is the same idea
      * as `colors.test.ts`'s second test: the guard has to stay honest about what it is letting
      * through, or it becomes a list somebody appends to without reading.
      */
    for (const entry of [...ALLOWED, ...ALLOWED_DIRS]) {
      const why = "why" in entry ? entry.why : "";
      expect(why.length, `${JSON.stringify(entry)} 没有写明理由`).toBeGreaterThan(10);
    }
  });

  it("keeps the check honest by finding the files it is meant to guard", () => {
    /**
      * ⚠️ **A guard that silently checks nothing is worse than no guard.** If the walk ever stops
      * finding files — a wrong root, a renamed directory — this fails instead of passing quietly.
      * The threshold is deliberately well below the real count (133) so ordinary file churn does not
      * make it flaky.
      */
    expect(scanned).toBeGreaterThan(100);
    expect(sourceFiles(SRC).some((path) => path.endsWith("index.css"))).toBe(false);
  });
});
