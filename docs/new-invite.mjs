/**
 * Generate one usable registration invite, in one double-click.
 *
 * The project is open source but deliberately not open registration, so accounts
 * are created with an invite the owner generates:
 *
 *   pnpm invite:create "给妈妈"
 *
 * That command already does the work, and this script deliberately does not
 * reimplement it — the invite format, the note field and the database access all
 * live in `apps/api/src/scripts/create-invite.ts`, and a second copy of that
 * logic would eventually disagree with the first. What this adds is the part a
 * non-developer needs: a file they can double-click, which finds the repository
 * itself, prints the code clearly, and does not close the window before the code
 * can be read.
 *
 * Also available unattended:
 *
 *   node docs/new-invite.mjs --quiet        # one code, nothing else
 *   node docs/new-invite.mjs --note "妈妈"   # with a note for your own records
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const noteIndex = args.indexOf("--note");
const note = noteIndex >= 0 ? args[noteIndex + 1] : undefined;

function fail(message) {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(1);
}

if (!existsSync(join(root, "pnpm-workspace.yaml"))) {
  fail(`找不到项目根目录。这个脚本必须放在仓库的 docs\\ 里。\n  推算出的根目录是：${root}`);
}

/**
 * Run a pnpm script.
 *
 * On Windows `pnpm` is a `.cmd`, which Node cannot execute directly, and the
 * obvious workaround — `spawn(..., { shell: true })` — makes Node concatenate
 * arguments without escaping (it warns about exactly that: DEP0190). Going
 * through `cmd.exe` explicitly keeps a real shell out of the argument path: the
 * exit code still arrives normally, and the note the user typed is never
 * re-parsed as shell syntax.
 */
function runPnpm(scriptArgs, options) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const command = [pnpm, ...scriptArgs];

  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", command.join(" ")], options);
  }
  return spawnSync(command[0], command.slice(1), options);
}

const forwarded = note === undefined ? [] : [note];
const result = runPnpm(["invite:create", ...forwarded], {
  cwd: root,
  stdio: quiet ? ["ignore", "pipe", "inherit"] : "inherit",
  encoding: "utf8",
});

if (result.error) {
  fail(
    `无法启动 pnpm：${result.error.message}\n` +
      "  请确认已安装 Node 与 pnpm，并且它们能在命令行里直接运行。",
  );
}

if (result.status !== 0) {
  fail(`生成邀请码失败（退出码 ${String(result.status)}）。上面的输出里有原因。`);
}

if (quiet) {
  // The underlying command prints a short block; the code is the only line that
  // matters, and it always follows the 邀请码： label.
  const output = result.stdout ?? "";
  const match = /邀请码：([A-Z0-9-]+)/.exec(output);
  if (!match) fail(`没能从输出里找到邀请码。原始输出：\n${output}`);
  process.stdout.write(`${match[1]}\n`);
}

if (!quiet) {
  process.stdout.write(
    [
      "",
      "  上面那串就是邀请码，只能用一次。",
      "  注册时把它填进「邀请码」一栏即可。",
      "",
    ].join("\n"),
  );
}
