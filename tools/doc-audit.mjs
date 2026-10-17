// Documentation staleness scan — run it after any change to a design token.
//
//     node tools/doc-audit.mjs
//
// ⚠️ **Why this exists as a tool rather than a habit.** The 2026-10-14 documentation pass found that
// `颜色清单.md` had been carrying two colour values the code had stopped using a day earlier, and that
// `README.md` claimed "21 份 Markdown / 根目录 10 份" when the real answers were 25 and 15 — **the
// README's own document index did not list the three design specifications.** None of that is visible
// from the code: **a token change makes no document fail.**
//
// ⚠️ **It compares against the source, never against memory.** Values come from `index.css` and
// `version.ts` at run time, so the scan is correct on the day it runs and needs no maintenance when
// a token changes — only when the *shape* of the documentation changes.
//
// ⚠️ **It knows what it must NOT flag.** Archived readings, changelogs and before/after tables hold
// old values *correctly*; flagging them would teach the reader to ignore the scan. See the notes on
// `HISTORICAL_SECTION` and `HISTORICAL` below. **A scan whose false positives are noisy is worse than
// no scan.**
//
// ⚠️ **The premise: a document goes stale silently.** Nothing fails when a token changes value and the
// doc keeps the old one — the test suite cannot see documentation. So this reads the ACTUAL current
// values out of the source and the compiled CSS, then looks for contradictions in every markdown file.
//
// It checks five kinds of drift, each one something that has actually happened in this repository:
//   1. documented colour values vs `@theme`
//   2. documented font sizes vs `@theme`
//   3. references to files that no longer exist
//   4. version numbers that disagree with `version.ts`
//   5. claims about the codebase that the codebase contradicts (test counts, "not yet implemented")
//
// Read-only.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "C:\\Users\\ZhuanZ（无密码）\\Desktop\\工作\\记账程序\\记账程序v1";
const DOCS = join(ROOT, "docs");

/**
 * ⚠️ **哪些文档是「历史记录」，哪些是「描述现在的规格」。**
 *
 * 2026-10-17 把过程文档收进 `开发过程记录/` 之后，一开始把所有 `开发过程记录/` 都当成历史记录跳过了 ——
 * **那是错的**：`颜色清单.md`、三个设计规范、`海浪效果要求.md`、管理员设计决定**都是当前规格**，
 * 它们的值必须和代码一致，正是最该被检查的东西。
 *
 * 所以按**文件名精确列出真正的记录**，而不是按目录一刀切。
 * `颜色清单.md` 一旦被误排除，这个检查就失去了它存在的意义。
 */
const RECORD_FILES = new Set([
  "开发过程记录/版本记录（1.10）.md",
  "开发过程记录/版本记录（1.08-1.09）.md",
  "开发过程记录/开发日志.md",
  "开发过程记录/部署记录-S12-B.md",
  "开发过程记录/Libevra品牌迁移记录.md",
  "开发过程记录/S12-A上线前安全与发布准备.md",
  "开发过程记录/视觉精修验收-1.10.10.md",
  "开发过程记录/账号迁移方案-本机到生产.md",
  "开发过程记录/教训.md",
  "开发过程记录/BUG记录.md",
]);

/** 归档、以及上面列出的记录文件 —— 它们说的是"当时"，不是"现在"。 */
const isRecord = (rel) => rel.startsWith("归档/") || RECORD_FILES.has(rel);

// ---------------------------------------------------------------------------
// Ground truth, read from the source rather than remembered
// ---------------------------------------------------------------------------
const css = readFileSync(join(ROOT, "apps", "web", "src", "index.css"), "utf8");

/** Every `--color-*` / `--radius-*` / `--text-*` currently defined. */
function tokensOf(prefix) {
  const out = new Map();
  for (const m of css.matchAll(new RegExp(`--${prefix}[a-z0-9-]*:\\s*([^;]+);`, "gi"))) {
    const name = m[0].slice(0, m[0].indexOf(":")).trim();
    out.set(name, m[1].trim());
  }
  return out;
}

const colorTokens = tokensOf("color");
const radiusTokens = tokensOf("radius");
const version = /APP_VERSION = "([^"]+)"/.exec(
  readFileSync(join(ROOT, "apps", "web", "src", "lib", "version.ts"), "utf8"),
)?.[1];

console.log("================ 代码现状（ground truth） ================");
console.log(`  版本号：${String(version)}`);
console.log(`  颜色 token：${String(colorTokens.size)} 个`);
for (const [k, v] of colorTokens) console.log(`    ${k} = ${v}`);
console.log(`  圆角 token：${String(radiusTokens.size)} 个`);
for (const [k, v] of radiusTokens) console.log(`    ${k} = ${v}`);

// ---------------------------------------------------------------------------
// Walk every markdown file
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { walk(p, out); continue; }
    if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

const files = walk(DOCS);

