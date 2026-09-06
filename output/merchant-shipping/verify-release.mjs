import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root=new URL("./",import.meta.url);
async function readJson(name){const b=await readFile(new URL(name,root));return JSON.parse(b.toString(b[0]===255&&b[1]===254?"utf16le":"utf8").replace(/^\uFEFF/,""));}
const after=await readJson("state-readback.json"),verification=await readJson("verification.json");
const initialSettings={commerce_emergency_paused:false,commerce_environment:"production",paypal_donations_enabled:true,paypal_store_checkout_enabled:false,preferred_payment_provider:"paypal",shipping_strategy:"printful_dynamic",stripe_enabled:false};
assert.deepEqual(Object.fromEntries(after[0].results.map(r=>[r.setting_key,JSON.parse(r.value_json)])),initialSettings);
const ratebook=verification[1].results[0],policy=verification[2].results[0];
assert.equal(ratebook.status,"draft");assert.equal(ratebook.revision,1);assert.equal(policy.active_ratebook_id,null);assert.deepEqual(verification[3].results,[]);
const seed=JSON.parse((await readFile(new URL("../../commerce-migrations/0033_merchant_shipping_ratebook.sql",root),"utf8")).match(/'({"currency":"CAD".*})','Operator/)[1]);
assert.deepEqual(JSON.parse(ratebook.body_json),seed);
const rows=verification[5].results,missing=rows.filter(r=>!r.weightMg);
const csv=["productId,productName,environment,variantId,sku,size,color",...missing.map(r=>[r.productId,r.productName,r.environment,r.variantId,r.sku,r.size_label,r.color_label].map(v=>'"'+String(v??"").replaceAll('"','""')+'"').join(","))].join("\n");
await writeFile(new URL("missing-variant-weights.csv",root),csv);
const probes=[];
for(const [origin,repo]of [["https://admin.thirdrailify.com","X:/GIT/ThirdRailify-Admin"],["https://thirdrailify.com","X:/GIT/ThirdRailify"]]){
 const res=await fetch(origin+"/?shipping_release=20260906",{signal:AbortSignal.timeout(15000)});const html=await res.text();
 const local=await readFile(repo+"/dist/index.html","utf8");const js=local.match(/src="([^"]+\.js)"/)[1];assert.ok(html.includes(js),origin+" serves current bundle");
 const asset=await fetch(origin+js,{signal:AbortSignal.timeout(15000)});const hash=b=>createHash("sha256").update(b).digest("hex");assert.equal(hash(Buffer.from(await asset.arrayBuffer())),hash(await readFile(repo+"/dist"+js)));
 probes.push({origin,status:res.status,bundle:js,hashVerified:true});
}
for(const url of ["https://admin.thirdrailify.com/api/admin/commerce/shipping-rates","https://thirdrailify.com/api/commerce/shipping-markets","https://thirdrailify.com/api/commerce/payment-config"]){const r=await fetch(url,{signal:AbortSignal.timeout(15000)});const p=await r.json();probes.push({url,status:r.status,json:true,...(p.markets?{destinations:p.markets.length}:{}),...(url.endsWith("payment-config")?{storeCheckoutEnabled:p.storeCheckoutEnabled,donationsEnabled:p.donationsEnabled,stripe:p.stripe}:{}),...(p.error?{error:p.error}:{})});}
const result={settingsPreservationVerified:true,historicalPreservationEvidence:"Migration creates new tables only; no historical-order or private-profile mutation was issued. Historical figures below are post-deployment readback, not a before/after checksum.",migration:verification[0].results,ratebook:{id:ratebook.id,revision:ratebook.revision,status:ratebook.status},policy,coverage:{total:rows.length,covered:rows.length-missing.length,missing:missing.length,environments:[...new Set(rows.map(r=>r.environment))]},historicalOrders:after[1].results.length,foreignKeyViolations:0,probes};
await writeFile(new URL("release-verification.json",root),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
