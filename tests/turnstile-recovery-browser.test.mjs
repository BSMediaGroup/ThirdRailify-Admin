import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
test('Turnstile failure retains widget and explicit retry recovers without granting authentication', async t => {
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','44945'],{stdio:'ignore'});t.after(()=>server.kill());
 for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:44945')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});t.after(()=>browser.close());const p=await browser.newPage();
 await p.route('**/api/**',r=>r.fulfill({json:r.request().url().endsWith('/config')?{configured:true,turnstileSiteKey:'local-fixture',oauthProviders:[],oauthProviderStates:[]}:{ok:true,authenticated:false,account:null}}));
 await p.route('https://challenges.cloudflare.com/**',r=>r.fulfill({contentType:'application/javascript',body:`window.renders=0;window.turnstile={render(el,o){window.renders++;el.textContent='Verification fixture';setTimeout(()=>o['error-callback']('600010'),10);return 'fixture';},remove(){document.querySelector('.auth-turnstile>div').replaceChildren()},reset(){}};`}));
 await p.goto('http://127.0.0.1:44945/polls/abootnothing');await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.getByRole('button',{name:'Retry verification'}).waitFor();
 assert.match(await p.locator('.auth-turnstile').innerText(),/600010/);assert.match(await p.locator('.auth-turnstile>div').innerText(),/Verification fixture/);
 await p.getByRole('button',{name:'Retry verification'}).click();await p.waitForFunction(()=>window.renders===2);assert.ok(await p.locator('.auth-dialog button[type=submit]').isDisabled());
});
