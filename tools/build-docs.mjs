// Regenerate the readable exports of the documents.
//
// The Markdown files are the source; the `.docx` files in `docs/` are generated
// for reading and printing, and are git-ignored. Run `pnpm docs:build` after
// editing any of them.
//
// Three things are deliberate here.
//
// **The generator is the project's own converter**, `tools/md2docx.py`. It needs
// `python-docx`, and no single interpreter on a given machine is guaranteed to
// have it — this script therefore probes the likely candidates and picks the
// first that can actually import it, rather than assuming `python` means the
// right one and failing with a confusing traceback.
//
// **`-X utf8` is not decoration.** Without it, a Chinese console code page makes
// the converter fail while printing its own progress, which looks like a
// converter bug and is not one.
//
// **There is no PDF step.** Earlier exports included PDFs produced by
// LibreOffice on a machine that had it; this one does not, and inventing a
// second, worse PDF pipeline to avoid saying so would be dishonest. So the `.md`
// files are the source, the `.docx` files are regenerated here, and the stale
// PDFs are deleted rather than left behind looking current.

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");
const converter = join(root, "tools", "md2docx.py");

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

function canImportDocx(interpreter) {
  const args = interpreter === "py" ? ["-3", "-c", "import docx"] : ["-c", "import docx"];
  try {
    execFileSync(interpreter, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pythonArgs(interpreter, rest) {
  const lead = interpreter === "py" ? ["-3"] : [];
  return [...lead, "-X", "utf8", ...rest];
}

let python = null;
for (const candidate of candidates()) {
  if (canImportDocx(candidate)) {
    python = candidate;
    break;
  }
}

if (python === null) {
  console.error(
    [
      "找不到带 python-docx 的 Python，文档导出已跳过。",
      "",
      "  Markdown 才是源文件，导出件是给人阅读用的，不影响项目运行。",
      "  要重新生成 Word 版，先装一次依赖：",
      "",
      "      pip install python-docx",
      "",
      "  或者用环境变量指定解释器：",
      "",
      "      $env:PYTHON = 'C:\\path\\to\\python.exe'; pnpm docs:build",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(`使用解释器：${python}`);

  /**
   * source Markdown → exported Word file → the export names this document has
   * carried over time, with the title used on its cover.
   *
   * The extra names matter: the English `.md` filenames do not match the Chinese
   * export names (`PLAN.md` exports as `技术方案.docx`), so "replace .md with
   * .pdf" does not find the old PDFs. Listing them explicitly is honest about
   * the mismatch instead of papering over it.
   */
  const DOCUMENTS = [
    ["PLAN.md", "技术方案.docx", "Libellum 记账应用 · 技术方案", ["技术方案.pdf"]],
    ["ROADMAP.md", "制作计划.docx", "Libellum 制作计划与大纲", ["制作计划.pdf", "制作计划与大纲.pdf"]],
    ["BACKLOG.md", "后期待办.docx", "Libellum 后期待办与想法池", ["后期待办.pdf"]],
    ["DEVLOG.md", "开发日志.docx", "Libellum 开发日志", ["开发日志.pdf"]],
    [
      "S6-导出与导入-设计决定.md",
      "S6-导出与导入-设计决定.docx",
      "Libellum S6 · 导出与导入 · 设计决定",
      ["S6-导出与导入-设计决定.pdf"],
    ],
  ];

  // Remove the stale PDFs **first**, not last. They are from an earlier export
  // run on a machine that had LibreOffice, they no longer match the Markdown,
  // and a file that looks authoritative while being wrong is worse than a
  // missing one. Doing it first also means a later failure cannot leave them
  // behind — which is exactly what happened the first time this ran, when the
  // cleanup sat after the conversion loop and the loop never finished.
  for (const [source, , , stalePdfs] of DOCUMENTS) {
    for (const staleName of stalePdfs) {
      const stale = join(docs, staleName);
      if (existsSync(stale)) {
        rmSync(stale);
        console.log(`  – 删除过期的 PDF：${staleName}（本机无 LibreOffice，不再生成 PDF）`);
      }
    }
  }

  let failed = 0;

  for (const [source, target, title] of DOCUMENTS) {
    const from = join(docs, source);
    const to = join(docs, target);

    if (!existsSync(from)) {
      console.error(`  ✗ ${source} 不存在，跳过`);
      failed += 1;
      continue;
    }

    try {
      execFileSync(python, pythonArgs(python, [converter, from, to, "--title", title]), {
        stdio: "inherit",
      });
    } catch (error) {
      console.error(`  ✗ ${source} → ${target} 生成失败：${String(error)}`);
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(`\n${String(failed)} 份文档生成失败。`);
    process.exitCode = 1;
  } else {
    console.log("\n全部 Markdown 已重新导出为 Word（PDF 已按上面的说明处理）。");
  }
}
