// Full-app typography verification — the tool the S11 typography rollout was measured with.
//
// ⚠️ **Kept in `tools/` on purpose.** The typography system's whole claim is that changing one token
// changes the right text and nothing else; **that claim is only checkable by reading the real rendered
// values**, which is what this does. Run it after any change to `--text-*`:
//
//     node tools/verify-typography.mjs
//     node tools/verify-typography.mjs "/stats=stats,/ledger=ledger"
//
// ⚠️ It needs a session cookie in `%TEMP%\libellum-token.txt` (the repo's scripts create one the same
// way) and the dev server on https://localhost:5173. **It only reads** — it never writes to the app.
//
// Drives a separate headless Chrome over CDP at a phone viewport, walks the real DOM on every
// top-level and representative second-level screen, and reports for each page:
//   * every distinct computed text style (size / weight / line-height / colour),
//   * layout regressions: clipped headings, wrapping labels, overflowing buttons/cards,
//   * the bottom navigation's labels (must not wrap).
// Reads only; writes screenshots to .type-audit-3.
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE = "C:\\Users\\ZhuanZ（无密码）\\AppData\\Local\\Temp\\libellum-t3-profile";
const PORT = 9226;
const ORIGIN = "https://localhost:5173";
const OUT = "C:\\Users\\ZhuanZ（无密码）\\Desktop\\工作\\记账程序\\记账程序v1\\.type-audit-3";

const tokenPath = "C:\\Users\\ZhuanZ（无密码）\\AppData\\Local\\Temp\\libellum-token.txt";
const token = readFileSync(tokenPath, "utf8").trim();

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

/** Headings + layout regressions + the bottom navigation, in one pass. */
const REPORT = `(() => {
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;

  const styles = new Map();
  const headings = [];
  const clipped = [];
  const wrapped = [];

  for (const el of document.querySelectorAll('body *')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    if (!own) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);

    const key = s.fontSize + ' / ' + s.fontWeight + ' / lh ' + s.lineHeight;
    if (!styles.has(key)) styles.set(key, { n: 0, sample: (el.textContent || '').trim().slice(0, 16) });
    styles.get(key).n += 1;

    if (el.tagName === 'H1' || el.tagName === 'H2') {
      const lh = parseFloat(s.lineHeight);
      headings.push({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 22),
        size: px(s.fontSize), weight: s.fontWeight, lh: px(s.lineHeight),
        lines: lh > 0 ? Math.round(r.height / lh) : 1,
      });
    }

    // ⚠️ Clipping / overflow: text wider than its own box, or a box taller than its container allows.
    if (el.scrollWidth > el.clientWidth + 1 && s.overflow !== 'visible') {
      clipped.push({ tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 22), sw: el.scrollWidth, cw: el.clientWidth });
    }
    /**
      * ⚠️ **Real line count, from the text's own client rects.**
      * Dividing height by line-height counts an element's PADDING as extra lines — exactly how
      * the first version of this probe reported 31 "wrapped" elements on the analysis page that were
      * simply chart day-buttons with generous padding. **A detector that cries wolf is worse than no
      * detector**, because the next real finding gets ignored.
      */
    if (el.children.length === 0) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
      const t = (el.textContent || '').trim();
      /**
        * ⚠️ **Only things that are meant to be one line.** A paragraph wrapping is the layout working,
        * not a regression — the first version of this probe flagged 12 "problems" on the analysis page
        * that were all ordinary multi-line copy. **A probe that flags normal behaviour trains its
        * reader to ignore it.**
        */
      const inline = ['a', 'button', 'span', 'th', 'label'].includes(el.tagName.toLowerCase());
      const short = t.length <= 12;
      if (rects.length > 1 && t.length > 0 && inline && short && !String(el.className).includes('whitespace-nowrap')) {
        wrapped.push({ tag: el.tagName.toLowerCase(), text: t.slice(0, 22), lines: rects.length });
      }
      range.detach && range.detach();
    }
  }

  // The bottom navigation: its labels must stay on one line.
  const nav = document.querySelector('nav');
  const navLabels = [];
  if (nav) {
    for (const el of nav.querySelectorAll('span, button')) {
      const t = (el.textContent || '').trim();
      if (t === '' || t.length > 6) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      const s = getComputedStyle(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0).length || 1;
      navLabels.push({ text: t, size: px(s.fontSize), lines });
    }
  }

  const doc = document.documentElement;
  return {
    styles: [...styles.entries()].map(([k, v]) => ({ style: k, count: v.n, sample: v.sample })),
    headings,
    clipped,
    wrapped,
    navLabels,
    // ⚠️ Horizontal overflow of the whole page — a sign that something got wider than the viewport.
    pageOverflowX: doc.scrollWidth > doc.clientWidth + 1 ? doc.scrollWidth - doc.clientWidth : 0,
  };
})()`;

