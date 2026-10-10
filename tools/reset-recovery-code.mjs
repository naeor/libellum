/**
 * Mint a fresh one-time recovery code for an existing account.
 *
 * A recovery code is shown exactly once, when it is created. If it was not
 * written down, the only way to get another one is to be signed in and ask for
 * one — or, on a development machine, to run this: it signs in with the
 * password, calls the same endpoint the settings screen calls, and prints the
 * new code. The old code stops working the moment the new one exists.
 *
 * The recovery code is a credential. This prints it; it does not store it.
 *
 *   node tools/reset-recovery-code.mjs --user naeor --password '…'
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const USERNAME = arg("user");
const PASSWORD = arg("password");

if (USERNAME === undefined || PASSWORD === undefined) {
  process.stderr.write(
    "\n  用法：node tools/reset-recovery-code.mjs --user <用户名> --password <密码>\n\n",
  );
  process.exit(1);
}

const env = {};
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
}

const API = `http://127.0.0.1:${env["API_PORT"] ?? "3000"}/api/v1`;

let cookie = "";

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === "" ? {} : { cookie }),
      origin: "http://localhost:5173",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0];
    if (pair?.startsWith("libellum_session=")) cookie = pair;
  }

  const text = await response.text();
  const payload = text === "" ? null : JSON.parse(text);
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${String(response.status)}\n${JSON.stringify(payload, null, 2)}`);
  }
  return payload;
}

try {
  await call("POST", "/auth/login", { username: USERNAME, password: PASSWORD });
  const result = await call("POST", "/auth/recovery-code", { password: PASSWORD });

  process.stdout.write(
    [
      "",
      "  新的恢复码（只显示这一次，请立刻保存）：",
      "",
      `      ${result.recoveryCode}`,
      "",
      "  ⚠️ 旧的恢复码已经失效。",
      "  ⚠️ 不要把它写进任何会被提交的文件里。",
      "",
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(`\n  失败：${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
}
