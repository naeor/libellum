/**
 * Find every version of a documentation file that still has its line breaks.
 *
 * Written after a history rewrite flattened `docs/DEVLOG.md` and `docs/README.md`
 * into single lines — all of the content, none of the structure — and then the
 * flattened version was pushed. The question this answers is simply: which blob,
 * anywhere in the object database, still has a usable copy?
 *
 * It scans **every blob git knows about**, not just the ones reachable from
 * branches, because the good copy may only survive in a dangling object after a
 * `gc`. For each candidate it reports the line count and which of a few known
 * section headings are present, so the best copy can be chosen by content rather
 * than by guesswork.
 *
 *   node tools/find-intact-blob.mjs docs/DEVLOG.md 先查清 安全事件
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const [path, ...mustContain] = process.argv.slice(2);

if (path === undefined) {
  process.stderr.write("usage: find-intact-blob.mjs <path> [required text...]\n");
  process.exit(2);
}

/** The repository root: this file lives in `tools/`. */
const root = resolve(import.meta.dirname, "..");

const g = (args) =>
  execFileSync("git", args, { cwd: root, maxBuffer: 512 * 1024 * 1024 }).toString("latin1");

const candidates = [];

for (const line of g(["rev-list", "--objects", "--all"]).split("\n")) {
  const [sha, objectPath] = line.split(" ");
  if (objectPath !== path) continue;
  candidates.push(sha);
}

for (const line of g(["fsck", "--unreachable", "--no-reflogs", "--dangling"]).split("\n")) {
  const m = line.match(/^dangling blob ([0-9a-f]{40})$/);
  if (m) candidates.push(m[1]);
}

const seen = new Set();
const rows = [];

for (const sha of candidates) {
  if (seen.has(sha)) continue;
  seen.add(sha);

  let blob;
  try {
    blob = g(["cat-file", "blob", sha]);
  } catch {
    continue;
  }

  const lines = (blob.match(/\n/g) ?? []).length;
  const missing = mustContain.filter((needle) => !blob.includes(needle));

  rows.push({ sha, lines, size: blob.length, missing });
}

rows.sort((a, b) => b.lines - a.lines);

process.stdout.write(`scanned ${String(rows.length)} blobs for ${path}\n\n`);
for (const row of rows.slice(0, 15)) {
  const ok = row.missing.length === 0 ? "complete" : `missing ${row.missing.join(",")}`;
  process.stdout.write(
    `  ${row.sha.slice(0, 12)}  lines=${String(row.lines).padStart(5)}  bytes=${String(row.size).padStart(7)}  ${ok}\n`,
  );
}

const best = rows.find((row) => row.missing.length === 0 && row.lines > 50);
process.stdout.write(
  best === undefined
    ? "\nno complete intact version found\n"
    : `\nbest: ${best.sha}\n`,
);
