import assert from "node:assert/strict";
import test from "node:test";
import {spawn} from "node:child_process";
import {mkdir} from "node:fs/promises";
import {chromium} from "playwright-core";
const ORIGIN="http://127.0.0.1:4216";
const plan=()=>({ok:true,authority:"Commerce D1",state:"preflight",revision:1,digest:"a".repeat(64),ready:true,activatedAt:null,activatedBy:null,activationSettings:{checkout_enabled:true,internet_agreement_disclosure_enabled:true,stripe_enabled:false,printful_order_mode:"draft_then_confirm"},hardGates:[{id:"merchant_identity",ready:true,state:"ready",detail:"Encrypted merchant facts are configured."}],advisories:[{id:"printful_v2_webhook",ready:false,detail:"Polling reconciliation supplies lifecycle evidence."}],business:{tradingName:"Synthetic Store",revision:8,legalNameConfigured:true,phoneConfigured:true,addressConfigured:true,ownerConfirmed:false,disclosureAuthorized:false},settings:{checkoutEnabled:false,liveCaptureEnabled:false,fulfillmentEnabled:false,transactionalEmailEnabled:false,customerDocumentAccessEnabled:false,emergencyPaused:false},customerSending:{configuredTemplates:7,providerConfigured:true,domainVerified:true,globallyEnabled:false},catalogue:{eligibleVariants:238,eligibleSellableVariants:238,ineligibleSellableVariants:0},shippingMarkets:[{countryCode:"CA",status:"active",strategy:"printful_dynamic"}]});
test("Master launch control at 1440, 768 and 390 supports masked review, explicit confirmation, atomic edits, LIVE and emergency pause",async t=>{
  const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","4216"],{stdio:"ignore"});t.after(()=>server.kill());
  for(let i=0;i<60;i++){try{if((await fetch(ORIGIN)).ok)break;}catch{}await new Promise(r=>setTimeout(r,150));}
  const browser=await chromium.launch({executablePath:"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",headless:true});t.after(()=>browser.close());await mkdir("output/store-launch",{recursive:true});
  for(const width of [1440,768,390]) {
    const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:"reduce"});const page=await context.newPage();page.setDefaultTimeout(15000);let current=plan(),activations=0,payload=null;const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.route("**/api/**",async route=>{
      const path=new URL(route.request().url()).pathname;const json=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
      if(path==="/api/auth/config")return json({configured:true,emailSignupConfigured:true,turnstileSiteKey:null,oauthProviders:[],oauthProviderStates:[],publicOrigin:"https://thirdrailify.com",adminOrigin:ORIGIN,environment:"test",cookieMode:"host-only"});
      if(path==="/api/auth/session")return json({ok:true,authenticated:true,csrfToken:"fixture-csrf",access:{isAdmin:true,isMasterAdmin:true},account:{id:"master",email:"master@example.test",displayName:"Master",providers:["email"],role:"admin",adminLevel:"master",status:"active",emailVerified:true,source:"test",locked:true}});
      if(path==="/api/admin/inbox/summary")return json({ok:true,unread:0,actionable:{goats:{submissions:0,comments:0,emailFailures:0,total:0},total:0},latest:[]});
      if(path==="/api/admin/commerce/launch")return json(current);
      if(path==="/api/admin/commerce/launch/activate") {payload=route.request().postDataJSON();activations++;current={...current,state:"active",revision:2,activatedAt:new Date().toISOString(),activatedBy:"master",settings:{...current.settings,checkoutEnabled:true,liveCaptureEnabled:true,fulfillmentEnabled:true,transactionalEmailEnabled:true,customerDocumentAccessEnabled:true}};return json(current);}
      if(path==="/api/admin/commerce/launch/pause"){current={...current,state:"paused",settings:{...current.settings,checkoutEnabled:false,liveCaptureEnabled:false,fulfillmentEnabled:false,emergencyPaused:true}};return json(current);}
      if(path==="/api/admin/commerce/business/reveal")return json({ok:true,revision:8,legalBusinessName:"Synthetic Owner",privatePhone:"Phone synthetic 四",privateAddress:{line1:"Unconventional synthetic address"}});
      if(path==="/api/admin/commerce/overview")return json({ok:true,databaseConfigured:true,providers:[],readiness:null,posture:{}});
      return json({ok:true});
    });
    await page.goto(`${ORIGIN}/commerce`);await page.getByRole("heading",{name:"Store status: READY TO ENABLE"}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.ok(!(await page.locator("body").innerText()).includes("Phone synthetic"));
    if(width===1440){await page.getByRole("button",{name:"Reveal / edit current private merchant record"}).click();await page.getByLabel("Private business phone",{exact:true}).fill("Edited synthetic phone 五");}
    await page.getByRole("button",{name:"ENABLE STORE",exact:true}).click();const modal=page.getByRole("dialog");await modal.waitFor();
    assert.match(await modal.innerText(),/not added to general public pages/);assert.match(await modal.innerText(),/Stripe remains disabled/);
    await modal.getByText("Exact production settings changed by ENABLE STORE").click();assert.match(await modal.innerText(),/internet_agreement_disclosure_enabled/);assert.equal(await modal.evaluate(el=>el.scrollWidth<=el.clientWidth),true);assert.match(await page.locator(".store-launch-summary").innerText(),/Worldwide/);assert.match(await modal.innerText(),/not sent to PayPal or Printful/);assert.match(await modal.innerText(),/historical buyer agreement snapshots remain unchanged/);
    const final=modal.getByRole("button",{name:"ENABLE STORE"});assert.equal(await final.isDisabled(),true);assert.equal(activations,0);
    await modal.getByLabel("I confirm the current merchant facts as the owner.").check();assert.equal(await final.isDisabled(),true);
    await modal.getByLabel("I authorize transaction-only disclosure and production activation.").check();
    assert.equal(await page.evaluate(()=>document.querySelector("dialog").contains(document.activeElement)),true);
    await page.screenshot({path:`output/store-launch/confirmation-${width}.png`,fullPage:false});await final.click();
    await page.getByRole("heading",{name:"Store status: LIVE / ACTIVE"}).waitFor();assert.equal(activations,1);assert.equal(payload.ownerAttestation,true);assert.equal(payload.transactionDisclosureAuthorization,true);assert.equal(payload.expectedDigest,"a".repeat(64));
    if(width===1440)assert.equal(payload.profile.privatePhone,"Edited synthetic phone 五");
    assert.ok(!await page.evaluate(()=>JSON.stringify(localStorage).includes("synthetic phone")));
    await page.screenshot({path:`output/store-launch/active-${width}.png`,fullPage:false});await page.getByRole("button",{name:"PAUSE STORE"}).click();await page.getByRole("heading",{name:"Store status: PAUSED"}).waitFor();assert.deepEqual(errors,[]);await context.close();
  }
});
