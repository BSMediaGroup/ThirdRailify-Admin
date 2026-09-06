import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { calculateMerchantRates, validateRatebook, weightToMilligrams } from "../functions/_shared/shipping-ratebook.js";
const origin="http://127.0.0.1:4187";
test("shipping manager, destination editor, bounded Canadian rates, calculator and weight controls at 1440/768/390",async t=>{
  const sql=await readFile(new URL("../commerce-migrations/0033_merchant_shipping_ratebook.sql",import.meta.url),"utf8");
  const original=JSON.parse(sql.match(/'({"currency":"CAD".*})','Operator/)[1]);
  await mkdir("output/merchant-shipping",{recursive:true});
  const screenshots=`output/merchant-shipping/flags-${Date.now()}`;
  await mkdir(screenshots,{recursive:true});
  await writeFile("output/merchant-shipping/weights.html",'<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/output/merchant-shipping/weights.tsx"></script></body></html>');
  await writeFile("output/merchant-shipping/weights.tsx",'import React from "react";import{createRoot}from"react-dom/client";import{ProductShippingWeights}from"/src/commerce/ProductShippingWeights";createRoot(document.getElementById("root")).render(<ProductShippingWeights productId="fixture" csrfToken="synthetic" canManage={true}/>);');
  const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","4187"],{stdio:"ignore",windowsHide:true});t.after(()=>server.kill());
  for(let i=0;i<60;i++){try{if((await fetch(origin)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const browser=await chromium.launch({executablePath:"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",headless:true});t.after(()=>browser.close());
  for(const width of [1440,768,390]){
    const page=await browser.newPage({viewport:{width,height:950},reducedMotion:"reduce"});
    let book=structuredClone(original),revision=1,weightPayload={weights:[],variants:[{id:"v1",sku:"FIXTURE-1",size_label:"M",color_label:"Black"},{id:"v2",sku:"FIXTURE-2",size_label:"L",color_label:"Black"}]};
    const markets=["AU","GB","US","CA","FR","HK"].map(country_code=>({country_code,display_name:new Intl.DisplayNames(["en"],{type:"region"}).of(country_code)}));
    const payload=()=>({ok:true,policy:{active_ratebook_id:null,revision:1},books:[{id:"fixture-draft",revision,status:"draft",body:book}],markets,coverage:{total:2,covered:0,missing:[]}});
    const fulfill=(route,data,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(data)});
    await page.route("**/api/**",async route=>{
      const path=new URL(route.request().url()).pathname,method=route.request().method();
      if(path==="/api/auth/config")return fulfill(route,{configured:true,emailSignupConfigured:true,turnstileSiteKey:null,oauthProviders:[],oauthProviderStates:[],publicOrigin:origin,adminOrigin:origin,environment:"test",cookieMode:"host-only"});
      if(path==="/api/auth/session")return fulfill(route,{ok:true,authenticated:true,csrfToken:"synthetic",access:{isAdmin:true,isMasterAdmin:true},account:{id:"fixture",email:"fixture@example.test",displayName:"Fixture",providers:["email"],role:"admin",adminLevel:"master",status:"active",emailVerified:true}});
      if(path==="/api/admin/inbox/summary")return fulfill(route,{ok:true,unread:0,actionable:{goats:{total:0},total:0},latest:[]});
      if(path==="/api/admin/commerce/shipping-rates"){
        if(method==="POST"){const input=route.request().postDataJSON();try{validateRatebook(input.body,markets.map(m=>m.country_code));}catch(e){return fulfill(route,{ok:false,error:e.code,message:e.message},409);}if(input.action==="publish")return fulfill(route,{ok:false,error:"shipping_weights_incomplete",message:"Two variants need real shipping weights."},409);book=input.body;revision++;}return fulfill(route,payload());
      }
      if(path.endsWith("/shipping-rates/calculate")){const b=route.request().postDataJSON();try{return fulfill(route,{ok:true,options:calculateMerchantRates(b.body,b.country,weightToMilligrams(b.weight,b.unit),b.subtotalAmount)});}catch(e){return fulfill(route,{ok:false,error:e.code,message:e.message},409);}}
      if(path.endsWith("/shipping-weights")){if(method==="POST"){const b=route.request().postDataJSON();weightPayload.weights=b.assignments.map(a=>({id:a.variantId||"product",variant_id:a.variantId,weight_mg:a.value===null?null:weightToMilligrams(a.value,a.unit),revision:1,provenance:a.provenance}));}return fulfill(route,weightPayload);}
      return fulfill(route,{ok:false,error:"fixture_unavailable",message:"Unrelated operations fixture omitted."},503);
    });
    await page.goto(origin+"/commerce/fulfillment");const workspace=page.locator("#shipping-rates");await workspace.getByRole("heading",{name:"Canada",exact:true}).waitFor();
    assert.equal(await workspace.locator(".shipping-zone-heading img").count(),5);
    await page.waitForFunction(()=>[...document.querySelectorAll(".shipping-zone-heading img")].every(img=>img.complete&&img.naturalWidth>0));
    const canada=workspace.locator("article").filter({has:page.getByRole("heading",{name:"Canada",exact:true})});
    await canada.getByRole("button",{name:"Edit rate",exact:true}).click();
    const editor=workspace.getByRole("group",{name:"Edit rate — Canada",exact:true});
    assert.equal(await editor.getByLabel("Up to (including), g — blank means And up",{exact:true}).last().inputValue(),"6600");
    await editor.getByLabel("Name at checkout",{exact:true}).fill("Standard Shipping (CA) edited");await workspace.getByRole("button",{name:"Save draft",exact:true}).click();await workspace.getByText("Draft saved.",{exact:true}).waitFor();
    await canada.getByRole("button",{name:"Edit destinations",exact:true}).click();await workspace.getByRole("group",{name:"Edit destinations — Canada",exact:true}).waitFor();
    await page.screenshot({path:`${screenshots}/admin-destinations-${width}.png`,fullPage:true});
    const calc=workspace.getByRole("group",{name:"Test this rate",exact:true});await calc.getByRole("button",{name:"Calculate",exact:true}).click();await calc.getByRole("status").filter({hasText:"40.40"}).waitFor();
    await calc.getByLabel("Cart shipping weight, g",{exact:true}).fill("6601");await calc.getByRole("button",{name:"Calculate",exact:true}).click();await calc.getByRole("status").filter({hasText:"do not cover"}).waitFor();
    await canada.getByRole("button",{name:"Edit rate",exact:true}).click();await page.screenshot({path:`${screenshots}/admin-rates-${width}.png`,fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.goto(origin+"/output/merchant-shipping/weights.html");await page.getByRole("heading",{name:"Shipping weights",exact:true}).waitFor();
    await page.getByLabel("Shipping weight",{exact:true}).fill("550");await page.getByLabel("Source / provenance",{exact:true}).fill("Synthetic measured fixture");await page.getByRole("button",{name:"Save shipping weights",exact:true}).click();await page.getByText("Product default: 550 g · Synthetic measured fixture",{exact:true}).waitFor();
    assert.equal(await page.getByText("Inherited: 550 g",{exact:false}).count(),2);
    await page.screenshot({path:`${screenshots}/weights-${width}.png`,fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.close();
  }
});