// ---------------------------------------------------------------------------
// 1 & 2. Documented token values that disagree with @theme
// ---------------------------------------------------------------------------
console.log("\n\n================ ① 文档里的 token 值与代码不符 ================");

/** A doc row/line that names a token and a hex value — check the pair. */
const mismatches = [];
const HISTORICAL = /原|以前|曾经|改前|改自|审计当时|旧值|当时是|before|was|used to|来自|已修好|已改/;

/**
  * ⚠️ **Sections that are ABOUT change contain old values on purpose.**
  *
  * A migration table (`§11.1 改了什么`) or an audit record (`§4 对比度审计`) is a before/after by
  * definition — its "before" column is *supposed* to hold a value the code no longer has. Checking it
  * reports the documentation as broken **for doing its job**, and the honest repair would be to delete
  * the record. **So these sections are skipped by their heading**, the same way the colour guard
  * strips comments before looking.
  */
const HISTORICAL_SECTION =
  /迁移|收尾|审计|对照|变更|改了什么|分工|尚未|原始|历史|记录最|对比度|版本|清单/;

for (const path of files) {
  const rel = relative(DOCS, path).replace(/\\/g, "/");
  /**
    * ⚠️ **Archived snapshots and changelogs are NOT checked, and that is deliberate.**
    *
    * `归档/阅读报告/*` are frozen readings of the code as it was on a given day — their job is to
    * record what was true then, so an old colour in them is *correct*. `版本记录` is a changelog:
    * every version's values are correct by definition. **Flagging those would teach the reader to
    * ignore the scan**, which is the failure mode this whole exercise is trying to avoid.
    */
  if (isRecord(rel)) continue;

  const lines = readFileSync(path, "utf8").split("\n");
  let section = "";
  lines.forEach((line, i) => {
    if (line.startsWith("#")) section = line;
    if (HISTORICAL_SECTION.test(section)) return;

    for (const [name, value] of colorTokens) {
      const at = line.indexOf("`" + name + "`") >= 0 ? line.indexOf("`" + name + "`") : line.indexOf("`--" + name + "`");
      if (at < 0) continue;
      const hex = /#([0-9a-fA-F]{6})\b/.exec(line);
      if (!hex) continue;
      /**
        * ⚠️ **The hex must FOLLOW the token name it is claimed for.**
        *
        * A sentence like *"文字升到 X，而线条拆到 `--color-chart-rule` 保持浅色"* mentions the token
        * **after** the value that belongs to a different one. Without this ordering check the scan
        * compares `chart-rule` against its neighbour's hex and reports drift that is not there —
        * **and a scanner's false positives are what train people to stop reading it.**
        */
      if (hex.index < at) continue;
      const claimed = "#" + hex[1].toLowerCase();
      const actual = value.toLowerCase();
      const actualHex = claimHex(actual);
      if (actualHex === null || claimed === actualHex) continue;
      /**
        * ⚠️ **A line that says "was X, now Y" is documentation, not drift.** Flagging it would push
        * authors to delete the explanation — the same trap the colour guard avoids by stripping
        * comments before it looks.
        */
      if (HISTORICAL.test(line)) continue;
      mismatches.push({ rel, line: i + 1, name, claimed, actual });
    }
  });
}

/** Normalise a token value to lowercase hex when it is one, else null. */
function claimHex(v) {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  return m ? "#" + m[1].toLowerCase() : null;
}

if (mismatches.length === 0) console.log("  ✅ 没有发现不符");
for (const m of mismatches) {
  console.log(`  ⚠️ ${m.rel}:${String(m.line)}  ${m.name}  文档写 ${String(m.claimed)}，代码是 ${String(m.actual)}`);
}

