import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {browserFixture} from './readability-fixtures.mjs';
const origin='http://127.0.0.1:44204';
const fixture=browserFixture(process.cwd(),'overview-browser.test.mjs',origin);
test('Overview delayed healthy, retained failure and automatic recovery share one state at desktop/mobile',async t=>{
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','44204'],{stdio:'ignore'});t.after(()=>server.kill());
 for(let i=0;i<80;i++){try{if((await fetch(origin)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});t.after(()=>browser.close());
 fs.mkdirSync('.artifacts/overview-release',{recursive:true});
 for(const width of [1440,390,768,1920]){
  const context=await browser.newContext({viewport:{width,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let fail=false;let held=null;let hold=false;let runtimeReads=0;const network=[];
  await page.route('**/api/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;network.push({at:Date.now(),route:pathname,method:route.request().method(),simulated:true});
   if(pathname==='/api/admin/automations'){
    runtimeReads++;if(hold){held=route;return;}
    if(fail)return route.fulfill({status:503,contentType:'application/json',headers:{'X-Overview-Reference':'simulated-runtime-503'},body:JSON.stringify({ok:false,error:'runtime_unavailable',message:'PRIVATE upstream text'})});
   }
   return fixture.routeFixture(route,()=>{});
  });
  await page.clock.install();await page.goto(origin);await page.getByText('7/7',{exact:true}).waitFor();
  const state=[];
  const record=async label=>state.push({label,pulse:await page.locator('.overview-pulse').innerText(),warning:await page.locator('.overview-partial').allTextContents(),runtimeReads});
  for(const milliseconds of [10000,6000,15000,15000]){await page.clock.runFor(milliseconds);await page.waitForTimeout(150);assert.equal(await page.locator('.overview-partial').count(),0);assert.equal(await page.getByText('7/7',{exact:true}).count(),1);await record(`healthy +${milliseconds}ms`);}
  await page.screenshot({path:`.artifacts/overview-release/healthy-${width}.png`});
  fail=true;await page.clock.runFor(15000);await page.locator('.overview-partial').waitFor();await record('simulated failure');
  assert.match(await page.locator('.overview-partial').innerText(),/Bot runtime.*retained/i);assert.equal(await page.getByText('6/7',{exact:true}).count(),1);
  await page.getByText(/Component diagnostics ·/).click();
  const diagnostic=page.locator('[data-source="automations"]');assert.match(await diagnostic.innerText(),/Retained \/ stale/i);assert.match(await diagnostic.innerText(),/503/);assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE upstream/);
  const lastSuccess=await diagnostic.locator('dd').nth(1).innerText();
  await page.screenshot({path:`.artifacts/overview-release/failure-${width}.png`,fullPage:false});
  fail=false;await page.clock.runFor(30000);await page.getByText('7/7',{exact:true}).waitFor();assert.equal(await page.locator('.overview-partial').count(),0);assert.notEqual(await diagnostic.locator('dd').nth(1).innerText(),lastSuccess);await record('automatic recovery');
  await page.screenshot({path:`.artifacts/overview-release/recovered-${width}.png`});
  hold=true;await page.clock.runFor(15000);await page.waitForTimeout(150);assert.ok(held);const reads=runtimeReads;
  await page.evaluate(()=>{document.querySelector('.overview-hero__actions button').click();document.querySelector('.overview-hero__actions button').click();});
  await page.waitForTimeout(150);assert.equal(runtimeReads,reads,'manual refresh does not overlap automatic read');
  hold=false;await fixture.routeFixture(held,()=>{});held=null;await page.waitForTimeout(150);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  const beforeHidden=runtimeReads;await page.clock.runFor(60000);assert.equal(runtimeReads,beforeHidden);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(150);assert.equal(runtimeReads,beforeHidden+1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  if(width===1440){
   hold=true;await page.clock.runFor(15000);await page.waitForTimeout(150);assert.ok(held);const obsolete=held;held=null;hold=false;
   await page.goto(origin+'/analytics');await page.goto(origin);await page.getByText('7/7',{exact:true}).waitFor();
   await obsolete.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'old_failure'})}).catch(()=>{});
   await page.waitForTimeout(150);assert.equal(await page.locator('.overview-partial').count(),0,'unmounted old failure cannot create an incident after remount');
  }
  fs.writeFileSync(`.artifacts/overview-release/timeline-${width}.json`,JSON.stringify({simulated:true,state,network},null,2));await context.close();
 }
});
