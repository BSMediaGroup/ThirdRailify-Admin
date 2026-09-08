import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { applyMigration } from './auth-test-helpers.mjs';
import { createSession, resolveSession, sessionEnvelope } from '../functions/_shared/auth-core.js';
import { onRequest as admin } from '../functions/api/admin/brackets/[[path]].js';
import { onRequest as authority } from '../functions/api/brackets/[[path]].js';
import { onRequest as relay } from '../../ThirdRailify/functions/api/brackets/[[path]].js';
import { onRequest as polls } from '../functions/api/admin/polls/[[path]].js';

const ADMIN='http://127.0.0.1:44941', PUBLIC='http://127.0.0.1:44942', artifacts=`.artifacts/matchup-studio/browser-${Date.now()}`;
test('Studio canvas fullscreen, measured connectors, focus, modal editors, bench and card navigation', { timeout:180000 }, async t => {
  await mkdir(artifacts,{recursive:true});
  const h=await createCommerceDatabases({withMedia:true}); t.after(h.dispose);
  await applyMigration(h.commerceDb,await readFile(new URL('../commerce-migrations/0043_aboot_matchup_studio.sql',import.meta.url),'utf8'));
  const env=commerceEnvironment(h,{ THIRDRAILIFY_PUBLIC_ORIGIN:PUBLIC, THIRDRAILIFY_ADMIN_ORIGIN:ADMIN, THIRDRAILIFY_PROFILE_MEDIA:h.media });
  const at=new Date().toISOString();
  await h.authDb.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES ('browser-studio','studio@example.test','Studio Admin','admin','full','active',?,?,?,'test')").bind(at,at,at).run();
  const account=await h.authDb.prepare("SELECT * FROM accounts WHERE id='browser-studio'").first();
  const session=await createSession(env,new Request(ADMIN),account,ADMIN), cookie=session.cookie.split(';')[0];
  for (const [cwd,port] of [[process.cwd(),'44941'],[new URL('../../ThirdRailify/',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),'44942']]) { const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',port],{cwd,stdio:'ignore'});t.after(()=>server.kill()); }
  for(const origin of [ADMIN,PUBLIC]) { let ready=false;for(let i=0;i<60;i++){try{if((await fetch(origin)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));} assert.ok(ready); }
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const failures=[];context.on('page',p=>p.on('pageerror',e=>failures.push(e.message)));
  await context.route('**/*',async route=>{
    const r=route.request(),u=new URL(r.url());if(![ADMIN,PUBLIC].includes(u.origin))return route.abort();if(!u.pathname.startsWith('/api/'))return route.continue();
    const req=new Request(r.url(),{method:r.method(),headers:{...r.headers(),...(u.origin===ADMIN?{Cookie:cookie}:{})},...(r.postDataBuffer()?{body:r.postDataBuffer()}:{})});let response;
    if(u.pathname==='/api/auth/config')response=Response.json({configured:true,emailSignupConfigured:false,turnstileSiteKey:null,oauthProviders:[],oauthProviderStates:[],publicOrigin:PUBLIC,adminOrigin:ADMIN,environment:'test',cookieMode:'host-only'});
    else if(u.pathname==='/api/auth/session')response=Response.json(u.origin===ADMIN?await sessionEnvelope(env,await resolveSession(env,req),session.csrfToken):{ok:true,authenticated:false,account:null});
    else if(u.pathname.startsWith('/api/admin/brackets'))response=await admin({request:req,env});
    else if(u.pathname.startsWith('/api/admin/polls'))response=await polls({request:req,env});
    else if(u.pathname.startsWith('/api/brackets'))response=await relay({request:req,env,data:{bracketsFetch:(url,init)=>authority({request:new Request(url,init),env})}});
    else response=Response.json({ok:true,items:[],unread:0,count:0,actionable:{goats:{total:0,submissions:0,comments:0,emailFailures:0}}});
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  });
  const page=await context.newPage();await page.goto(ADMIN+'/polls/abootnothing/brackets');

  await page.getByRole('button',{name:'Review reference template',exact:true}).click();await page.getByRole('button',{name:'Import reviewed private sample'}).click();await page.getByRole('heading',{name:/Reference sample .* private historical draft/,exact:true}).waitFor();
  const draftUrl=page.url(), board=page.locator('.bracket-canvas-shell').first();
  assert.equal(await board.locator('.bracket-winner-feature').count(),7);
  await page.emulateMedia({reducedMotion:'no-preference'});await board.locator('.bracket-match').first().hover();await page.waitForTimeout(150);
  assert.equal(await board.locator('.bracket-winner-sparkles i').first().evaluate(e=>getComputedStyle(e).animationName),'bracket-winner-sparkle');
  await page.screenshot({path:artifacts+'/winner-hover.png'});
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await board.locator('.bracket-winner-sparkles i').first().evaluate(e=>getComputedStyle(e).animationName),'none');

  const widthBefore=await board.evaluate(e=>e.getBoundingClientRect().width);
  await page.getByRole('button',{name:'Hide Ideas bench',exact:true}).click();assert.equal(await page.locator('.bracket-bench').isVisible(),false);assert.ok(await board.evaluate(e=>e.getBoundingClientRect().width)>widthBefore+200);
  await page.getByRole('button',{name:'Show Ideas bench',exact:true}).click();assert.equal(await page.locator('.bracket-bench').evaluate(e=>getComputedStyle(e).scrollbarWidth),'none');
  const checkEdges=async()=>{
    await page.waitForFunction(()=>document.querySelectorAll('.bracket-connectors path').length===14);
    const errors=await board.evaluate(root=>{
      const tree=root.querySelector('.bracket-tree'),bounds=tree.getBoundingClientRect(),scale=bounds.width/tree.offsetWidth;
      return [...root.querySelectorAll('.bracket-connectors path')].flatMap(edge=>{
        const source=root.querySelector(`[data-match="${edge.dataset.from}"]`).getBoundingClientRect();
        const target=root.querySelector(`[data-match="${edge.dataset.to}"]`).querySelectorAll('.bracket-opponent')[Number(edge.dataset.slot)].getBoundingClientRect();
        const points=edge.getAttribute('d').match(/-?[0-9]+(?:\.[0-9]+)?/g).map(Number);
        const actual=[points[0],points[1],points[4],points[3]],expected=[(source.right-bounds.left)/scale,(source.top+source.height/2-bounds.top)/scale,(target.left-bounds.left)/scale,(target.top+target.height/2-bounds.top)/scale];
        return actual.some((n,i)=>Math.abs(n-expected[i])>1)?[{actual,expected}]:[];
      });
    });assert.deepEqual(errors,[]);
  };
  await checkEdges();await board.getByRole('button',{name:'Zoom in',exact:true}).click();await page.waitForTimeout(100);await checkEdges();
  await board.getByRole('button',{name:'Focus',exact:true}).click();await page.getByText('Enter a contender name to find their match.',{exact:true}).waitFor();
  await board.getByLabel('Find contender',{exact:true}).fill('NO SUCH CONTENDER');await board.getByRole('button',{name:'Focus',exact:true}).click();await page.getByText('No contender matches "NO SUCH CONTENDER".',{exact:true}).waitFor();
  await board.getByLabel('Find contender',{exact:true}).fill('Batman');await board.getByLabel('Find contender',{exact:true}).press('Enter');await page.waitForFunction(()=>document.activeElement?.matches('[data-match]'));assert.match(await page.locator(':focus').textContent(),/Batman/);
  await page.getByRole('button',{name:'Edit round 1 match 1',exact:true}).click();const editor=page.getByRole('dialog',{name:'Edit matchup',exact:true});await editor.waitFor();assert.equal(await page.locator('.bracket-workarea .bracket-inspector').count(),0);await page.bringToFront();await page.screenshot({path:artifacts+'/match-editor.png'});await editor.getByLabel('Public match details',{exact:true}).fill('Saved from the match lightbox');await editor.getByRole('button',{name:'Save draft and close',exact:true}).click();await editor.waitFor({state:'hidden'});await page.reload();await page.getByRole('button',{name:'Edit round 1 match 1',exact:true}).click();await editor.getByLabel('Public match details',{exact:true}).waitFor();assert.equal(await editor.getByLabel('Public match details',{exact:true}).inputValue(),'Saved from the match lightbox');await page.keyboard.press('Escape');
  await board.locator('.bracket-match').first().dblclick();await editor.waitFor();await editor.getByRole('button',{name:'Done',exact:true}).click();
  await board.getByRole('button',{name:'Fullscreen',exact:true}).click();await page.waitForFunction(()=>!!document.fullscreenElement);await checkEdges();
  const full=await board.locator('.bracket-viewport').evaluate(e=>({bottom:e.getBoundingClientRect().bottom,height:innerHeight}));assert.ok(full.height-full.bottom<=20&&full.bottom<=full.height,JSON.stringify(full));
  await board.locator('.bracket-viewport').evaluate(e=>e.scrollTop=e.scrollHeight);const last=await board.locator('.bracket-round').first().locator('.bracket-match').last().boundingBox();assert.ok(last.y+last.height<1000);
  await page.bringToFront();await page.screenshot({path:artifacts+'/fullscreen-bottom.png'});
  await board.getByRole('button',{name:'Fit view',exact:true}).click();await page.waitForTimeout(100);const fit=await board.evaluate(e=>{const a=e.querySelector('.bracket-tree').getBoundingClientRect(),b=e.querySelector('.bracket-viewport').getBoundingClientRect();return {width:a.width<=b.width,height:a.height<=b.height,tree:[a.width,a.height],viewport:[b.width,b.height],offset:[e.querySelector('.bracket-tree').offsetWidth,e.querySelector('.bracket-tree').offsetHeight],zoom:getComputedStyle(e.querySelector('.bracket-tree')).zoom}});assert.ok(fit.width&&fit.height,JSON.stringify(fit));await checkEdges();await page.screenshot({path:artifacts+'/fullscreen-fit.png'});await board.getByRole('button',{name:'Reset view',exact:true}).click();
  await page.getByRole('button',{name:'Edit round 1 match 8',exact:true}).click();await editor.waitFor();assert.equal(await editor.evaluate(e=>document.fullscreenElement.contains(e)),true);await page.screenshot({path:artifacts+'/fullscreen-editor.png'});await page.keyboard.press('Escape');await editor.waitFor({state:'hidden'});await board.getByRole('button',{name:'Exit fullscreen',exact:true}).click();await page.waitForFunction(()=>!document.fullscreenElement);
  await page.setViewportSize({width:390,height:844});await board.getByLabel('Find contender',{exact:true}).fill('Batman');await board.getByRole('button',{name:'Focus',exact:true}).click();await page.waitForFunction(()=>document.activeElement?.matches('[data-match]'));assert.match(await board.locator('.bracket-round.is-mobile-round').innerText(),/Batman/);assert.equal(await board.getByRole('tab',{name:'Round 2',exact:true}).getAttribute('aria-selected'),'true');
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('link',{name:'Library',exact:true}).click();await page.locator('.bracket-library-card').first().waitFor();await page.bringToFront();await page.screenshot({path:artifacts+'/season-library.png'});const cardBox=await page.locator('.bracket-library-card').first().boundingBox();await page.mouse.click(cardBox.x+30,cardBox.y+cardBox.height/2);await page.waitForURL(draftUrl);
  assert.deepEqual(failures,[]);
});
