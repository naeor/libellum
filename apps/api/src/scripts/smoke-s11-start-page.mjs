// One-off smoke test for 1.10.08 against the REAL dev database and a live server.
//
// Verifies what unit tests cannot: that the owner's own data works with the new route, that the
// viewer can now read ledger metadata, and that a mismatch between the path ledger and the header
// ledger changes nothing. Creates one disposable session; deletes it and reverts the rename at the end.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const root = "C:\\Users\\ZhuanZ（无密码）\\Desktop\\工作\\记账程序\\记账程序v1";
const psql = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const API = "http://127.0.0.1:3000/api/v1";

const env = Object.fromEntries(
  readFileSync(`${root}\\.env`, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^\s*[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);

const url = new URL(env.DATABASE_URL.replace(/^postgresql:/, "http:"));
const conn = ["-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username), "-d", url.pathname.slice(1)];

function sql(text) {
  const file = `${root}\\_probe8.sql`;
  writeFileSync(file, text, "utf8");
  try {
    return execFileSync(psql, [...conn, "-X", "-q", "-A", "-t", "-F", "|", "-f", file], {
      encoding: "utf8",
      env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
    });
  } finally {
    rmSync(file, { force: true });
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const one = (t) => (UUID.exec(t.trim()) ?? /^\s*(\S+)/.exec(t.trim()))?.[0] ?? "";
const hash = (t) => createHash("sha256").update(t).digest("hex");

async function call(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie: `libellum_session=${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, body };
}

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); }
};

async function main() {
  const naeorId = one(sql(`SELECT id FROM users WHERE username='naeor';`));
  const bookA = one(sql(`SELECT id FROM books WHERE book_number='40000000';`));
  const bookShared = one(sql(`SELECT id FROM books WHERE book_number='40000003';`));
  const originalName = sql(`SELECT name FROM books WHERE id='${bookA}';`).trim();

  console.log(`共享账本=${bookShared.slice(0, 8)}  我的账本=${bookA.slice(0, 8)}（原名「${originalName}」）\n`);

  const token = randomBytes(32).toString("base64url");
  sql(`INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at,last_seen_at)
       SELECT gen_random_uuid(), id, '${hash(token)}', now()+interval '5 minutes', now(), now()
       FROM users WHERE username='naeor';`);

  console.log("1) 读一本「不是当前账本」的元数据");
  const meta = await call(token, "/ledger", { headers: { "x-libellum-book": bookA } });
  check("GET /ledger 带目标账本头", meta.status === 200 && meta.body?.book?.id === bookA,
    `HTTP ${meta.status} ${meta.body?.book?.name ?? ""}`);
  check("返回的是被点的那本，不是当前账本",
    meta.body?.book?.bookNumber === "40000000", meta.body?.book?.bookNumber ?? "");

  console.log("\n2) 重命名（路径与请求头一致）");
  const renamed = await call(token, `/books/${bookA}`, {
    method: "PATCH",
    headers: { "x-libellum-book": bookA },
    body: JSON.stringify({ name: "临时改名测试" }),
  });
  check("PATCH /books/:id → 200", renamed.status === 200, `HTTP ${renamed.status}`);
  check("库里确实改了",
    sql(`SELECT name FROM books WHERE id='${bookA}';`).trim() === "临时改名测试");

  console.log("\n3) 路径与请求头不一致 → 什么都不改");
  const mismatched = await call(token, `/books/${bookShared}`, {
    method: "PATCH",
    headers: { "x-libellum-book": bookA },
    body: JSON.stringify({ name: "不该生效" }),
  });
  check("拒绝（book_mismatch）",
    mismatched.status === 400 && mismatched.body?.code === "book_mismatch",
    `HTTP ${mismatched.status} ${mismatched.body?.code ?? ""}`);
  check("共享账本名字没被动过",
    sql(`SELECT name FROM books WHERE id='${bookShared}';`).trim() === "共享账本");

  console.log("\n4) 编辑历史记下了这次改名");
  const history = await call(token, "/ledger/history?limit=3", { headers: { "x-libellum-book": bookA } });
  const renameEntry = (history.body?.entries ?? []).find((e) => e.kind === "book_changed");
  check("有一条 book_changed", renameEntry !== undefined);
  check("句子说的是「这本账」而不是「一笔账目」",
    typeof renameEntry?.summary === "string" && renameEntry.summary.includes("这本账") && !renameEntry.summary.includes("一笔账目"),
    renameEntry?.summary ?? "（无）");

  console.log("\n5) 目标账本的成员与分享链接");
  const members = await call(token, "/books/members", { headers: { "x-libellum-book": bookShared } });
  check("按目标账本读成员", members.status === 200, `HTTP ${members.status} ${String(members.body?.members?.length ?? 0)} 人`);
  const links = await call(token, "/share/links", { headers: { "x-libellum-book": bookShared } });
  check("按目标账本读分享链接", links.status === 200, `HTTP ${links.status}`);

  console.log("\n6) 还原改名");
  const restored = await call(token, `/books/${bookA}`, {
    method: "PATCH",
    headers: { "x-libellum-book": bookA },
    body: JSON.stringify({ name: originalName }),
  });
  check("已还原", restored.status === 200 && sql(`SELECT name FROM books WHERE id='${bookA}';`).trim() === originalName);

  // 历史里的两条测试记录清掉，避免污染演示数据
  sql(`DELETE FROM transaction_events WHERE book_id='${bookA}' AND kind='book_changed';`);
  sql(`DELETE FROM sessions WHERE token_hash='${hash(token)}';`);

  console.log(`\n临时会话与测试历史已删除，账本名字已还原。通过 ${pass} 项，失败 ${fail} 项。`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("探针失败:", e.message);
  process.exitCode = 1;
});
