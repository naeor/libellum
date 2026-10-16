// Regenerate the readable exports of every document.
//
// The Markdown files are the source; `docs/*.docx` and `docs/*.pdf` are
// generated for reading and printing, and are git-ignored. Run `pnpm docs:build`
// after editing any of them.
//
// Five things are deliberate here.
//
// **The generator is the project's own converters**, `tools/md2docx.py` and
// `tools/md2pdf.py`. They need `python-docx` and `fpdf2`, and no single
// interpreter on a given machine is guaranteed to have them — this script
// therefore probes the likely candidates and picks the first that can actually
// import them, rather than assuming `python` means the right one and failing
// with a confusing traceback.
//
// **`-X utf8` is not decoration.** Without it, a Chinese console code page makes
// the converters fail while printing their own progress, which looks like a
// converter bug and is not one.
//
// ⚠️ **The document list is discovered, not hand-maintained.** Until 1.10.01 it
// was a literal array, and that array had already failed twice in the same way:
// `S8-冲突-设计决定.md` — the document carrying the entire conflict rule — was
// missing from it *entirely*, and later three of the four newest design
// documents had no Word version at all. **A list that must be updated by hand is
// a list that will be out of date**, so this walks the tree instead and only
// keeps a table of titles.
//
// ⚠️ **Both formats come out of the same pass.** The owner asked for it in as
// many words: **"所有的 markdown 文件最好都有一个 word 阅读版……如果可以的话，
// 最好还有个 PDF，PDF 读起来比 word 省心。"** There is no LibreOffice, pandoc or
// wkhtmltopdf on this machine, so `md2pdf.py` reads the Markdown directly rather
// than converting the `.docx` — the same reasoning `md2docx.py` records.
//
// **There is no PDF step that depends on an external office suite**, and the
// stale-PDF cleanup stays: a file that looks authoritative while being wrong is
// worse than a missing one.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");
const archive = join(docs, "归档");
const docxConverter = join(root, "tools", "md2docx.py");
const pdfConverter = join(root, "tools", "md2pdf.py");

/**
 * Interpreters to try, best first.
 *
 * `PYTHON` wins so anyone can point this at their own environment. The DSH
 * runtime is here because that is where this project is developed; the plain
 * names are the ordinary case on someone else's machine.
 */
