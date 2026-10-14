// Layout rollout verification (S11 phase 3, implementation).
//
// ⚠️ **Opens the two bottom sheets and measures them.** The radius fix cannot be verified from the
// closed state — a sheet's top corners only exist once it is mounted — so this drives the real UI:
// it presses the control that opens the book manager, and the one that opens the month picker, then
// reads `borderTopLeftRadius` and `borderBottomLeftRadius` off the panel itself.
//
// ⚠️ **`borderTopLeftRadius !== borderBottomLeftRadius` is the assertion that matters here.** The
// brief is explicit: *"只统一底部面板的顶部圆角，不要将其底部也变成圆角"* — so a probe that only
// checked "24px somewhere" would pass even if the bottom corners had been rounded too.
//
// Reads only.
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE = "C:\\Users\\ZhuanZ（无密码）\\AppData\\Local\\Temp\\libellum-rv-profile";
const PORT = 9233;
const ORIGIN = process.env["LIBELLUM_ORIGIN"] ?? "http://127.0.0.1:5173";
const OUT = "C:\\Users\\ZhuanZ（无密码）\\Desktop\\工作\\记账程序\\记账程序v1\\.layout-verify";
const token = readFileSync("C:\\Users\\ZhuanZ（无密码）\\AppData\\Local\\Temp\\libellum-token.txt", "utf8").trim();

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

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result?.value;
}

async function goto(cdp, path) {
  await cdp.send("Page.navigate", { url: `${ORIGIN}${path}` });
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    const ok = await evaluate(cdp, "document.body && document.body.innerText.length > 30");
    if (ok === true) break;
  }
  await sleep(700);
  const where = await evaluate(cdp, "location.pathname");
  if (where !== path) throw new Error(`导航到 ${path} 失败（停在 ${String(where)}）`);
}

/** Press the first element that matches a selector, and report what it was. */
async function pressSelector(cdp, selector) {
  const got = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    el.click();
    return (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30);
  })()`);
  await sleep(800);
  return got;
}

/** The panel: the biggest element with a top-only radius. */
const PANEL = `(() => {
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    const tl = s.borderTopLeftRadius, bl = s.borderBottomLeftRadius;
    if (!tl || tl === '0px') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 60) continue;
    if (parseFloat(tl) > 100000) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 60),
      top: px(tl), bottom: px(bl),
      w: px(r.width), h: px(r.height),
      text: (el.textContent || '').trim().slice(0, 24),
    });
  }
  return out;
})()`;

async function main() {
  const cdp = await connect(await targetUrl());
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setBypassServiceWorker", { bypass: true });

  const origin = new URL(ORIGIN);
  await cdp.send("Network.setCookie", {
    name: "libellum_session", value: token, domain: origin.hostname, path: "/",
    secure: origin.protocol === "https:", httpOnly: true,
  });

  const report = {};

  for (const vp of [
    { name: "390", width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    { name: "320", width: 320, height: 740, deviceScaleFactor: 2, mobile: true },
    { name: "768", width: 768, height: 1024, deviceScaleFactor: 1, mobile: false },
  ]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", vp);
    console.log(`\n\n################ 视口 ${vp.name} ################`);

    // ---- ① 账本管理面板（底部面板） ----
    // ⚠️ The gear on the start page: `aria-label` is `管理「<name>」`, so the selector is a prefix match.
    await goto(cdp, "/start");
    let clicked = await pressSelector(cdp, '[aria-label^="管理「"]');
    let panels = await evaluate(cdp, PANEL);
    console.log(`\n=== 账本管理面板（点了「${String(clicked)}」） ===`);
    if (!clicked) console.log("  ⚠️ 没找到触发控件");
    for (const p of panels.slice(0, 4)) {
      console.log(`  <${p.tag}> top=${p.top} bottom=${p.bottom} ${p.w}x${p.h} 「${p.text}」  ${p.top === p.bottom ? "" : "← 只有上圆角 ✅"}`);
    }
    report[`${vp.name}-sheet-bookmanage`] = panels.slice(0, 6);

    // ---- ② 月份选择面板（明细页，路由是 /） ----
    await goto(cdp, "/");
    clicked = await pressSelector(cdp, ".detail-month");
    panels = await evaluate(cdp, PANEL);
    console.log(`\n=== 月份选择面板（点了「${String(clicked)}」） ===`);
    if (!clicked) console.log("  ⚠️ 没找到触发控件");
    for (const p of panels.slice(0, 4)) {
      console.log(`  <${p.tag}> top=${p.top} bottom=${p.bottom} ${p.w}x${p.h} 「${p.text}」  ${p.top === p.bottom ? "" : "← 只有上圆角 ✅"}`);
    }
    report[`${vp.name}-sheet-monthpicker`] = panels.slice(0, 6);

    // ---- ③ 可点击列表行的水平内边距 ----
    /**
      * ⚠️ **Selects rows structurally, not by class.** A clickable list row here is
      * `<ul> → <li> → <button>` with a bottom border, and every one of them should now report
      * `paddingLeft: 20`. **Reading the rendered padding is the point**: the class could say `px-5`
      * while a parent contributes more, and only the computed value settles it.
      */
    console.log(`\n=== 可点击列表行的水平内边距 ===`);
    for (const path of ["/settings", "/me", "/categories"]) {
      await goto(cdp, path);
      const rows = await evaluate(cdp, `(() => {
        const px = (v) => Math.round(parseFloat(v) * 100) / 100;
        const out = [];
        for (const el of document.querySelectorAll('ul > li > button, ul > li > div')) {
          const r = el.getBoundingClientRect();
          if (r.width < 150) continue;
          const s = getComputedStyle(el);
          out.push({
            padL: px(s.paddingLeft), padR: px(s.paddingRight), padT: px(s.paddingTop),
            w: px(r.width), text: (el.textContent || '').trim().slice(0, 16),
          });
        }
        return out.slice(0, 6);
      })()`);
      const uniq = [...new Set(rows.map((x) => x.padL))];
      console.log(`  ${path.padEnd(12)} 行数=${String(rows.length)}  padL=${uniq.join("/") || "—"}  ` +
        (rows.length ? `例：${rows.map((x) => `${x.padL}px「${x.text}」`).slice(0, 2).join("  ")}` : "（未找到行）") +
        (uniq.length > 1 ? "  ⚠️ 不一致" : ""));
      report[`${vp.name}-rows${path}`] = rows;
    }
  }

  writeFileSync(`${OUT}\\verify.json`, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n\n原始数据: ${OUT}\\verify.json`);

  cdp.close();
  chrome.kill();
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true });
}

main().catch((e) => { console.error("失败:", e.message); chrome.kill(); process.exitCode = 1; });
