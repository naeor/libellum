// Layout / spacing / radius / alignment audit — the measurement half of
// docs/布局间距与圆角规范.md (S11 phase 3).
//
// ⚠️ **Measures the rendered box, not the class names.** The brief is explicit that alignment has to
// come from the browser: `getBoundingClientRect()` on real elements, at three viewports, because
// "which element lines up with which" is not answerable from Tailwind strings — a nested padded
// container produces a 16px offset that no class-name scan can see.
//
// Reads only. Writes a JSON snapshot so the numbers in the document can be re-derived.
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE = "C:\\Users\\ZhuanZ（无密码）\\AppData\\Local\\Temp\\libellum-layout-profile";
const PORT = 9227;
/**
 * ⚠️ **HTTP, not HTTPS — and that is worth knowing before trusting a measurement.**
 *
 * `vite.config.ts` serves HTTPS **only when `LAN=1`**, because the certificate exists for reaching the
 * app from a phone on the LAN. Started plainly, it binds `127.0.0.1:5173` over plain HTTP.
 *
 * ⚠️ **The first run of this probe pointed at HTTPS anyway and produced 27 identical rows** —
 * Chrome's error page measured over and over, which read exactly like "every page is consistent".
 * **A measurement that cannot fail is not a measurement.** Hence the path check below.
 */
const ORIGIN = process.env["LIBELLUM_ORIGIN"] ?? "http://127.0.0.1:5173";
const OUT = "C:\\Users\\ZhuanZ（无密码）\\Desktop\\工作\\记账程序\\记账程序v1\\.layout-audit";

const token = readFileSync("C:\\Users\\ZhuanZ（无密码）\\AppData\\Local\\Temp\\libellum-token.txt", "utf8").trim();

/** ⚠️ Three viewports: the phone reference, the narrow screen, and the wide one. */
const VIEWPORTS = [
  { name: "390", width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  { name: "320", width: 320, height: 740, deviceScaleFactor: 2, mobile: true },
  { name: "768", width: 768, height: 1024, deviceScaleFactor: 1, mobile: false },
];

const PAGES = [
  ["/ledger", "ledger"],
  ["/stats", "stats"],
  ["/me", "me"],
  ["/settings", "settings"],
  ["/about", "about"],
  ["/profile", "profile"],
  ["/start", "start"],
  ["/export", "export"],
  ["/categories", "categories"],
];

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${String(PORT)}`,
  `--user-data-dir=${PROFILE}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--ignore-certificate-errors", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)).json();
      const p = list.find((t) => t.type === "page");
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error("no target");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => resolve({
      send(method, params = {}) {
        id += 1;
        const mine = id;
        return new Promise((res, rej) => { pending.set(mine, { res, rej }); ws.send(JSON.stringify({ id: mine, method, params })); });
      },
      close: () => ws.close(),
    }));
    ws.addEventListener("error", reject);
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id === undefined) return;
      const s = pending.get(m.id);
      if (!s) return;
      pending.delete(m.id);
      if (m.error) s.rej(new Error(JSON.stringify(m.error))); else s.res(m.result);
    });
  });
}

/**
 * ⚠️ **`getBoundingClientRect()` on everything, plus the resolved box metrics.**
 *
 * `paddingLeft/Top` and `borderRadius` are read from computed style rather than inferred from classes,
 * because that is what the browser actually laid out — and because a value can arrive through a shared
 * component, a CSS rule, or a `calc()`, none of which a class scan can resolve.
 */
