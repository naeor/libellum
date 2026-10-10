/**
 * Does every module the browser will ask for actually compile?
 *
 * The dev server transforms TypeScript on request, so a syntax error, a bad
 * import path or a missing export shows up here as a 500 with the compiler's
 * complaint — which is exactly the check worth doing before telling somebody to
 * open the page. It is not a substitute for using the interface; it is the part
 * that can be verified without hands.
 *
 *   node tools/check-modules.mjs
 */

const BASE = "http://127.0.0.1:5173";

const MODULES = [
  "/src/main.tsx",
  "/src/App.tsx",
  "/src/pages/DetailPage.tsx",
  "/src/pages/ExportPage.tsx",
  "/src/pages/ImportPage.tsx",
  "/src/pages/ScanPage.tsx",
  "/src/pages/AddEntryPage.tsx",
  "/src/lib/api.ts",
  "/src/lib/queries.ts",
  "/src/lib/share.ts",
  "/src/lib/uuid.ts",
  "/src/components/ConfirmDialog.tsx",
  "/src/components/Layouts.tsx",
];

let failures = 0;

for (const path of MODULES) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${BASE}${path}`);
  } catch (error) {
    console.log(`✗ ${path} — 请求失败：${String(error)}`);
    failures += 1;
    continue;
  }

  const body = await response.text();
  const ms = Date.now() - started;

  // Vite answers 200 with an error payload for some transform failures, so the
  // status alone is not enough: the body is checked too.
  const looksLikeError =
    body.includes("Internal server error") ||
    body.includes("Transform failed") ||
    body.includes("Failed to resolve import") ||
    body.includes("Pre-transform error");

  if (!response.ok || looksLikeError) {
    console.log(`✗ ${path} — HTTP ${String(response.status)} ${String(ms)}ms`);
    console.log(`    ${body.slice(0, 400).replace(/\n/g, "\n    ")}`);
    failures += 1;
    continue;
  }

  console.log(`✓ ${path} — ${String(body.length)} 字节, ${String(ms)}ms`);
}

console.log("");
if (failures > 0) {
  console.log(`${String(failures)} 个模块编译失败。`);
  process.exitCode = 1;
} else {
  console.log("全部模块编译通过。");
}
