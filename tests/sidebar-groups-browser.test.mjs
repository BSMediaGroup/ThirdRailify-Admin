import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { applyMigration } from './auth-test-helpers.mjs';
import { createSession, resolveSession, sessionEnvelope } from '../functions/_shared/auth-core.js';
import { onRequest as admin } from '../functions/api/admin/brackets/[[path]].js';
import { onRequest as authority } from '../functions/api/brackets/[[path]].js';
import { onRequest as relay } from '../../ThirdRailify/functions/api/brackets/[[path]].js';
import { onRequest as polls } from '../functions/api/admin/polls/[[path]].js';
import { changePollLifecycle, submitWebVote } from '../functions/_shared/polls-core.js';

const ADMIN='http://127.0.0.1:44941', PUBLIC='http://127.0.0.1:44942', artifacts=`.artifacts/matchup-studio/browser-${Date.now()}`;
test('sidebar toggles retain their hit targets through mouse, keyboard and touch interaction', { timeout:180000 }, async t => {
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
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:process.env.SIDEBAR_MOTION==='normal'?'no-preference':'reduce',hasTouch:true});
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

  const toggles=page.locator('.nav-group__toggle');await toggles.first().waitFor();assert.ok(await toggles.count()>=5);
  for(let i=0;i<await toggles.count();i++){
    const button=toggles.nth(i);await button.scrollIntoViewIfNeeded();
    const id=await button.getAttribute('aria-controls');const before=await button.getAttribute('aria-expanded');
    const box=await button.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+5);await page.mouse.down();
    const pressed=await button.boundingBox();await page.mouse.up();
    assert.ok(Math.abs(pressed.y-box.y)<1,`Button ${id} moves ${pressed.y-box.y}px while pressed`);
    assert.notEqual(await button.getAttribute('aria-expanded'),before);
    for(let repeat=0;repeat<8;repeat++){
      const state=await button.getAttribute('aria-expanded');await button.click();assert.notEqual(await button.getAttribute('aria-expanded'),state);
      assert.equal(await page.locator(`[id="${id}"]`).isVisible(),state==='false');
    }
    await button.focus();const state=await button.getAttribute('aria-expanded');await page.keyboard.press('Enter');assert.notEqual(await button.getAttribute('aria-expanded'),state);await page.keyboard.press('Space');assert.equal(await button.getAttribute('aria-expanded'),state);
  }
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Open navigation',exact:true}).click();
  for(let i=0;i<await toggles.count();i++){const button=toggles.nth(i);await button.scrollIntoViewIfNeeded();const state=await button.getAttribute('aria-expanded');await button.tap();assert.notEqual(await button.getAttribute('aria-expanded'),state);}
  await page.screenshot({path:artifacts+'/sidebar-mobile.png'});
  assert.deepEqual(failures,[]);
});
