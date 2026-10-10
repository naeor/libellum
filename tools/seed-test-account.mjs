/**
 * Create a test account and fill it with plausible entries.
 *
 * This exists because the development database was wiped on 2026-10-10 (see
 * docs/DEVLOG.md), and because a realistic ledger is the only way to look at the
 * list, the statistics and the charts and see whether they behave.
 *
 * Two deliberate choices:
 *
 * **It goes through the HTTP API, not the database.** Writing rows directly
 * would be faster and would prove nothing: it would skip the validation, the
 * category rules and the idempotency path that the application actually uses.
 * Everything here is created exactly the way the browser creates it.
 *
 * **It will not duplicate itself.** If the account already has entries, the
 * script stops and says so instead of adding a second copy. Run it with
 * `--more` if you genuinely want another batch appended — the first version of
 * this script did not check, and running it twice quietly produced 236 entries
 * in a ledger that should have had 118.
 *
 * Usage (with the API running):
 *
 *   node tools/seed-test-account.mjs
 *   node tools/seed-test-account.mjs --user mama --password 'mama-password-2026' --note "给妈妈"
 *   node tools/seed-test-account.mjs --user mama --password '...' --more   # 再追加一批
 */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const USERNAME = arg("user", "mama");
const PASSWORD = arg("password", "mama-password-2026");
const DISPLAY_NAME = arg("display", USERNAME === "mama" ? "妈妈" : USERNAME);
const NOTE = arg("note", "测试账号");
/** Adding a second batch on purpose. Without it, an already-seeded account stops the run. */
const MORE = process.argv.includes("--more");

/** Set when the deliberately-deleted entry is created, and reported at the end. */
let deletedId = null;

function readEnvFile() {
  const path = join(root, ".env");
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return values;
}

const env = readEnvFile();
const API = `http://127.0.0.1:${env["API_PORT"] ?? "3000"}/api/v1`;

// ---------------------------------------------------------------------------
// A tiny HTTP client that keeps the session cookie
// ---------------------------------------------------------------------------

let cookie = "";

async function call(method, path, body, expect = [200, 201, 204]) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === "" ? {} : { cookie }),
      origin: "http://localhost:5173",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookie) {
    const pair = raw.split(";")[0];
    if (pair?.startsWith("libellum_session=")) cookie = pair;
  }

  const text = await response.text();
  const payload = text === "" ? null : JSON.parse(text);

  if (!expect.includes(response.status)) {
    throw new Error(
      `${method} ${path} → ${String(response.status)}\n${JSON.stringify(payload, null, 2)}`,
    );
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Values the API expects
// ---------------------------------------------------------------------------

const pad = (value) => String(value).padStart(2, "0");

/** `YYYY-MM-DD` on this machine's calendar, which is the user's calendar. */
function localDate(date) {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Full ISO 8601 with the local offset — what a browser sends. */
function localIso(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";

/** Deterministic randomness: the same run produces the same ledger. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const random = makeRandom(20261010);
const pick = (items) => items[Math.floor(random() * items.length)];
const between = (min, max) => Math.floor(random() * (max - min + 1)) + min;

// ---------------------------------------------------------------------------
// What a plausible couple of months looks like
// ---------------------------------------------------------------------------

/** Everyday spending: category → [min 元, max 元], how often per month. */
const EVERYDAY = [
  ["餐饮", 18, 88, 14],
  ["购物", 30, 320, 4],
  ["交通", 6, 60, 8],
  ["娱乐", 25, 180, 3],
  ["服务", 15, 120, 2],
  ["教育", 100, 600, 1],
];

const NOTES = {
  餐饮: ["午饭", "晚饭", "外卖", "和同事吃饭", "早饭", "奶茶"],
  购物: ["日用品", "超市", "纸巾和洗衣液", "网上买的收纳盒"],
  交通: ["地铁", "打车", "公交", "加油"],
  娱乐: ["电影票", "游戏", "周末出去玩"],
  服务: ["话费", "视频会员", "云盘会员"],
  教育: ["网课", "买书", "培训班"],
  生活缴费: ["电费", "水费", "燃气费"],
  转账: ["还朋友的钱", "给家里转的"],
};

/** One-off things that make a month look lived in rather than generated. */
const OCCASIONAL = [
  ["生活缴费", 18000, 32000, 1, "房租"],
  ["生活缴费", 6000, 15000, 1, "电费"],
  ["其他", 3000, 12000, 1, "给家里买的东西"],
];

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Run a pnpm script.
 *
 * On Windows `pnpm` is a `.cmd`, which Node cannot execute directly; the usual
 * workaround, `shell: true`, makes Node concatenate arguments without escaping
 * (DEP0190). Passing them to `cmd.exe` explicitly keeps the argument path out of
 * a shell's reach.
 */
function runPnpm(scriptArgs) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const command = [pnpm, ...scriptArgs];

  return process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", command.join(" ")], {
        cwd: root,
        encoding: "utf8",
      })
    : spawnSync(command[0], command.slice(1), { cwd: root, encoding: "utf8" });
}