function candidates() {
  const list = [];
  if (process.env["PYTHON"]) list.push(process.env["PYTHON"]);

  const home = process.env["DSH_HOME"];
  if (home) {
    list.push(
      join(home, "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "python.exe"),
    );
  }

  // `py -3` first on Windows: it resolves to a real install, whereas a bare
  // `python` can be the Microsoft Store stub that opens the store instead.
  list.push("py", "python3", "python");
  return list;
}

function canImport(interpreter, module) {
  const args = interpreter === "py" ? ["-3", "-c", `import ${module}`] : ["-c", `import ${module}`];
  try {
    execFileSync(interpreter, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pythonFor(module) {
  for (const candidate of candidates()) {
    if (canImport(candidate, module)) return candidate;
  }
  return null;
}

function pythonArgs(interpreter, rest) {
  const lead = interpreter === "py" ? ["-3"] : [];
  return [...lead, "-X", "utf8", ...rest];
}

/**
 * Titles for the documents, keyed by source path relative to `docs/`.
 *
 * Anything not listed gets a title derived from its filename — which is a fine
 * default and is why this table does not have to be complete. It exists so the
 * important documents get the name the owner knows them by.
 *
 * ⚠️ **Titles follow the current brand (2026-10-14, Libellum → Libevra)**, and
 * `版本记录（1.08-1.09）.md` is the one exception worth naming: it *is* history,
 * so its title says so — the old name is the subject of that document, not a
 * stale label on a current one. See `docs/Libevra品牌迁移记录.md`.
 */
const TITLES = {
  "README.md": "Libevra · docs 目录说明",
  "交接.md": "Libevra · 交接：从这里开始",
  "教训.md": "Libevra · 教训",
  "版本记录（1.10）.md": "Libevra · 版本记录（1.10）",
  "版本记录（1.08-1.09）.md": "Libellum（原名）· 版本记录（1.08-1.09）· 历史存档",
  "ROADMAP.md": "Libevra 制作计划与大纲",
  "PLAN.md": "Libevra 记账应用 · 技术方案",
  "BACKLOG.md": "Libevra 后期待办与想法池",
  "COLORS.md": "Libevra · 颜色清单与语义分类",
  "DEVLOG.md": "Libevra 开发日志",
  "BUG记录.md": "Libevra · BUG 记录",
  "海浪效果要求.md": "Libevra · 海浪效果要求与实现交接",
  "管理员与权限边界-设计决定.md": "Libevra · 系统管理员与权限边界 · 设计决定",
  "S12-A上线前安全与发布准备.md": "Libevra · S12-A 上线前安全与发布准备",
  "生产环境与运维手册.md": "Libevra · 生产环境与运维手册",
  "生产环境日常掌控速查.md": "Libevra · 生产环境日常掌控速查",
  "运维上手教程.md": "Libevra · 运维上手教程（零基础）",
  "部署记录-S12-B.md": "Libevra · S12-B 部署记录（已上线）",
  "Libevra服务器部署与日常维护入门.md": "Libevra · 服务器部署与日常维护入门",
  "Libevra品牌迁移记录.md": "Libevra · 品牌迁移记录（原名 Libellum）",
  "归档/README.md": "Libevra · 归档说明：这里的东西接近被废弃",
  "归档/归档说明.md": "Libevra · 1.10.01 文档整理记录",
  "归档/S6-导出与导入-设计决定.md": "Libevra S6 · 导出与导入 · 设计决定",
  "归档/协作与多账本-设计决定.md": "Libevra · 协作与多账本 · 设计决定",
  "归档/S8-离线写入-设计决定.md": "Libevra S8 · 离线写入 · 设计决定",
  "归档/S8-冲突-设计决定.md": "Libevra S8 · 冲突 · 设计决定",
  "归档/离线与同步-设计决定.md": "Libevra · 离线与同步 · 设计决定",
  "归档/账本与协作页-设计决定.md": "Libevra · 账本与协作页 · 设计决定",
  "归档/账本空间-展示态-设计决定.md": "Libevra · 开始页面展示态 · 设计决定",
  "归档/邀请码-示例.md": "Libevra · 邀请码格式示例",
};

/**
 * Directories under `docs/` that hold reading reports and other working papers,
 * not documents the owner reads on a phone. Excluded on purpose, and named here
 * so the exclusion is a decision rather than an oversight.
 */
const SKIP_DIRS = new Set(["阅读报告"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === archive && SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function titleFor(rel) {
  if (TITLES[rel]) return TITLES[rel];
  const base = rel.replace(/\.md$/i, "").split("/").pop();
  return `Libevra · ${base}`;
}

/**
 * Files in `docs/` that are deliberately *not* generated.
 *
 * ⚠️ **`恢复码.docx` must stay.** It is the only document in the repository with
 * no Markdown source, it is not produced by this script, and the owner asked
 * explicitly that it be kept. Anyone tidying the folder — including an AI —
 * will read it as an orphan. It is not one.
 */
const NEVER_DELETE = new Set(["恢复码.docx"]);

const docxPython = pythonFor("docx");
const pdfPython = pythonFor("fpdf");

if (docxPython === null) {
  console.error(
    [
      "找不到带 python-docx 的 Python，文档导出已跳过。",
      "",
      "  Markdown 才是源文件，导出件是给人阅读用的，不影响项目运行。",
      "  要重新生成 Word 版，先装一次依赖：",
      "",
      "      pip install python-docx fpdf2",
      "",
      "  或者用环境变量指定解释器：",
      "",
      "      $env:PYTHON = 'C:\\path\\to\\python.exe'; pnpm docs:build",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(`Word  使用解释器：${docxPython}`);
  if (pdfPython === null) {
    console.warn(
      "⚠️ 找不到带 fpdf2 的 Python，PDF 已跳过（Word 仍会生成）。\n" +
        "   装一次即可：pip install fpdf2\n",
    );
  } else {
    console.log(`PDF   使用解释器：${pdfPython}`);
  }

  const sources = walk(docs).sort();
  console.log(`发现 ${String(sources.length)} 份 Markdown。\n`);

  // Every generated file this run is going to write, so that anything left over
  // from an earlier layout can be removed. Renaming an export used to leave the
  // old name behind looking current.
  const produced = new Set();
  for (const from of sources) {
    const rel = relative(docs, from).split("\\").join("/");
    const base = rel.replace(/\.md$/i, "");
    const name = base.split("/").pop();
    produced.add(`${name}.docx`);
    produced.add(`${name}.pdf`);
  }

  // ⚠️ **Stale cleanup runs first, not last.** A file that looks authoritative
  // while being wrong is worse than a missing one, and doing it after the
  // conversions means a later failure strands them — which is what happened the
  // first time this script ran.
  let removed = 0;
  for (const name of readdirSync(docs)) {
    if (NEVER_DELETE.has(name)) continue;
    if (!/\.(docx|pdf)$/i.test(name)) continue;
    if (produced.has(name)) continue;
    rmSync(join(docs, name));
    console.log(`  – 删除已不再生成的旧产物：${name}`);
    removed += 1;
  }
  // Same rule one level down: `docs/*/` must not accumulate generated copies,
  // which is how three stale `.docx` files ended up sitting inside the old
  // `档案/` folder looking exactly like the current ones.
  for (const dir of [archive]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isFile()) continue;
      if (!/\.(docx|pdf)$/i.test(name)) continue;
      rmSync(full);
      console.log(`  – 删除子目录里的过期生成物：${relative(root, full)}`);
      removed += 1;
    }
  }
  if (removed > 0) console.log("");

  let failed = 0;

  for (const from of sources) {
    const rel = relative(docs, from).split("\\").join("/");
    const base = rel.replace(/\.md$/i, "");
    const stem = base.split("/").pop();
    const title = titleFor(rel);
    const docx = join(docs, `${stem}.docx`);
    const pdf = join(docs, `${stem}.pdf`);

    try {
      execFileSync(docxPython, pythonArgs(docxPython, [docxConverter, from, docx, "--title", title]), {
        stdio: "inherit",
      });
    } catch (error) {
      console.error(`  ✗ ${rel} → Word 生成失败：${String(error)}`);
      failed += 1;
    }

    if (pdfPython !== null) {
      try {
        execFileSync(pdfPython, pythonArgs(pdfPython, [pdfConverter, from, pdf, "--title", title]), {
          stdio: "inherit",
        });
      } catch (error) {
        console.error(`  ✗ ${rel} → PDF 生成失败：${String(error)}`);
        failed += 1;
      }
    }
  }

  if (failed > 0) {
    console.error(`\n${String(failed)} 份文档生成失败。`);
    process.exitCode = 1;
  } else {
    const formats = pdfPython === null ? "Word" : "Word 与 PDF";
    console.log(`\n全部 ${String(sources.length)} 份 Markdown 已重新导出为 ${formats}。`);
  }
}
