// One-off smoke test against the REAL dev database and a REAL server process.
//
// Verifies the things that unit tests cannot: that the owner's own account — which still holds two
// decided `collaborator_request` rows — gets a working inbox, and that the retired routes are gone.
// Creates one disposable session and deletes it afterwards. No business data is modified.
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
  const file = `${root}\\_probe5.sql`;
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
function check(label, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const URL_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** One column, one value — matched, not split, so a UUID's hyphens cannot be mistaken for a delimiter. */
function one(text) {
  const m = URL_UUID.exec(text.trim()) ?? /^\s*(\S+)/.exec(text.trim());
  return m === null ? "" : m[0];
}

async function main() {
  const naeorId = one(sql(`SELECT id FROM users WHERE username='naeor';`));
  const mamaId = one(sql(`SELECT id FROM users WHERE username='mama';`));
  const mamaNumber = one(sql(`SELECT account_number FROM users WHERE username='mama';`));
  const naeorNumber = one(sql(`SELECT account_number FROM users WHERE username='naeor';`));
  const sharedId = one(sql(`SELECT id FROM books WHERE book_number='40000003';`));

  console.log(`naeor=${naeorNumber}  mama=${mamaNumber}  共享账本=${sharedId.slice(0, 8)}`);

  const token = randomBytes(32).toString("base64url");
  sql(`INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at,last_seen_at)
       SELECT gen_random_uuid(), id, '${hash(token)}', now()+interval '5 minutes', now(), now()
       FROM users WHERE username='naeor';`);

  const historical = sql(
    `SELECT count(*) FROM notifications WHERE recipient_id='${naeorId}' AND kind='collaborator_request';`,
  ).trim();
  console.log(`naeor 名下历史 collaborator_request 通知: ${historical} 条（应仍留在库里）\n`);

  console.log("1) 通知中心（历史遗留类型不得打挂接口）");
  const inbox = await call(token, "/notifications");
  check("GET /notifications 返回 200", inbox.status === 200, `HTTP ${inbox.status}`);
  if (inbox.status === 200) {
    const kinds = [...new Set((inbox.body.notifications ?? []).map((n) => n.kind))];
    check(
      "只返回仍然有效的类型",
      kinds.every((k) => k === "book_invite" || k === "referral_reminder"),
      kinds.length === 0 ? "（当前无通知）" : kinds.join(", "),
    );
  }
  check(
    "历史通知仍在数据库里（没有被破坏性清理）",
    Number(sql(`SELECT count(*) FROM notifications WHERE kind='collaborator_request';`).trim()) > 0,
  );

  console.log("\n2) 已废弃的旧账号级协作者接口");
  const oldList = await call(token, "/collaborators");
  check("GET /collaborators 已不存在", oldList.status === 404, `HTTP ${oldList.status}`);
  const oldReq = await call(token, "/collaborators/requests", { method: "POST", body: "{}" });
  check("POST /collaborators/requests 已不存在", oldReq.status === 404, `HTTP ${oldReq.status}`);

  console.log("\n3) 新的查找接口");
  const byNumber = await call(token, `/directory/lookup?accountNumber=${mamaNumber}`);
  check("按账号编号查找", byNumber.status === 200 && byNumber.body.account?.username === "mama");
  const byName = await call(token, "/directory/lookup?username=mama");
  check("按用户名精确查找", byName.status === 200 && byName.body.account?.username === "mama");
  const partial = await call(token, "/directory/lookup?username=mam");
  check("按前缀查找被拒（防枚举）", partial.status === 404, `HTTP ${partial.status}`);
  const self = await call(token, `/directory/lookup?accountNumber=${naeorNumber}`);
  check("查自己被拒", self.status === 400 && self.body?.code === "account_is_self");

  console.log("\n4) 账本邀请（不经协作者）");
  const invite = await call(token, "/books/invite", {
    method: "POST",
    headers: { "x-libellum-book": sharedId },
    body: JSON.stringify({ username: "mama", role: "editor" }),
  });
  check(
    "邀请已在账本里的人 → 400 already_member（而不是发出邀请）",
    invite.status === 400 && invite.body?.code === "already_member",
    `HTTP ${invite.status} ${invite.body?.code ?? ""}`,
  );

  console.log("\n5) 分享链接接口仍然可用（第 7 节「分享链接」）");
  const links = await call(token, "/share/links", { headers: { "x-libellum-book": sharedId } });
  check("GET /share/links", links.status === 200, `HTTP ${links.status}`);

  console.log("\n6) 邀请码接口（已改名，且不再有协作者开关）");
  const quota = await call(token, "/referral-codes");
  check("GET /referral-codes 返回配额", quota.status === 200 && quota.body?.quota?.limit === 3);
  const flag = await call(token, "/referral-codes", {
    method: "POST",
    body: JSON.stringify({ allowsDirectCollaborator: true }),
  });
  check(
    "旧的 allowsDirectCollaborator 参数被明确拒绝",
    flag.status === 400 && flag.body?.code === "referral_flag_removed",
    `HTTP ${flag.status} ${flag.body?.code ?? ""}`,
  );

  sql(`DELETE FROM sessions WHERE token_hash='${hash(token)}';`);
  console.log(`\n临时会话已删除。通过 ${pass} 项，失败 ${fail} 项。`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("探针失败:", e.message);
  process.exitCode = 1;
});