const MEASURE = `(() => {
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;
  const txt = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30);

  const containers = [];
  const radii = new Map();
  const paddings = new Map();
  const gaps = new Map();

  const all = [...document.querySelectorAll('body *')];

  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);

    /**
      * ---- radius: every element that actually has one ----
      *
      * ⚠️ **Chrome reports a percentage radius as a 33-million-pixel sentinel**, not a length. Left
      * alone it lands in the histogram as the most common "radius" on the page and looks like the app
      * uses a 33-million-pixel corner. **The real value has to be computed from the box**: for a
      * circle it is half the shorter side, whatever the percentage resolves to.
      */
    {
      const raw = s.borderTopLeftRadius;
      const asPx = parseFloat(raw);
      let radius = raw;
      if (!Number.isFinite(asPx) || asPx > 100000) {
        radius = px(Math.min(r.width, r.height) / 2) + 'px（50%）';
      }
      if (radius !== '0px') radii.set(radius, (radii.get(radius) || 0) + 1);
    }

    // ---- padding: only for elements that look like containers ----
    const pl = px(s.paddingLeft), pr = px(s.paddingRight), pt = px(s.paddingTop), pb = px(s.paddingBottom);
    const isContainer = (pl > 0 || pt > 0) && r.width > 60;
    if (isContainer) {
      const key = pt + '/' + pr + '/' + pb + '/' + pl;
      paddings.set(key, (paddings.get(key) || 0) + 1);
    }

    // ---- gap: flex/grid containers ----
    if ((s.display.includes('flex') || s.display.includes('grid'))) {
      const row = px(s.rowGap), col = px(s.columnGap);
      // ⚠️ A gap of "normal" parses to NaN, which would otherwise travel into the histogram as "NaN".
      if ((Number.isFinite(row) && row > 0) || (Number.isFinite(col) && col > 0)) {
        const key = (Number.isFinite(row) ? row : 0) + '/' + (Number.isFinite(col) ? col : 0);
        gaps.set(key, (gaps.get(key) || 0) + 1);
      }
    }

    // ---- the elements worth aligning: content blocks with their own box ----
    const hasSurface = s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.borderTopWidth !== '0px' || s.boxShadow !== 'none';
    if (hasSurface && r.width > 40 && r.height > 20) {
      containers.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 70),
        text: txt(el),
        left: px(r.left), right: px(r.right), top: px(r.top), width: px(r.width), height: px(r.height),
        radius: s.borderTopLeftRadius,
        padTop: pt, padRight: pr, padBottom: pb, padLeft: pl,
        bg: s.backgroundColor,
        border: s.borderTopWidth + ' ' + s.borderTopColor,
        depth: (() => { let d = 0, n = el; while (n.parentElement) { d++; n = n.parentElement; } return d; })(),
      });
    }
  }

  // ---- text left edges: the alignment question ----
  const textEdges = [];
  for (const el of all) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    if (!own) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const t = txt(el);
    if (t === '' || t.length < 2) continue;
    const s = getComputedStyle(el);
    textEdges.push({ tag: el.tagName.toLowerCase(), text: t, left: px(r.left), top: px(r.top), size: s.fontSize, weight: s.fontWeight });
  }

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    docScrollWidth: document.documentElement.scrollWidth,
    radii: [...radii.entries()],
    paddings: [...paddings.entries()],
    gaps: [...gaps.entries()],
    containers,
    textEdges,
  };
})()`;

async function visit(cdp, path) {
  await cdp.send("Page.navigate", { url: `${ORIGIN}${path}` });
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    const p = await cdp.send("Runtime.evaluate", { expression: "document.body && document.body.innerText.length > 30", returnByValue: true });
    if (p.result?.value === true) break;
  }
  await sleep(800);
  /**
    * ⚠️ **Refuse to measure an error page.** If the app did not render, `location.pathname` is `/` and
    * the body is Chrome's own text — numbers taken from there would be nonsense that looks like data.
    * **Better to fail loudly than to publish a table of nothing.**
    */
  const where = await cdp.send("Runtime.evaluate", { expression: "location.pathname", returnByValue: true });
  if (where.result?.value !== path) {
    throw new Error(`导航到 ${path} 失败（停在 ${String(where.result?.value)}）—— 拒绝测量错误页`);
  }
  const res = await cdp.send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
  return res.result?.value;
}

