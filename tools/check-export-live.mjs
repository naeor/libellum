/**
 * Exercise export and import against the running server, as a person would.
 *
 * Integration tests use `app.inject`; this goes over the network to the server
 * that is actually running, which is the only way to know the routes are wired
 * into the process the browser talks to.
 *
 *   node tools/check-export-live.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const env = {};
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
}

const API = `http://127.0.0.1:${env["API_PORT"] ?? "3000"}/api/v1`;

const login = await fetch(`${API}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "http://localhost:5173" },
  body: JSON.stringify({ username: "naeor", password: "libellum-2026" }),
});
const cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0] ?? "";
console.log(`登录 naeor：HTTP ${login.status}\n`);

async function get(path) {
  return fetch(`${API}${path}`, { headers: { cookie, origin: "http://localhost:5173" } });
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
const csv = await get("/export?format=csv");
// Read the bytes, not the decoded string: `response.text()` decodes UTF-8 and
// consumes the BOM, so a string-based check would report a missing BOM on a
// file that has one. (The first version of this script did exactly that, and
// the byte-level look below is what disproved it.)
const csvBytes = Buffer.from(await csv.arrayBuffer());
const csvText = csvBytes.toString("utf8");
writeFileSync(join(root, "_check-export.csv"), csvBytes);

const hasBom = csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf;

console.log("=== CSV ===");
console.log(`  HTTP ${csv.status}`);
console.log(`  BOM: ${hasBom ? "有 ✓ (ef bb bf)" : "没有 ✗"}`);
console.log(`  Out- 编号: ${csv.headers.get("x-libellum-file-ref")}`);
console.log(`  行数: ${csv.headers.get("x-libellum-row-count")}`);
console.log(`  文件名: ${csv.headers.get("content-disposition")?.slice(0, 90)}`);

const lines = csvText.replace(/^\uFEFF/, "").split("\r\n").filter((line) => line !== "");

console.log(`  表头: ${lines[0]}`);
console.log(`  第一行数据: ${lines[1]}`);

// A note that begins with a formula character must come out with an apostrophe
// in front of it. Counted rather than asserted, because this ledger may well
// have none.
console.log(`  公式转义（行内出现 ,'=）：${String(lines.filter((line) => line.includes(",'")).length)}`);

const amounts = lines.slice(1).map((line) => Number(line.split(",")[4]));
console.log(`  金额可解析为数字: ${amounts.every((value) => Number.isFinite(value)) ? "是 ✓" : "否 ✗"}`);
console.log(`  金额合计（负数支出 + 正数收入）: ${amounts.reduce((sum, value) => sum + value, 0).toFixed(2)}`);

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------
const xlsx = await get("/export?format=xlsx");
const xlsxBuffer = Buffer.from(await xlsx.arrayBuffer());
writeFileSync(join(root, "_check-export.xlsx"), xlsxBuffer);

console.log("\n=== XLSX ===");
console.log(`  HTTP ${xlsx.status}`);
console.log(`  类型: ${xlsx.headers.get("content-type")}`);
console.log(`  大小: ${String(xlsxBuffer.length)} 字节`);
console.log(`  ZIP 头: ${xlsxBuffer.readUInt32LE(0) === 0x04034b50 ? "正确 ✓" : "错误 ✗"}`);
console.log(`  文件: _check-export.xlsx（可以用 Excel 打开试试）`);

// ---------------------------------------------------------------------------
// Import the file we just exported — it must be recognised as already here
// ---------------------------------------------------------------------------
const form = new FormData();
form.append("fileId", crypto.randomUUID());
form.append("file", new Blob([csvText], { type: "text/csv" }), "round-trip.csv");

const imported = await fetch(`${API}/import`, {
  method: "POST",
  headers: { cookie, origin: "http://localhost:5173" },
  body: form,
});
const report = await imported.json();

console.log("\n=== 把刚导出的文件再导回来（应当全部识别为已存在） ===");
console.log(`  HTTP ${imported.status}`);
console.log(`  ${JSON.stringify(report, null, 2).split("\n").slice(0, 12).join("\n  ")}`);

// ---------------------------------------------------------------------------
// Export log
// ---------------------------------------------------------------------------
const log = await get("/export-log");
const logBody = await log.json();

console.log("\n=== 导出审计（只记元数据） ===");
console.log(`  HTTP ${log.status}，共 ${String(logBody.entries.length)} 条`);
for (const entry of logBody.entries.slice(0, 3)) {
  console.log(
    `    ${entry.fileRef}  ${entry.format}  ${String(entry.rowCount)} 行  ${entry.createdAt}  by ${entry.by}`,
  );
}
