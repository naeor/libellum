import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
// Optional local E2E harness. Requires a dedicated loopback test database, running local
// API/frontend and Playwright. Never accepts a production host or database.
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const work=path.join(os.tmpdir(),'libevra-entry-e2e-'+Date.now());
const {chromium}=createRequire(process.env.LIBEVRA_PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');
const require=createRequire(path.join(repo,'apps/api/package.json'));
const {Client}=require('pg');
const {parse}=createRequire(path.join(repo,'package.json'))('dotenv');
const env=parse(fs.readFileSync(path.join(repo,'.env')));
const url=new URL(env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.ok(url.pathname.startsWith('/libevra_entry_test_'),'Requires a dedicated libevra_entry_test_* database');
const db=new Client({connectionString:url.href});await db.connect();
const stamp=Date.now(),username='entry_'+stamp,password='Local-Entry-Test-Only-2026',invite='ENTRY-'+stamp;
await db.query('INSERT INTO registration_invites (id,code) VALUES (gen_random_uuid(),$1)',[invite]);
const origin=process.env.LIBEVRA_E2E_ORIGIN || 'http://localhost:5186';
assert.ok(['localhost','127.0.0.1'].includes(new URL(origin).hostname),'Loopback frontend only');
const out=path.join(work,'entry-browser-evidence');fs.mkdirSync(out,{recursive:true});
const profile=path.join(out,'profile-'+stamp);
const opts={...(process.env.LIBEVRA_CHROME ? {executablePath:process.env.LIBEVRA_CHROME} : {}),headless:true,viewport:{width:390,height:844},hasTouch:true,serviceWorkers:'allow'};
let ctx=await chromium.launchPersistentContext(profile,opts),page=await ctx.newPage();
page.setDefaultTimeout(12000);
const results=[],errors=[];let browser;
function record(name){results.push({name,status:'passed'});console.log('通过：'+name);}
page.on('pageerror',e=>errors.push(e.message));
async function at(p,path){await p.waitForURL(u=>u.pathname===path);}
async function pvalue(p){return p.locator('.ledger-space').evaluate(el=>Number(el.style.getPropertyValue('--p')));}
async function me(p){const r=await p.request.get(origin+'/api/v1/auth/me');assert.equal(r.status(),200);return (await r.json()).user;}
async function internal(p,to){await p.evaluate(to=>{history.pushState({},'',to);dispatchEvent(new PopStateEvent('popstate'));},to);await p.waitForTimeout(200);}
async function login(p){await p.goto(origin+'/login');await p.getByLabel('用户名',{exact:true}).fill(username);await p.getByLabel('密码',{exact:true}).fill(password);await p.getByRole('button',{name:'登录',exact:true}).click();await at(p,'/');await p.locator('.current-book-caption').waitFor();}
async function caption(p,name){await p.waitForFunction(name=>document.querySelector('.current-book-caption')?.textContent===`当前账本：${name}`,name);}
async function screenshot(p,name){await p.screenshot({path:path.join(out,name+'.png')});}
async function checkLayout(p,name){
 const metrics=await p.evaluate(()=>{
  const overflow=[];
  for(const el of document.querySelectorAll('button,h1,h2,[role="alertdialog"]')){
   const r=el.getBoundingClientRect(),s=getComputedStyle(el);
   if(!r.width||!r.height||s.visibility==='hidden'||s.display==='none')continue;
   let rail=false;
   for(let parent=el.parentElement;parent;parent=parent.parentElement){
    if(['auto','scroll'].includes(getComputedStyle(parent).overflowX)&&parent.scrollWidth>parent.clientWidth+1){rail=true;break;}
   }
   if(rail)continue; // Existing horizontal filter/carousel rails intentionally extend past their viewport.
   if(r.left<-.5||r.right>innerWidth+.5)overflow.push(el.textContent.trim().slice(0,55));
   if(el.tagName==='BUTTON'&&el.scrollWidth>el.clientWidth+2&&s.overflowX==='hidden')overflow.push('clipped:'+el.textContent.trim().slice(0,55));
  }
  return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,overflow};
 });
 assert.ok(metrics.documentWidth<=metrics.width+1,name+' page overflow');assert.deepEqual(metrics.overflow,[],name+' control overflow');
 results.push({name:'排版 '+name,status:'passed',metrics});
}
try {
 await page.goto(origin+'/register');
 await page.getByLabel('邀请码',{exact:true}).fill(invite);
 await page.getByLabel('用户名',{exact:true}).fill(username);
 await page.getByLabel('昵称',{exact:true}).fill('浏览器测试');
 await page.getByLabel('密码',{exact:true}).fill(password);
 await page.getByRole('button',{name:'创建账号',exact:true}).click();
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'完成',exact:true}).click();
 await at(page,'/start');await page.locator('.ledger-space').waitFor();
 assert.equal(await pvalue(page),0);assert.equal((await me(page)).hasCompletedIntro,false);
 assert.equal(await page.locator('.space-cue').count(),0);
 await screenshot(page,'01-new-presentation');record('新注册 → 保存恢复码 → 完整展开的账本空间；未提前完成');
 const cdp=await ctx.newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:660}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:195,y:480}]});
 await page.waitForTimeout(120);assert.ok(await pvalue(page)>0&&await pvalue(page)<1);assert.equal((await me(page)).hasCompletedIntro,false);
 await screenshot(page,'02-mid-drag');
 await page.reload();await page.locator('.ledger-space').waitFor();await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 assert.equal(await pvalue(page),0);record('中途拖动未标记完成；刷新仍为初次展示');
 await ctx.setOffline(true);
 await page.mouse.move(195,450);await page.mouse.wheel(0,900);
 await page.waitForFunction(()=>Number(document.querySelector('.ledger-space')?.style.getPropertyValue('--p'))===1);
 assert.equal((await db.query('SELECT has_completed_intro FROM users WHERE username=$1',[username])).rows[0].has_completed_intro,false);
 record('离线完成首次展示时只记本机确认，不伪造服务端成功');
 await ctx.setOffline(false);
 await page.waitForFunction(async()=>{const r=await fetch('/api/v1/auth/me');return (await r.json()).user.hasCompletedIntro===true;});
 await screenshot(page,'03-completed-list');record('上滑收束完成后才将完成状态写入账号');
 const a=(await (await page.request.post(origin+'/api/v1/books',{data:{name:'家庭账本 A'}})).json()).id;
 const b=(await (await page.request.post(origin+'/api/v1/books',{data:{name:'旅行账本 B'}})).json()).id;
 await page.goto(origin+'/start');await page.getByRole('button').filter({hasText:'家庭账本 A'}).click();
 await at(page,'/');await caption(page,'家庭账本 A');assert.equal((await me(page)).lastBookId,a);record('账本列表切换后，服务器记住家庭账本 A');
 await page.getByRole('button',{name:'分析',exact:true}).click();await at(page,'/stats');await caption(page,'家庭账本 A');
 await page.reload();await at(page,'/');await caption(page,'家庭账本 A');record('离开前在分析页，刷新直接恢复 A 的明细');
 await page.waitForTimeout(1600);
 await ctx.close();ctx=await chromium.launchPersistentContext(profile,opts);page=await ctx.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/stats');await at(page,'/');await caption(page,'家庭账本 A');record('关闭浏览器后复用原用户目录，直接恢复 A 的明细');
 browser=await chromium.launch({executablePath:opts.executablePath,headless:true});
 const other=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),second=await other.newPage();
 second.on('pageerror',e=>errors.push(e.message));
 await login(second);await caption(second,'家庭账本 A');record('全新隔离浏览器会话登录：账号级完成标记和账本 A 一致');
 await second.request.post(origin+`/api/v1/books/${b}/activate`);
 await page.goto(origin+'/');await caption(page,'旅行账本 B');record('另一会话切换 B 后，旧设备重新进入采用服务器偏好 B');
 await page.goto(origin+'/start');assert.equal(await pvalue(page),1);record('主动打开账本空间为收缩态，不重新判断为首次');
 await page.getByRole('link',{name:'账户',exact:true}).click();await at(page,'/me');record('账本空间头像仍可进入账户，不被启动规则拦回明细');
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'退出登录',exact:true}).click();await at(page,'/login');
 await login(page);await caption(page,'旅行账本 B');record('退出登录后重新登录，直接进入 B 的明细');
 let release;const held=new Promise(r=>release=r);
 await page.route('**/api/v1/books',async route=>{await held;await route.continue();});
 await page.goto(origin+'/stats');await page.getByRole('status').filter({hasText:'正在载入账本'}).waitFor();
 assert.equal(await page.locator('.current-book-caption').count(),0);await screenshot(page,'04-slow-preference');release();await at(page,'/');await caption(page,'旅行账本 B');await page.unroute('**/api/v1/books');record('慢速账本偏好加载期间无旧账本闪现或提前路由');
 await page.waitForTimeout(1700);await ctx.setOffline(true);await page.reload();await at(page,'/');await caption(page,'旅行账本 B');await ctx.setOffline(false);await page.waitForTimeout(700);record('断网刷新使用本机 B，恢复联网仍可使用');
 const user=await me(page);
 await db.query('UPDATE books SET disposed_at=now() WHERE id=$1',[b]);await page.goto(origin+'/');await caption(page,'我的账本');record('上次账本弃置后回退最早有效成员账本');
 await db.query('UPDATE books SET disposed_at=null WHERE id=$1',[b]);await db.query('UPDATE book_members SET left_at=now() WHERE book_id=$1 AND user_id=$2',[b,user.id]);await page.goto(origin+'/');await caption(page,'我的账本');record('上次账本失去访问权时安全回退');
 await db.query('DELETE FROM books WHERE id=$1',[b]);await page.goto(origin+'/');await caption(page,'我的账本');record('上次账本不存在、外键置空后安全回退');
 // Simulate an upgraded legacy session with no device intro marker; real migration tested separately.
 await page.evaluate(id=>localStorage.removeItem('libellum-presentation-seen:'+id),user.id);await page.goto(origin+'/');await caption(page,'我的账本');record('无本地展示标记的已有账号不会重新看首次展示');
 for(const width of [320,390,820]){
  await page.setViewportSize({width,height:width===820?1180:844});
  for(const route of ['/','/stats','/ledger','/me','/settings','/export','/import','/start']){
   await internal(page,route);await page.waitForTimeout(180);await checkLayout(page,`${width} ${route}`);
   if(width===320&&['/stats','/settings','/import','/start'].includes(route))await screenshot(page,`layout-${width}-${route.replaceAll('/','_')||'detail'}`);
  }
  await page.getByRole('button',{name:'管理「家庭账本 A」'}).click();await page.getByRole('dialog').waitFor();
  await checkLayout(page,`${width} book-sheet`);
  await page.getByRole('button',{name:'弃置这本账',exact:true}).click();await page.getByRole('alertdialog').waitFor();await checkLayout(page,`${width} dispose-confirmation`);
  if(width===320)await screenshot(page,'layout-320-confirmation');
  await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'关闭管理面板'}).click();
 }
 const publicCtx=await browser.newContext({viewport:{width:320,height:740},serviceWorkers:'block'}),publicPage=await publicCtx.newPage();
 publicPage.on('pageerror',e=>errors.push(e.message));
 for(const route of ['/login','/register','/recover']){await publicPage.goto(origin+route);await checkLayout(publicPage,'320 '+route);await screenshot(publicPage,'layout-320-'+route.slice(1));}
 await publicCtx.close();
 await db.query('UPDATE book_members SET left_at=now() WHERE user_id=$1',[user.id]);await page.goto(origin+'/');await at(page,'/start');assert.equal(await pvalue(page),1);await page.getByRole('button',{name:'新建第一本账',exact:true}).waitFor();record('没有可访问账本时进入收缩的创建/选择状态');
 assert.deepEqual(errors,[]);record('无浏览器页面异常');
 await other.close();await browser.close();
} catch(error) {
 console.log('失败时路径：'+new URL(page.url()).pathname);
 console.log('可见错误提示：'+JSON.stringify(await page.locator('[role="alert"]').allTextContents()));
 await screenshot(page,'failure-current-page');
 throw error;
} finally {
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({results,errors},null,2));
 console.log('本地浏览器报告：'+path.join(out,'report.json'));
 await ctx.close();if(browser)await browser.close();await db.end();
}
