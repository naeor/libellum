// Contrast audit for docs/颜色语义与配色规范.md (S11 Semantic Color System).
//
// Computes WCAG 2.1 contrast ratios for every foreground/background pairing the app actually
// renders, including the ones the Tailwind opacity modifiers produce — which is where the real
// failures hide, because text-muted/60 is not the colour the token says it is.
// Writes nothing.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = "C:\\Users\\ZhuanZ（无密码）\\Desktop\\工作\\记账程序\\记账程序v1\\apps\\web\\src";

const TOKENS = {
  canvas: "#fafcfb",
  surface: "#ffffff",
  ink: "#24312b",
  muted: "#6b7f76",
  line: "#e3ede7",
  brand: "#55997a",
  "brand-dark": "#447d63",
  "brand-soft": "#edf5f0",
  "accent-ink": "#8fa39a",
  danger: "#b8574f",
  "danger-dark": "#9c4740",
  "danger-soft": "#fbefee",
  warn: "#b07d2b",
  "warn-dark": "#8f6420",
  "warn-soft": "#fdf6e7",
  "category-ink": "#3f7059",
  white: "#ffffff",
};

function srgb(channel) {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** ⚠️ Flatten a translucent foreground onto its background, which is what the eye actually sees. */
function over(hex, alpha, bg) {
  const p = (h) => {
    const s = h.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  };
  const [r1, g1, b1] = p(hex);
  const [r2, g2, b2] = p(bg);
  const mix = (x, y) => Math.round(x * alpha + y * (1 - alpha));
  return `#${[mix(r1, r2), mix(g1, g2), mix(b1, b2)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const AA_NORMAL = 4.5;
const AA_LARGE = 3;

function verdict(ratio, large = false) {
  const need = large ? AA_LARGE : AA_NORMAL;
  if (ratio >= need) return "✅ 通过";
  if (ratio >= AA_LARGE) return large ? "❌" : "⚠️ 仅够大字";
  return "❌ 不通过";
}

console.log("=== 1. 语义 token 两两对比（实际会出现的组合） ===");
const pairs = [
  ["ink", "canvas"], ["ink", "surface"], ["ink", "brand-soft"],
  ["muted", "canvas"], ["muted", "surface"], ["muted", "brand-soft"],
  ["brand-dark", "canvas"], ["brand-dark", "surface"], ["brand-dark", "brand-soft"],
  ["brand", "canvas"], ["brand", "surface"],
  ["white", "brand"], ["white", "brand-dark"], ["white", "danger"], ["white", "danger-dark"],
  ["danger", "canvas"], ["danger", "surface"], ["danger", "danger-soft"],
  ["warn", "canvas"], ["warn-dark", "warn-soft"],
  ["category-ink", "brand-soft"],
  ["accent-ink", "surface"], ["accent-ink", "canvas"],
  ["line", "surface"], ["line", "canvas"],
];

for (const [fg, bg] of pairs) {
  const ratio = contrast(TOKENS[fg], TOKENS[bg]);
  console.log(("  " + fg).padEnd(15) + ("on " + bg).padEnd(15) + ratio.toFixed(2).padStart(6) + ":1  " + verdict(ratio));
}

console.log("\n=== 2. ⚠️ 带透明度修饰符的实际对比度（token 值不等于渲染值） ===");
/**
 * Every translucent text colour found by the audit, flattened onto the surfaces it is used over. A translucent
 * muted colour is the classic silent failure: it looks deliberate in the source and is unreadable
 * on screen.
 */
const translucent = [
  ["muted", 60, ["canvas", "surface"]],
  ["muted", 50, ["canvas", "surface"]],
  ["white", 75, ["brand", "brand-dark"]],
  ["white", 70, ["brand", "brand-dark"]],
  ["white", 80, ["brand"]],
  ["white", 90, ["brand"]],
  ["white", 95, ["brand"]],
  ["ink", 25, ["canvas"]],
  ["ink", 35, ["canvas"]],
];

for (const [fg, pct, bgs] of translucent) {
  for (const bg of bgs) {
    const flat = over(TOKENS[fg], pct / 100, TOKENS[bg]);
    const ratio = contrast(flat, TOKENS[bg]);
    // ⚠️ Not a template literal: the label contains backtick-quoted class names, and nesting them
    // inside one is a syntax error — the same mistake as the CSS-comment quote trap.
    const label = "  text-" + fg + "/" + String(pct) + " on " + bg;
    console.log(label.padEnd(34) + " → " + flat + "  " + ratio.toFixed(2).padStart(6) + ":1  " + verdict(ratio));
  }
}

console.log("\n=== 3. 白色文字在品牌绿上（大字 vs 小字） ===");
for (const bg of ["brand", "brand-dark"]) {
  const ratio = contrast("#ffffff", TOKENS[bg]);
  const label = "  white on " + bg;
  console.log(label.padEnd(24) + ratio.toFixed(2).padStart(6) + ":1  小字 " + verdict(ratio) + " ／ 大字 " + verdict(ratio, true));
}

console.log("\n=== 4. 分类圆标（此前专门调过，需保留） ===");
console.log("  实测：背景 brand-soft = " + TOKENS["brand-soft"] + "，文字 category-ink = " + TOKENS["category-ink"]);
const catRatio = contrast(TOKENS["category-ink"], TOKENS["brand-soft"]);
console.log("  " + catRatio.toFixed(2) + ":1  " + verdict(catRatio) + "   ⚠️ 这是 36px 圆形里的 600 字重文字");