async function main() {
  const cdp = await connect(await targetUrl());
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setBypassServiceWorker", { bypass: true });
  /**
    * ⚠️ **`secure` has to follow the scheme, and `domain` has to follow the host** — and getting
    * either wrong does not error, it silently produces a logged-out browser.
    *
    * Over plain HTTP a `secure: true` cookie is **dropped**; and a cookie scoped to `localhost` is
    * **not sent to `127.0.0.1`**, which is what Vite binds. Either mistake means every route redirects
    * to `/login` and the probe would happily measure the login screen nine times.
    * **The guard in `visit()` is what turned that into a failure instead of a table.**
    */
  const origin = new URL(ORIGIN);
  await cdp.send("Network.setCookie", {
    name: "libellum_session",
    value: token,
    domain: origin.hostname,
    path: "/",
    secure: origin.protocol === "https:",
    httpOnly: true,
  });

  const report = {};

  for (const vp of VIEWPORTS) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor, mobile: vp.mobile,
    });
    console.log(`\n\n################ 视口 ${vp.name}×${String(vp.height)} ################`);

    for (const [path, name] of PAGES) {
      const r = await visit(cdp, path);
      if (!r) { console.log(`\n=== ${path}: 读取失败 ===`); continue; }
      report[`${vp.name}${path}`] = r;

      console.log(`\n=== ${path} ===  文档宽 ${String(r.docScrollWidth)} / 视口 ${String(r.viewport.w)}${r.docScrollWidth > r.viewport.w + 1 ? "  ⚠️ 横向溢出" : ""}`);

      // 内容容器的左右边距：取"有底/有框"的最外层元素
      const outer = r.containers.filter((c) => c.depth <= 14).sort((a, b) => a.left - b.left || a.top - b.top);
      const lefts = {};
      for (const c of outer) lefts[c.left] = (lefts[c.left] || 0) + 1;
      const top = Object.entries(lefts).sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`  典型左边缘：${top.map(([l, n]) => l + "px×" + n).join("  ")}`);

      // 圆角分布（本页）
      const rl = r.radii.sort((a, b) => b[1] - a[1]).slice(0, 6);
      console.log(`  圆角：${rl.map(([v, n]) => v + "×" + n).join("  ")}`);

      // 内边距分布（本页）
      const pt = r.paddings.sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`  内边距：${pt.map(([v, n]) => "[" + v + "]×" + n).join("  ")}`);

      // 间距分布（本页）
      const gp = r.gaps.sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`  间距：${gp.map(([v, n]) => v + "×" + n).join("  ")}`);

      // 文字左边缘：对齐的关键
      const edges = {};
      for (const t of r.textEdges) if (t.size === "14px" || t.size === "20px" || t.size === "16px") edges[t.left] = (edges[t.left] || 0) + 1;
      const te = Object.entries(edges).sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`  文字左边缘：${te.map(([l, n]) => l + "px×" + n).join("  ")}`);
    }
  }

  writeFileSync(`${OUT}\\layout.json`, JSON.stringify(report, null, 2), "utf8");

  // -------------------------------------------------------------------------
  // Aggregates, which is where the audit's actual answers live
  // -------------------------------------------------------------------------

  /** ⚠️ Only the 390 viewport: mixing 320/768 would compare a phone against a tablet. */
  const at390 = Object.entries(report).filter(([k]) => k.startsWith("390"));

  console.log("\n\n================ 圆角：全站分布（390 视口） ================");
  const allRadii = new Map();
  for (const [, r] of at390) for (const [v, n] of r.radii) allRadii.set(v, (allRadii.get(v) || 0) + n);
  for (const [v, n] of [...allRadii].sort((a, b) => b[1] - a[1])) console.log("  " + String(n).padStart(4) + "  " + v);

  console.log("\n================ 内边距：全站分布（390 视口，上/右/下/左） ================");
  const allPads = new Map();
  for (const [, r] of at390) for (const [v, n] of r.paddings) allPads.set(v, (allPads.get(v) || 0) + n);
  for (const [v, n] of [...allPads].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log("  " + String(n).padStart(4) + "  [" + v + "]");

  console.log("\n================ 间距 gap（390 视口，行/列） ================");
  const allGaps = new Map();
  for (const [, r] of at390) for (const [v, n] of r.gaps) allGaps.set(v, (allGaps.get(v) || 0) + n);
  for (const [v, n] of [...allGaps].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log("  " + String(n).padStart(4) + "  " + v);

  /**
    * ⚠️ **Left edges of text, per page: the alignment question.**
    * The value to look for is the *content* column — and the tell-tale of a problem is a text edge
    * that sits off the column by a few px while every sibling sits on it.
    */
  console.log("\n================ 文字左边缘：每页分布（390 视口） ================");
  for (const [key, r] of at390) {
    const edges = new Map();
    for (const t of r.textEdges) edges.set(t.left, (edges.get(t.left) || 0) + 1);
    const sorted = [...edges].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const page = key.replace("390", "");
    console.log("  " + page.padEnd(12) + sorted.map(([l, n]) => l + "×" + n).join("  "));
  }

  /** ⚠️ Card edges: which lefts are "the card column"? */
  console.log("\n================ 有底/有框容器的左边缘（390 视口） ================");
  for (const [key, r] of at390) {
    const edges = new Map();
    for (const c of r.containers) if (c.width > 80) edges.set(c.left, (edges.get(c.left) || 0) + 1);
    const sorted = [...edges].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log("  " + key.replace("390", "").padEnd(12) + sorted.map(([l, n]) => l + "×" + n).join("  "));
  }

  console.log(`\n\n原始测量: ${OUT}\\layout.json`);
  console.log(`合成层数最深的前 12 个容器见 JSON（containers[].depth）`);

  cdp.close();
  chrome.kill();
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true });
}

main().catch((e) => { console.error("失败:", e.message); chrome.kill(); process.exitCode = 1; });