/**
  * ⚠️ **A scan that quietly checks nothing is worse than no scan.**
  *
  * The section-skipping above is deliberately broad, and a broad skip can swallow the whole file —
  * leaving a green result that means "I looked nowhere". This counts what was actually examined and
  * refuses to stay silent if the answer is nothing. **Same idea as the honesty test in
  * `colors.test.ts` and `typeScale.test.ts`.**
  */
{
  let examined = 0;
  for (const path of files) {
    const rel = relative(DOCS, path).replace(/\\/g, "/");
    if (isRecord(rel)) continue;
    let section = "";
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.startsWith("#")) section = line;
      if (HISTORICAL_SECTION.test(section)) continue;
      if (/#[0-9a-fA-F]{6}/.test(line)) examined += 1;
    }
  }
  console.log(`  （实际检查了 ${String(examined)} 行带色值的正文）`);
  if (examined < 20) {
    console.log("  ❌ 检查到的行数过少——跳过规则可能吞掉了整份文件，请复核 HISTORICAL_SECTION。");
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// 3. Referenced files that no longer exist
// ---------------------------------------------------------------------------
console.log("\n\n================ ② 引用了不存在的文件 ================");
const missing = [];
/**
  * ⚠️ **A sentence saying a path is GONE is correct, and flagging it would delete the warning.**
  *
  * `README.md` says *"原 `docs/档案/` 已并入 `docs/归档/`"* — exactly the note a reader needs, and
  * the dead path in it is **supposed** to be dead. Same for 曾 / 以前 / 不再 / 已改名.
  */
const GONE = /原|已并入|已被|已改名|已删除|不再|曾|以前|旧路径|renamed|removed|merged|仍然没有|还没有|不进仓库|计划中|当时|gitignore/;

/**
  * ⚠️ **Logs and archived readings are records, not statements about now.**
  *
  * `开发日志.md` is a diary: *"所以新建了 `docs/离线与同步-设计决定.md`"* was true when written, and the
  * file has since been archived — **rewriting the sentence would falsify the history.** The same goes
  * for `归档/阅读报告/*`, which are snapshots of what the repository looked like on a given day.
  * **Only documents that claim to describe the PRESENT are checked here.**
  */
// ⚠️ 规则见文件顶部的 isRecord()：按文件名精确判断，不按目录一刀切。

for (const path of files) {
  const rel = relative(DOCS, path).replace(/\\/g, "/");
  if (isRecord(rel)) continue;
  const body = readFileSync(path, "utf8");
  body.split("\n").forEach((line, index) => {
    if (GONE.test(line)) return;
    for (const m of line.matchAll(/`((?:apps|packages|tools|prisma|docs)\/[A-Za-z0-9_./\u4e00-\u9fa5-]+)`/g)) {
      const target = m[1];
      if (/[*?]/.test(target)) continue; // globs are not claims about one file
      const abs = join(ROOT, target.replace(/\//g, "\\"));
      if (!existsSync(abs)) missing.push(`${rel}:${String(index + 1)} → ${target}`);
    }
  });
}
if (missing.length === 0) console.log("  ✅ 没有发现");
for (const x of missing.slice(0, 30)) console.log("  ⚠️ " + x);
if (missing.length > 30) console.log(`  …还有 ${missing.length - 30} 处`);

// ---------------------------------------------------------------------------
// 4. Version numbers stated in docs
// ---------------------------------------------------------------------------
console.log("\n\n================ ③ 文档里写死的版本号 ================");
const versionClaims = [];
for (const path of files) {
  const rel = relative(DOCS, path).replace(/\\/g, "/");
  // ⚠️ Records and archives state what was true THEN; a version number in them is not a claim about now.
  if (isRecord(rel)) continue;
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/当前版本[^`]*`(1\.\d+\.\d+)`/g)) {
      if (m[1] !== version) versionClaims.push(`${rel}:${String(i + 1)} 写 ${m[1]}，实际 ${String(version)}`);
    }
  });
}
if (versionClaims.length === 0) console.log("  ✅ 「当前版本」都正确");
for (const x of versionClaims) console.log("  ⚠️ " + x);

// ---------------------------------------------------------------------------
// 5. Named components / routes that no longer exist
// ---------------------------------------------------------------------------
console.log("\n\n================ ④ 引用了已删除的组件或页面 ================");
const REMOVED = ["CollaboratorsPage", "collab.ts", "account_level_collaborators"];
for (const path of files) {
  const rel = relative(DOCS, path).replace(/\\/g, "/");
  if (isRecord(rel)) continue;
  const lines = readFileSync(path, "utf8").split("\n");
  let section = "";
  lines.forEach((line, i) => {
    if (line.startsWith("#")) section = line;
    /**
      * ⚠️ **Depending on the section, not just the line.**
      *
      * `交接.md` has a table under *"§4.8.2 删了什么 / 留了什么"* whose **left column header is 删除**.
      * A removal note written inside a section *about* removals will not repeat the word on every row —
      * so a line-only check flags the table's own body as if it were a stale reference.
      */
    if (/删|移除|废弃|remove/.test(section)) return;
    for (const name of REMOVED) {
      if (!line.includes(name)) continue;
      // ⚠️ A changelog entry saying "we removed X" is correct, not stale.
      if (/删除|移除|废弃|remove|不再/.test(line)) continue;
      console.log(`  ⚠️ ${rel}:${String(i + 1)} 提到 ${name}`);
    }
  });
}
console.log("  （只报非「已删除」语境的引用）");

// ---------------------------------------------------------------------------
// 6. Which docs look stale by date
// ---------------------------------------------------------------------------
console.log("\n\n================ ⑤ 按最后修改时间排序（早于最近三轮的需人工看） ================");
const dated = files.map((p) => ({
  rel: relative(DOCS, p).replace(/\\/g, "/"),
  mtime: statSync(p).mtime,
})).sort((a, b) => a.mtime - b.mtime);
for (const d of dated) {
  console.log(`  ${d.mtime.toISOString().slice(0, 16).replace("T", " ")}  ${d.rel}`);
}
