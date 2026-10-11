/**
 * The check that catches what typecheck and tests cannot.
 *
 * ⚠️ **Written after a CSS rule inside `@theme` broke the entire application while every test passed.**
 *
 * The evidence: `pnpm typecheck` was clean, `pnpm -r test` was 650 passing, and **the owner could not even reach
 * the login page** — because Vite replaces the whole app with an error overlay when Tailwind fails to compile.
 *
 * **Every check in this repository looked at TypeScript and at behaviour. None of them looked at whether the
 * application builds.**
 *
 * ⚠️ **So this runs the real build**, which is the only thing that compiles the CSS, resolves every import the
 * bundler has to resolve, and fails on a plugin error. **It takes a second and it would have caught this in one.**
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

console.log("check:build — 真实构建（CSS 与打包期错误只有它能拦住）");

const result = spawnSync("pnpm", ["--filter", "@libellum/web", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

if (result.status !== 0) {
  console.error("\n✗ 构建失败。上面的信息就是原因 —— **而这一类错误 typecheck 与 test 都看不到。**");
  process.exit(1);
}

console.log("✓ 构建通过");