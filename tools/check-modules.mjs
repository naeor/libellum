/**
 * ⚠️ **Tries https first, then http.**
 *
 * The LAN dev server serves **https** — it has to, because the recording and
 * offline APIs are secure-context only — while the loopback-only server serves
 * http. Picking one would mean this check reports "13 modules failed" every time
 * the other server is running, which reads as a broken build rather than a
 * mismatched address.
 *
 *   node tools/check-modules.mjs
 */

/** `LIBELLUM_CHECK_BASE` overrides both, for a server on another port. */
const CANDIDATES = [
  process.env["LIBELLUM_CHECK_BASE"],
  "https://127.0.0.1:5173",
  "http://127.0.0.1:5173",
].filter((value) => value !== undefined && value !== "");

const MODULES = [
  "/src/main.tsx",
  "/src/App.tsx",
  "/src/pages/DetailPage.tsx",
  "/src/pages/ExportPage.tsx",
  "/src/pages/ImportPage.tsx",
  "/src/pages/ScanPage.tsx",
  "/src/pages/RecordPage.tsx",
  "/src/pages/AddEntryPage.tsx",
  "/src/pages/VoiceReviewPage.tsx",
  "/src/lib/api.ts",
  "/src/lib/queries.ts",
  "/src/lib/share.ts",
  "/src/lib/speech.ts",
  "/src/lib/voiceRipples.ts",
  "/src/lib/useVoiceRecorder.ts",
  "/src/lib/uuid.ts",
  "/src/components/ConfirmDialog.tsx",
  "/src/components/ChoiceDialog.tsx",
  "/src/components/VoiceRipples.tsx",
  "/src/components/EntryForm.tsx",
  "/src/components/Layouts.tsx",
];

/**
 * A self-signed certificate is the normal state of the LAN server, so the check
 * must not fail on it. This is a local development tool talking to a local
 * development server; there is nothing to protect.
 */
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

let BASE = CANDIDATES[0];

for (const candidate of CANDIDATES) {
  try {
    const response = await fetch(`${candidate}/src/main.tsx`, { signal: AbortSignal.timeout(5_000) });
    if (response.ok) {
      BASE = candidate;
      break;
    }
  } catch {
    // Try the next one.
  }
}

console.log(`  服务器：${BASE}`);

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
