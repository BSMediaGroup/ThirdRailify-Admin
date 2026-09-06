import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { calculateMerchantRates, validateRatebook, weightToMilligrams, cartShippingWeight, mutateShippingRatebook, saveShippingWeights, shippingManagerPayload, validateMerchantSelection } from "../functions/_shared/shipping-ratebook.js";
import { createShippingQuote, resolveShippingSelection, authoritativeCartLines, worldwideShippingMarkets } from "../functions/_shared/shipping-core.js";
import { commerceLaunchPlan } from "../functions/_shared/commerce-launch.js";
import { createCommerceDatabases, commerceEnvironment, insertTestProduct, insertTestVariant } from "./commerce-test-helpers.mjs";
const sql = await readFile(new URL("../commerce-migrations/0033_merchant_shipping_ratebook.sql", import.meta.url), "utf8");
const book = JSON.parse(sql.match(/'({"currency":"CAD".*})','Operator/)[1]);
const countries = ["AU", "GB", "US", "CA", "FR", "HK", "PR"];
const prices = { AU: [2800,3300,3900,4401], GB: [1700,2000,2400,2654], US: [1500,1800,2100,2419], CA: [2300,3000,3500,4040], FR: [4000,5000,6000,6703] };
test("all twenty exact Wix brackets and every requested boundary; Canada has a valid finite maximum", () => {
  validateRatebook(book, countries);
  for (const [country, amounts] of Object.entries(prices)) {
    [1,1101,2201,4401].forEach((grams, i) => assert.equal(calculateMerchantRates(book,country,grams*1000)[0].amount,amounts[i]));
    for (const grams of [0,1,1099,1100,1101,2199,2200,2201,4399,4400,4401,6599,6600,6601,25000]) {
      if (!grams || country === "CA" && grams > 6600) assert.throws(() => calculateMerchantRates(book,country,grams*1000), e => e.code === (grams ? "shipping_weight_out_of_range" : "shipping_weight_invalid"));
      else assert.equal(calculateMerchantRates(book,country,grams*1000)[0].amount, amounts[grams<=1100?0:grams<=2200?1:grams<=4400?2:3]);
    }
  }
  assert.equal(calculateMerchantRates(book,"US",1100000)[0].zoneId,"us");
  assert.equal(calculateMerchantRates(book,"PR",1100000)[0].zoneId,"worldwide");
  assert.equal(calculateMerchantRates(book,"CA",1100001)[0].amount,3000);
});
test("specific disabled zones never fall through; exclusions win; invalid bands and overlapping assignments reject", () => {
  const b = structuredClone(book); b.zones.find(z=>z.id==="ca").methods[0].status="disabled";
  assert.throws(()=>calculateMerchantRates(b,"CA",1000),e=>e.code==="shipping_method_unavailable");
  b.exclusions=["US"]; assert.throws(()=>calculateMerchantRates(b,"US",1000),e=>e.code==="shipping_destination_excluded");
  for(const mutate of [b=>b.zones[1].countries.push("AU"),b=>b.zones[0].methods[0].bands[1].lowerMg++,b=>b.zones[0].methods[0].bands[1].lowerMg--,b=>b.zones[0].methods[0].bands[0].upperMg=null,b=>b.zones[0].methods[0].bands[0].amount=-1,b=>b.zones[0].methods[0].bands[0].upperMg=0]) { const invalid=structuredClone(book);mutate(invalid);assert.throws(()=>validateRatebook(invalid,countries)); }
});
test("exact units and free shipping use merchandise subtotal only within coverage", () => {
  assert.equal(weightToMilligrams("1.100001","kg"),1100001);assert.equal(weightToMilligrams("0.001","g"),1);
  for(const value of ["0","-1","NaN","1e3","0.0001"]) assert.throws(()=>weightToMilligrams(value,"g"));
  assert.ok(book.zones.every(z=>z.methods[0].freeShippingSubtotal===null));
  const b=structuredClone(book);b.zones[3].methods[0].freeShippingSubtotal=5000;
  assert.equal(calculateMerchantRates(b,"CA",1100000,4999)[0].amount,2300);assert.equal(calculateMerchantRates(b,"CA",1100000,5000)[0].amount,0);
  assert.throws(()=>calculateMerchantRates(b,"CA",6601000,5000),e=>e.code==="shipping_weight_out_of_range");
});
test("D1 draft publication, weights, independent provider cost, stale quote rejection and zero provider effects on invalid carts", async () => {
  const h=await createCommerceDatabases();const db=h.commerceDb;const env=commerceEnvironment(h,{PRINTFUL_API_TOKEN:"synthetic-provider-token"});
  try {
    await insertTestProduct(db,{requiresShipping:1});await insertTestVariant(db,{targetCatalogueVariantId:"11576"});
    await db.batch([db.prepare("UPDATE commerce_products SET provider_presence='current' WHERE id='product-test-001'"),db.prepare("UPDATE commerce_product_variants SET provider_presence='current' WHERE id='variant-test-001'")]);
    await db.batch(worldwideShippingMarkets().map(m=>db.prepare("INSERT OR IGNORE INTO commerce_shipping_markets(country_code,display_name,status,strategy,revision,created_at,updated_at) VALUES(?,?,'active','printful_dynamic',1,'2026-09-06','2026-09-06')").bind(m.countryCode,m.displayName)));
    await db.prepare("UPDATE commerce_shipping_markets SET status='active'").run();
    const initial=await shippingManagerPayload(env);assert.equal(initial.coverage.missing.length,1);
    await assert.rejects(mutateShippingRatebook(env,{action:"publish",ratebookId:"wix-five-zone-20260906",revision:1,body:book}),e=>e.code==="shipping_weights_incomplete");
    await saveShippingWeights(env,"product-test-001",{assignments:[{variantId:null,revision:0,value:"550",unit:"g",provenance:"Synthetic measured fixture"}]});
    const lines=[{productId:"product-test-001",variantId:"variant-test-001",productName:"Fixture",requiresShipping:true,quantity:2}];
    assert.equal((await cartShippingWeight(db,lines)).totalMg,1100000);
    await assert.rejects(saveShippingWeights(env,"product-test-001",{assignments:[{variantId:null,revision:0,value:"1",unit:"g",provenance:"stale"}]}),e=>e.code==="shipping_revision_conflict");
    const published=await mutateShippingRatebook(env,{action:"publish",ratebookId:"wix-five-zone-20260906",revision:1,body:book});assert.equal(published.books.find(b=>b.status==="published").body.zones[3].methods[0].bands[3].upperMg,6600000);
    await assert.rejects(mutateShippingRatebook(env,{action:"save",ratebookId:"wix-five-zone-20260906",revision:1,body:book}),e=>e.code==="shipping_revision_conflict");
    const readiness=await commerceLaunchPlan(env);
    assert.equal(readiness.hardGates.find(g=>g.id==="shipping").ready,true);
    assert.ok(JSON.stringify(readiness).includes("Finite method ceilings are valid"));
    await assert.rejects(db.prepare("UPDATE commerce_shipping_ratebooks SET body_json='{}' WHERE status='published'").run(),/immutable/);
    const provider=await db.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider='printful'").first();
    await db.prepare("UPDATE commerce_provider_connections SET status='connected',integration_mode='fulfillment',currency_code='CAD',safe_metadata_json=? WHERE provider='printful'").bind(JSON.stringify({...JSON.parse(provider.safe_metadata_json),api_configured:true})).run();
    let calls=0;const fetchImpl=async()=>{calls++;return Response.json({code:200,result:[{id:"STANDARD",name:"Provider name",rate:"13.50",currency:"CAD"}]});};
    const recipient={name:"Synthetic Fixture",address1:"100 Test Street",city:"London",region:"ON",postalCode:"N6A 1A1",countryCode:"CA"};
    const items=[{productId:"product-test-001",variantId:"variant-test-001",quantity:2}];
    const request=new Request("https://example.test/api/commerce/shipping-quotes",{method:"POST"});
    const q=await createShippingQuote(env,request,{items,recipient},fetchImpl);assert.equal(q.quote.options[0].amount,2300);assert.equal(q.quote.options[0].name,"Standard Shipping (CA)");assert.equal(q.quote.options[0].delivery,null);assert.equal(calls,1);
    const authority=await authoritativeCartLines(db,items,{gate:"shipping_quote",environment:"test"});
    const selection=await resolveShippingSelection(db,{lines:authority,recipient,quoteId:q.quote.id,optionId:q.quote.options[0].id});assert.equal(selection.option.providerCostAmount,1350);assert.equal(selection.option.providerRateId,"STANDARD");
    await saveShippingWeights(env,"product-test-001",{assignments:[{variantId:"variant-test-001",revision:0,value:"3300.5",unit:"g",provenance:"Synthetic variant override"}]});
    await assert.rejects(validateMerchantSelection(db,authority,"CA",selection.option,10000));
    await assert.rejects(createShippingQuote(env,request,{items,recipient},fetchImpl),e=>e.code==="shipping_weight_out_of_range");assert.equal(calls,1);
    await assert.rejects(createShippingQuote(env,request,{items:[{...items[0],weight:1}],recipient},fetchImpl),e=>e.code==="checkout_line_invalid");assert.equal(calls,1);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM commerce_orders").first()).n,0);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results,[]);
  } finally { await h.dispose(); }
});
