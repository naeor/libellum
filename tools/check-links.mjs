/**
 * 检查文档里的**相对链接**是否真的指向磁盘上存在的文件。
 *
 * ⚠️ **为什么这件事需要一个脚本。**
 *
 * 2026-10-13（1.10.01）把 `docs/档案/` 并进了 `docs/归档/`，**目录搬了，引用没跟着搬**——
 * 根 `README.md` 与 `README.zh-CN.md` 里 4 个链接就此失效，**而且过了两轮都没人发现**，
 * 直到 2026-10-14 做品牌改名审计时才被 grep 撞见。
 *
 * **这正是本项目反复写下的那条教训的又一个实例**（`教训.md` §8.1）：
 * **"改完一处，立刻 grep 核实它真的落地了"** ——
 * 而"跨文档引用"是那种**改了 A 就不会有人去看 B** 的地方，所以它必须自动化。
 *
 * ⚠️ **只检查相对链接。**
 * `http(s)://` 一律跳过：网络检查会让这个脚本在没网时失败，而"没网"和"链接坏了"是两件事。
 * 外链要不要活着是另一个问题，不该混进"文档互相指得对不对"里。
 *
 * ⚠️ **它必须能证明自己真的扫到了东西。**
 * 一个因为正则写错而"零失败"的检查器，和通过长得一模一样——
 * 所以文件数与链接数都会被打印，低于下限直接报错。
 *
 * 用法：
 *
 *   node tools/check-links.mjs            # 只报错
 *   node tools/check-links.mjs --list     # 连通过的也列出来
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIST = process.argv.includes("--list");

/**
 * ⚠️ **`归档/` 也在检查范围内。**
 * 归档文档照样会被读到，一个指向不存在文件的链接在归档里和在别处一样坏。
 * 唯一不查的是阅读报告目录：那是"通读一遍"留下的过程稿，随时可能被删。
 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "_backups", "阅读报告"]);

/** 至少要有这么多，否则说明扫描本身出了问题。 */
const MIN_FILES = 20;
const MIN_LINKS = 50;

function walkMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkMarkdown(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 去掉围栏代码块与行内代码。
 *
 * ⚠️ **必须去，否则会报一堆假错。** 本项目文档里有大量命令与路径示例
 * （例如 `docs/README.md` 里的 `pnpm docs:build`、`归档` 文档里的目录树），
 * 它们里面的 `(...)` 与 `[...]` 不是链接。**惩罚示例的检查器会被关掉**，
 * 那就等于没有检查器。
 */
function stripCode(text) {
  return text
    .replace(/^```[\s\S]*?^```/gm, "")
    .replace(/^~~~[\s\S]*?^~~~/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

/** `[label](target)`，以及 `[label](target "title")`。 */
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const files = walkMarkdown(ROOT).sort();
let checked = 0;
let skippedExternal = 0;
let skippedAnchor = 0;
const broken = [];
const ok = [];

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const text = stripCode(raw);

  // Line numbers come from the stripped text, which preserves line breaks.
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(LINK)) {
      let target = match[1];

      if (/^(https?:|mailto:|tel:)/i.test(target)) {
        skippedExternal += 1;
        continue;
      }
      if (target.startsWith("#")) {
        skippedAnchor += 1;
        continue;
      }

      // Drop an anchor: `file.md#section` -> `file.md`.
      const hash = target.indexOf("#");
      if (hash !== -1) target = target.slice(0, hash);

      // Decode %20 etc. so a URL-encoded filename can be found on disk.
      try {
        target = decodeURIComponent(target);
      } catch {
        /* leave it as written; the existence check will report it */
      }
      if (target === "") {
        skippedAnchor += 1;
        continue;
      }

      const absolute = target.startsWith("/")
        ? join(ROOT, target)
        : resolve(dirname(file), target);

      /** A link is good if it names something that exists — a file or a directory. */
      let found = false;
      try {
        found = statSync(absolute) !== undefined;
      } catch {
        found = false;
      }

      checked += 1;
      const record = {
        from: relative(ROOT, file),
        line: index + 1,
        target,
        to: relative(ROOT, absolute),
      };

      if (found) {
        ok.push(record);
      } else {
        broken.push(record);
      }
    }
  });
}

// ---- The check must be able to prove it looked at something. ----------------
if (files.length < MIN_FILES) {
  console.error(`❌ 只找到 ${String(files.length)} 份 Markdown（少于 ${String(MIN_FILES)}），扫描本身有问题。`);
  process.exit(1);
}
if (checked < MIN_LINKS) {
  console.error(`❌ 只检查了 ${String(checked)} 个相对链接（少于 ${String(MIN_LINKS)}），扫描本身有问题。`);
  process.exit(1);
}

if (LIST) {
  for (const item of ok) {
    console.log(`  ok   ${item.from}:${String(item.line)} -> ${item.to}`);
  }
}

console.log(`扫描 ${String(files.length)} 份 Markdown，检查 ${String(checked)} 个相对链接` +
  `（跳过外链 ${String(skippedExternal)} 个、纯锚点 ${String(skippedAnchor)} 个）`);

if (broken.length === 0) {
  console.log("✅ 没有失效的相对链接");
  process.exit(0);
}

console.error(`\n❌ 发现 ${String(broken.length)} 个失效的相对链接：\n`);
for (const item of broken) {
  console.error(`  ${item.from}:${String(item.line)}`);
  console.error(`      写的：${item.target}`);
  console.error(`      解析为：${item.to}（不存在）`);
}
process.exit(1);