async function main() {
  process.stdout.write(`\n  API：${API}\n`);

  let user;
  let created = false;

  try {
    const login = await call("POST", "/auth/login", { username: USERNAME, password: PASSWORD });
    user = login.user;
    process.stdout.write(`  账号 ${USERNAME} 已存在，直接使用。\n`);
  } catch {
    // The invite has to exist before registering, so it is created by the
    // project's own script rather than invented here.
    const invite = runPnpm(["invite:create", NOTE]);
    const code = /邀请码：([A-Z0-9-]+)/.exec(invite.stdout ?? "")?.[1];
    if (code === undefined) {
      throw new Error(`没能生成邀请码：\n${invite.stdout ?? ""}\n${invite.stderr ?? ""}`);
    }

    const registered = await call("POST", "/auth/register", {
      inviteCode: code,
      username: USERNAME,
      displayName: DISPLAY_NAME,
      password: PASSWORD,
    });
    user = registered.user;
    created = true;
    process.stdout.write(`  ✓ 已创建账号 ${USERNAME}（昵称：${DISPLAY_NAME}）\n`);
  }

  if (created) {
    process.stdout.write(
      [
        "",
        "  ┌─────────────────────────────────────────────────────────",
        `  │ 用户名：${USERNAME}`,
        `  │ 密码：  ${PASSWORD}`,
        `  │ 昵称：  ${DISPLAY_NAME}`,
        `  │ 账号编号：${user.accountNumber}`,
        "  └─────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
  }

  const ledger = await call("GET", "/ledger");
  const byName = (items, name) => items.find((item) => item.name === name);

  // Refuse to add a second copy. The account may legitimately exist (created
  // before, or by you), but if it already holds entries then this script has
  // almost certainly run before — and the honest answer is to stop and say so
  // rather than double the ledger. The first version did not check, and a second
  // run quietly turned 118 entries into 236.
  if (!MORE) {
    const probe = await call("GET", "/transactions?limit=1");
    if (probe.items.length > 0) {
      process.stdout.write(
        [
          "",
          `  账号 ${USERNAME} 里已经有账目了，这次没有写入任何数据。`,
          "",
          "  这是有意的：重复运行不会把测试数据翻倍。",
          "  确实想再追加一批，就加上 --more：",
          "",
          `      node tools/seed-test-account.mjs --user ${USERNAME} --password "…" --more`,
          "",
        ].join("\n"),
      );
      return;
    }
  }

  const expenseCategories = ledger.categories.filter(
    (category) => category.kind === "expense" && !category.isSystem,
  );
  const incomeCategories = ledger.categories.filter(
    (category) => category.kind === "income" && !category.isSystem,
  );
  const paymentMethods = ledger.paymentMethods.filter((method) => !method.isArchived);

  // Tags: created once, reused after that.
  const TAG_SEEDS = [
    ["可报销", "#55997a"],
    ["出差", "#4f7fb8"],
    ["大件", "#b8574f"],
    ["家庭", "#8a6fb8"],
  ];
  const tags = [...ledger.tags];
  for (const [name, color] of TAG_SEEDS) {
    if (byName(tags, name) !== undefined) continue;
    const tag = await call("POST", "/tags", { name, color });
    tags.push(tag);
    process.stdout.write(`  ✓ 新建标签：${name}\n`);
  }

  const usableTags = tags.map((tag) => tag.id);

  // Three months of history, ending yesterday so "today" stays empty for you to
  // fill in yourself.
  const now = new Date();
  const months = [2, 1, 0].map((back) => {
    const date = new Date(now.getFullYear(), now.getMonth() - back, 1);
    return { year: date.getFullYear(), month: date.getMonth() };
  });

  const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

  let entryCount = 0;
  const createdEntries = [];

  for (const { year, month } of months) {
    const lastDay = new Date(year, month, daysInMonth(year, month)).getTime() > now.getTime()
      ? now.getDate() - 1
      : daysInMonth(year, month);

    if (lastDay < 1) continue;

    const plan = [];

    for (const [categoryName, min, max, times] of EVERYDAY) {
      for (let index = 0; index < times; index += 1) {
        plan.push({
          kind: "expense",
          categoryName,
          amountCents: between(min, max) * 100,
          day: between(1, lastDay),
          note: pick(NOTES[categoryName] ?? [categoryName]),
        });
      }
    }

    for (const [categoryName, min, max, times, note] of OCCASIONAL) {
      for (let index = 0; index < times; index += 1) {
        plan.push({
          kind: "expense",
          categoryName,
          amountCents: between(min, max),
          day: index === 0 ? Math.min(5, lastDay) : between(1, lastDay),
          note,
        });
      }
    }

    // Income: a salary on the 10th, a refund, and something odd.
    plan.push({ kind: "income", categoryName: "工资", amountCents: between(1200000, 1600000), day: Math.min(10, lastDay), note: "工资" });
    plan.push({ kind: "income", categoryName: "退款", amountCents: between(3000, 20000), day: between(1, lastDay), note: "退货退款" });
    if (random() > 0.5) {
      plan.push({ kind: "income", categoryName: "理财", amountCents: between(2000, 30000), day: between(1, lastDay), note: "利息" });
    }

    for (const item of plan) {
      const hour = between(7, 22);
      const minute = between(0, 59);
      const when = new Date(year, month, item.day, hour, minute, between(0, 59));

      const category = byName(
        item.kind === "expense" ? expenseCategories : incomeCategories,
        item.categoryName,
      );
      if (category === undefined) continue;

      const body = {
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        kind: item.kind,
        amountCents: item.amountCents,
        currency: "CNY",
        categoryId: category.id,
        paymentMethodId: pick(paymentMethods).id,
        occurredAt: localIso(when),
        occurredLocalDate: localDate(when),
        occurredTz: TZ,
        note: item.note,
        tagIds: random() > 0.75 ? [pick(usableTags)] : [],
      };

      const saved = await call("POST", "/transactions", body, [201, 200]);
      createdEntries.push({ id: saved.id, note: body.note });
      entryCount += 1;
    }
  }

  // A couple of entries in other currencies, so the per-currency grouping has
  // something real to show, and one with several tags.
  const foreign = [
    { currency: "USD", categoryName: "餐饮", amountCents: 2380, note: "在那边吃的一顿饭" },
    { currency: "USD", categoryName: "购物", amountCents: 12650, note: "买了双鞋" },
    { currency: "HKD", categoryName: "交通", amountCents: 8600, note: "机场快线" },
  ];

  for (const item of foreign) {
    const when = new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - between(1, 12)), 19, 30, 0);
    const category = byName(expenseCategories, item.categoryName);
    if (category === undefined) continue;

    const saved = await call("POST", "/transactions", {
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: "expense",
      amountCents: item.amountCents,
      currency: item.currency,
      categoryId: category.id,
      paymentMethodId: pick(paymentMethods).id,
      occurredAt: localIso(when),
      occurredLocalDate: localDate(when),
      occurredTz: TZ,
      note: item.note,
      tagIds: [usableTags[0], usableTags[2]].filter((id) => id !== undefined),
    }, [201, 200]);
    createdEntries.push({ id: saved.id, note: item.note });
    entryCount += 1;
  }

  // One entry that carries the maximum tag count, and one deleted entry, so the
  // detail screen and the undo path both have something to show.
  const maxTagWhen = new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - 2), 12, 0, 0);
  const maxTagCategory = byName(expenseCategories, "其他");
  if (maxTagCategory !== undefined) {
    await call("POST", "/transactions", {
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: "expense",
      amountCents: 45600,
      currency: "CNY",
      categoryId: maxTagCategory.id,
      paymentMethodId: pick(paymentMethods).id,
      occurredAt: localIso(maxTagWhen),
      occurredLocalDate: localDate(maxTagWhen),
      occurredTz: TZ,
      note: "带满标签的一笔",
      tagIds: usableTags.slice(0, 5),
    }, [201, 200]);
    entryCount += 1;
  }

  const deletedWhen = new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - 3), 9, 15, 0);
  const deletedCategory = byName(expenseCategories, "餐饮");
  if (deletedCategory !== undefined) {
    const doomed = await call("POST", "/transactions", {
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: "expense",
      amountCents: 2200,
      currency: "CNY",
      categoryId: deletedCategory.id,
      paymentMethodId: pick(paymentMethods).id,
      occurredAt: localIso(deletedWhen),
      occurredLocalDate: localDate(deletedWhen),
      occurredTz: TZ,
      note: "这一笔是故意删掉的，用来试「恢复」",
      tagIds: [],
    }, [201, 200]);
    await call("DELETE", `/transactions/${doomed.id}`, undefined, [204]);
    entryCount += 1;
    deletedId = doomed.id;
  }

  const summary = await call("GET", `/summary?month=${String(now.getFullYear())}-${pad(now.getMonth() + 1)}`);

  process.stdout.write(
    [
      "",
      `  ✓ 已写入 ${String(entryCount)} 笔账（含 1 笔已删除的墓碑）`,
      `  ✓ 标签 ${String(tags.length)} 个，币种 CNY / USD / HKD`,
      "",
      `  本月（${String(now.getFullYear())} 年 ${String(now.getMonth() + 1)} 月）汇总：`,
      ...summary.currencies.map(
        (row) =>
          `    ${row.currency}  支出 ${(row.expenseCents / 100).toFixed(2)}  收入 ${(row.incomeCents / 100).toFixed(2)}`,
      ),
      "",
      "  打开 http://localhost:5173 ，用上面的用户名和密码登录即可。",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`\n  失败：${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});
