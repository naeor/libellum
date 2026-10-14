// Colour audit for docs/颜色语义与配色规范.md (S11 Semantic Color System, phase 1).
//
// Reads every web source file and reports, per class of colour expression:
//   * Tailwind colour utilities and how often each is used,
//   * hardcoded literals the existing hex guard does NOT catch (rgb/hsl/named/SVG),
//   * opacity modifiers, which change a token's effective contrast,
//   * inline styles and SVG fill/stroke attributes.
// Writes nothing.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = "C:\\Users\\ZhuanZ（无密码）\\Desktop\\工作\\记账程序\\记账程序v1\\apps\\web\\src";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") continue;
      walk(path, out);
      continue;
    }
    if (!/\.(tsx|ts|css)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    out.push(path);
  }
  return out;
}

const files = walk(SRC);

/** Strip comments so the documentation may discuss a colour without being counted as a use. */
function strip(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// 1. Tailwind colour utilities
// ---------------------------------------------------------------------------
const utility = new Map();
const opacityModifier = new Map();
const tokensSeen = new Map();

for (const path of files) {
  const source = strip(readFileSync(path, "utf8"));
  const rel = relative(SRC, path).replace(/\\/g, "/");
  for (const m of source.matchAll(/className="([^"]*)"/g)) {
    const cls = m[1];
    for (const c of cls.split(/\s+/)) {
      // e.g. bg-brand, text-white/80, border-line/70, hover:bg-brand-dark, divide-line
      const hit = /^(?:[a-z-]+:)?(bg|text|border|ring|fill|stroke|divide|from|to|via|outline|shadow|decoration|accent|caret)-([a-z0-9-]+?)(?:\/(\d+))?$/.exec(c);
      if (!hit) continue;
      const kind = hit[1];
      const token = hit[2];
      const alpha = hit[3];
      const key = `${kind}-${token}`;
      utility.set(key, (utility.get(key) ?? 0) + 1);
      if (alpha !== undefined) {
        const akey = `${key}/${alpha}`;
        opacityModifier.set(akey, (opacityModifier.get(akey) ?? 0) + 1);
      }
      tokensSeen.set(token, (tokensSeen.get(token) ?? 0) + 1);
    }
  }
}

console.log("=== 1. Tailwind 颜色工具类（按 token） ===");
const byToken = new Map();
for (const [key, n] of utility) {
  const token = key.split("-").slice(1).join("-");
  byToken.set(token, (byToken.get(token) ?? 0) + n);
}
for (const [token, n] of [...byToken].sort((a, b) => b[1] - a[1])) {
  const kinds = [...utility].filter(([k]) => k.split("-").slice(1).join("-") === token).map(([k, v]) => `${k.split("-")[0]}×${String(v)}`);
  console.log(`  ${token.padEnd(16)} 共 ${String(n).padStart(4)}   ${kinds.join("  ")}`);
}

console.log("\n=== 2. 带透明度的用法（会改变实际对比度） ===");
for (const [key, n] of [...opacityModifier].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${key.padEnd(26)} ${n}`);
}

// ---------------------------------------------------------------------------
// 3. Literals the hex guard does NOT catch
// ---------------------------------------------------------------------------
const uncaught = { rgb: [], hsl: [], named: [], svgAttr: [], inlineStyle: [], cssVar: [] };
const HEX_EXEMPT = new Set(["index.css", "theme.ts", "QrCodeView.tsx", "OceanBackdrop.tsx"]);

for (const path of files) {
  const source = strip(readFileSync(path, "utf8"));
  const rel = relative(SRC, path).replace(/\\/g, "/");
  const name = rel.split("/").pop() ?? "";
  const lines = source.split("\n");

  lines.forEach((line, i) => {
    const at = `${rel}:${String(i + 1)}`;
    for (const m of line.matchAll(/rgba?\([^)]*\)/g)) uncaught.rgb.push(`${at} ${m[0]}`);
    for (const m of line.matchAll(/hsla?\([^)]*\)/g)) uncaught.hsl.push(`${at} ${m[0]}`);
    // Inline style objects / attributes carrying a colour.
    if (/(?:style=\{\{|style=")[^}"]*(?:color|background|fill|stroke|border)/.test(line)) {
      uncaught.inlineStyle.push(`${at} ${line.trim().slice(0, 110)}`);
    }
    // SVG presentation attributes.
    for (const m of line.matchAll(/\b(fill|stroke)=["'][^"']+["']/g)) {
      if (m[0].includes("none") || m[0].includes("currentColor")) continue;
      uncaught.svgAttr.push(`${at} ${m[0]}`);
    }
    // CSS custom-property references outside the token file.
    if (!HEX_EXEMPT.has(name)) {
      for (const m of line.matchAll(/var\(--color-[a-z0-9-]+\)/g)) uncaught.cssVar.push(`${at} ${m[0]}`);
    }
  });
}

console.log("\n=== 3. 现有 hex 守卫**抓不到**的颜色写法 ===");
for (const [label, list] of [
  ["rgb()/rgba()", uncaught.rgb],
  ["hsl()/hsla()", uncaught.hsl],
  ["内联 style 带颜色", uncaught.inlineStyle],
  ["SVG fill/stroke 字面值", uncaught.svgAttr],
  ["组件里直接 var(--color-*)", uncaught.cssVar],
]) {
  console.log(`\n  --- ${label}: ${list.length} 处 ---`);
  for (const x of list.slice(0, 24)) console.log(`    ${x}`);
  if (list.length > 24) console.log(`    …还有 ${list.length - 24} 处`);
}

// ---------------------------------------------------------------------------
// 4. Named CSS colours used as utility tokens that are NOT in @theme
// ---------------------------------------------------------------------------
const THEME_TOKENS = new Set([
  "category-ink", "canvas", "surface", "ink", "muted", "line", "brand", "brand-dark", "brand-soft",
  "accent-ink", "danger", "danger-dark", "danger-soft", "warn", "warn-dark", "warn-soft",
  // Tailwind's own built-ins that the project legitimately relies on:
  "white", "black", "transparent", "current", "inherit", "none", "auto",
]);

console.log("\n=== 4. 用到了但**不在 @theme** 里的颜色 token（Tailwind 内置或拼错） ===");
const unknown = [...byToken].filter(([t]) => !THEME_TOKENS.has(t)).sort((a, b) => b[1] - a[1]);
if (unknown.length === 0) console.log("  ✅ 无——所有颜色工具类都指向已定义的 token");
for (const [t, n] of unknown) console.log(`  ${t.padEnd(18)} ${n}`);