async function visit(cdp, path, shot) {
  await cdp.send("Page.navigate", { url: `${ORIGIN}${path}` });
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    const p = await cdp.send("Runtime.evaluate", { expression: "document.body && document.body.innerText.length > 30", returnByValue: true });
    if (p.result?.value === true) break;
  }
  await sleep(800);
  const res = await cdp.send("Runtime.evaluate", { expression: REPORT, returnByValue: true });
  if (shot) {
    const img = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}\\${shot}.png`, Buffer.from(img.data, "base64"));
  }
  return res.result?.value;
}


/** ⚠️ Read the colours the page actually paints, not the classes it asked for. */
const COLOURS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    if (s.boxShadow && s.boxShadow !== 'none') {
      out.push({ kind: 'shadow', tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), value: s.boxShadow.slice(0, 90) });
    }
    if (s.backgroundColor && s.backgroundColor.startsWith('rgba') && !s.backgroundColor.endsWith(', 0)')) {
      out.push({ kind: 'translucent-bg', tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), value: s.backgroundColor });
    }
  }
  return out;
})()`;


/** ⚠️ The colours the page actually paints — the only way to know a token change took effect. */
const TEXTCOLOURS = `(() => {
  const seen = new Map();
  for (const el of document.querySelectorAll('*')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    if (!own) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);
    if (el.tagName === 'svg' || el.closest('svg')) {
      const key = 'SVG ' + s.fill + ' / stroke ' + s.stroke;
      seen.set(key, (seen.get(key) || 0) + 1);
      continue;
    }
    const key = s.color + ' @ ' + s.fontSize;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return [...seen.entries()].map(([k, v]) => k + '  ×' + v);
})()`;

async function main() {
  const cdp = await connect(await targetUrl());
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Network.setBypassServiceWorker", { bypass: true });
  await cdp.send("Network.setCookie", { name: "libellum_session", value: token, domain: "localhost", path: "/", secure: true, httpOnly: true });

  const pages = process.argv[2]
    ? process.argv[2].split(",").map((s) => s.split("="))
    : [
        ["/ledger", "ledger"], ["/stats", "stats"], ["/me", "me"], ["/settings", "settings"],
        ["/about", "about"], ["/profile", "profile"], ["/categories", "categories"],
        ["/tags", "tags"], ["/payment-methods", "payment-methods"], ["/export", "export"],
        ["/downloads", "downloads"], ["/update", "update"], ["/legal/terms", "terms"],
      ];

  const problems = [];
  const allStyles = new Map();

  for (const [path, name] of pages) {
    const r = await visit(cdp, path, name);
    if (!r) { console.log(`\n${path}: 读取失败`); continue; }

    for (const s of r.styles) {
      if (!allStyles.has(s.style)) allStyles.set(s.style, []);
      allStyles.get(s.style).push(name);
    }

    if (r.clipped.length || r.wrapped.length || r.pageOverflowX > 0) {
      problems.push({ path, clipped: r.clipped, wrapped: r.wrapped, overflowX: r.pageOverflowX });
    }

    const navWrap = r.navLabels.filter((l) => l.lines > 1);
    if (navWrap.length) problems.push({ path, navWrap });

    console.log(`\n=== ${path} ===`);
    console.log(`  标题：${r.headings.map((h) => `${h.text} ${String(h.size)}/${h.weight}`).join(" · ") || "（无）"}`);
    console.log(`  不同样式 ${String(r.styles.length)} 种  ${r.pageOverflowX > 0 ? `⚠️ 横向溢出 ${String(r.pageOverflowX)}px` : "无横向溢出"}`);
    if (r.clipped.length) console.log(`  ⚠️ 裁切/溢出 ${String(r.clipped.length)} 处: ${JSON.stringify(r.clipped.slice(0, 4))}`);
    if (r.wrapped.length) console.log(`  ⚠️ 异常换行 ${String(r.wrapped.length)} 处: ${JSON.stringify(r.wrapped.slice(0, 4))}`);
  }

  console.log("\n\n================ 全站出现过的文字样式（合并） ================");
  const sorted = [...allStyles.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [style, pages] of sorted) {
    console.log(`  ${style.padEnd(44)} 出现在 ${String(pages.length).padStart(2)} 个页面: ${[...new Set(pages)].slice(0, 6).join(",")}`);
  }

  console.log("\n\n================ 问题汇总 ================");
  if (problems.length === 0) console.log("  ✅ 未发现裁切、异常换行、横向溢出或导航换行");
  else problems.forEach((p) => console.log(`  ⚠️ ${p.path}: ${JSON.stringify(p).slice(0, 300)}`));

  const colours = await cdp.send("Runtime.evaluate", { expression: COLOURS, returnByValue: true });
  console.log("\n================ 实际渲染的颜色 ================");
  for (const c of (colours.result?.value ?? []).slice(0, 30)) {
    console.log("  " + c.kind.padEnd(14) + " <" + c.tag + "> " + c.value);
  }

  const tc = await cdp.send("Runtime.evaluate", { expression: TEXTCOLOURS, returnByValue: true });
  console.log("\n================ 实际渲染的文字/图形颜色 ================");
  for (const x of (tc.result?.value ?? [])) console.log("  " + x);

  console.log(`\n截图: ${OUT}`);
  cdp.close();
  chrome.kill();
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true });
}

main().catch((e) => { console.error("失败:", e.message); chrome.kill(); process.exitCode = 1; });
