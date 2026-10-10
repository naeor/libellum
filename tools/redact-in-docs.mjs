/**
 * Replace one string with another across documentation files, in place.
 *
 * **Why this exists.** On 2026-10-10 a **real, unused invitation code** was found
 * quoted in two places: `docs/README.md`, as an example of what the generator
 * prints, and `docs/DEVLOG.md`, as evidence that the script had been run.
 *
 * Two problems, and the second is the one that matters:
 *
 *  1. the repository is public, so anybody reading it could register an account —
 *     and the codes in the first batch produce **administrators**;
 *  2. the code was still **live**. Invitation codes are stored in plaintext
 *     because they have to be read aloud, so a code in a document is a working
 *     credential rather than a description of one.
 *
 * The fix needed the code gone from *every* commit, not just the tip, which is
 * what `git filter-branch --tree-filter` does — but that runs a program in a
 * temporary checkout, and it took several attempts to get a command through
 * Windows' shell quoting intact. This script is the version that worked, kept
 * because the next person to need it should not have to rediscover that.
 *
 * ⚠️ **The offending string is not written down here**, deliberately: a tool
 * whose job is to remove a credential from a repository must not add it back.
 * Both values arrive as arguments.
 *
 *   node tools/redact-in-docs.mjs <find> <replace> [file...]
 *
 * Defaults to the two files that were affected. Prints each file it changed, so
 * a `git filter-branch --tree-filter` run leaves a record of what it touched.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [find, replace, ...files] = process.argv.slice(2);

if (find === undefined || replace === undefined) {
  process.stderr.write(
    "usage: redact-in-docs.mjs <find> <replace> [file...]\n" +
      "       rewrites files in place; defaults to docs/README.md and docs/DEVLOG.md\n",
  );
  process.exit(2);
}

const targets = files.length > 0 ? files : ["docs/README.md", "docs/DEVLOG.md"];

for (const path of targets) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Not every commit contains every file. Keep going.
    continue;
  }

  const replaced = text.split(find).join(replace);
  if (replaced !== text) {
    writeFileSync(path, replaced);
    process.stdout.write(`redacted ${path}\n`);
  }
}
