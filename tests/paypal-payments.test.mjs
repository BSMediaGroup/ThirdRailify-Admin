import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as donationRoute } from "../functions/api/commerce/paypal/donation.js";
import { onRequest as captureRoute } from "../functions/api/commerce/paypal/capture.js";
import { onRequest as storeRoute } from "../functions/api/commerce/paypal/store.js";
import { handlePayPalWebhook } from "../functions/api/webhooks/paypal.js";
import { createPayPalOrder, minorUnitsToPayPal, paypalAmountToMinor, PAYPAL_WEBHOOK_EVENTS } from "../functions/_shared/paypal-client.js";
import { createPayPalDonationPayment, createPayPalStorePayment } from "../functions/_shared/paypal-commerce.js";
import { accountInboxMessages } from "../functions/_shared/account-commerce.js";
import { commerceEnvironment, createCommerceDatabases, insertTestProduct, insertTestShippingQuote, insertTestVariant, TEST_DELIVERY_RECIPIENT } from "./commerce-test-helpers.mjs";

const ORIGIN = "https://thirdrailify.pages.dev";
const API = "https://thirdrailify-admin.pages.dev";

async function enableSandbox(db) {
  await db.batch([
    db.prepare("UPDATE commerce_payment_provider_state SET paypal_sandbox_configured=1,paypal_donations_enabled=1 WHERE id='primary'"),
    db.prepare("UPDATE commerce_settings SET value_json='true' WHERE setting_key IN ('paypal_sandbox_configured','paypal_sandbox_webhook_configured','paypal_donations_enabled')"),
  ]);
}

async function enableSandboxStore(db) {
  await enableSandbox(db);
  await db.batch([
    db.prepare("UPDATE commerce_payment_provider_state SET paypal_store_checkout_enabled=1 WHERE id='primary'"),
    db.prepare("UPDATE commerce_settings SET value_json='true' WHERE setting_key='paypal_store_checkout_enabled'"),
    db.prepare("UPDATE commerce_settings SET value_json='\"not_collecting\"' WHERE setting_key='tax_calculation_provider'"),
  ]);
}

function envFor(harness) {
  return commerceEnvironment(harness, {
    PAYPAL_SANDBOX_CLIENT_ID: "sandbox-client-id-for-tests",
    PAYPAL_SANDBOX_CLIENT_SECRET: "sandbox-client-secret-for-tests",
    PAYPAL_SANDBOX_WEBHOOK_ID: "WH-sandbox-webhook-id",
  });
}

function post(path, body) {
  return new Request(`${API}${path}`, { method:"POST", headers:{ Origin:ORIGIN,"Content-Type":"application/json" }, body:JSON.stringify(body) });
}

test("PayPal money conversion is exact integer CAD arithmetic", () => {
  assert.equal(minorUnitsToPayPal(0),"0.00");
  assert.equal(minorUnitsToPayPal(1501),"15.01");
  assert.equal(paypalAmountToMinor("15.01"),1501);
  assert.equal(paypalAmountToMinor("15.0"),null);
  assert.throws(() => minorUnitsToPayPal(1.5));
});

test("PayPal client keeps Sandbox and Live OAuth and Orders endpoints separate", async () => {
  const urls=[];const fetchImpl=async(url,init={})=>{urls.push({url,authorization:new Headers(init.headers).get("Authorization")});if(url.endsWith("/v1/oauth2/token"))return Response.json({access_token:url.includes("sandbox")?"sandbox-token":"live-token",token_type:"Bearer",expires_in:3600});return Response.json({id:"ORDERENDPOINT",intent:"CAPTURE",status:"CREATED",purchase_units:[]},{status:201});};
  const env={PAYPAL_SANDBOX_CLIENT_ID:"sandbox-client",PAYPAL_SANDBOX_CLIENT_SECRET:"sandbox-secret",PAYPAL_LIVE_CLIENT_ID:"live-client",PAYPAL_LIVE_CLIENT_SECRET:"live-secret"};
  await createPayPalOrder(env,"sandbox",{intent:"CAPTURE"},"sandbox-request-id",fetchImpl);await createPayPalOrder(env,"live",{intent:"CAPTURE"},"live-request-id",fetchImpl);
  assert.equal(urls.some((call)=>call.url==="https://api-m.sandbox.paypal.com/v2/checkout/orders"&&call.authorization==="Bearer sandbox-token"),true);
  assert.equal(urls.some((call)=>call.url==="https://api-m.paypal.com/v2/checkout/orders"&&call.authorization==="Bearer live-token"),true);
  assert.doesNotMatch(JSON.stringify(urls),/sandbox-secret|live-secret/);
});

test("emergency pause blocks donation creation before local or provider mutation",async(t)=>{
  const harness=await createCommerceDatabases();t.after(harness.dispose);await enableSandbox(harness.commerceDb);
  await harness.commerceDb.batch([harness.commerceDb.prepare("UPDATE commerce_payment_provider_state SET emergency_paused=1 WHERE id='primary'"),harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='true' WHERE setting_key='commerce_emergency_paused'")]);let calls=0;
  const response=await donationRoute({request:post("/api/commerce/paypal/donation",{donationRequestId:"33333333-3333-4333-8333-333333333333",amountMinor:500}),env:envFor(harness),data:{paypalFetch:async()=>{calls+=1;}}});
  assert.equal(response.status,409);assert.equal((await response.json()).error,"commerce_emergency_paused");assert.equal(calls,0);assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_donations").first()).count,0);
});

test("one-time donation is local-first, idempotent, server-created, and server-captured", async (t) => {
  const harness=await createCommerceDatabases();t.after(harness.dispose);await enableSandbox(harness.commerceDb);
  const env=envFor(harness);let targetId="";const calls=[];
  const paypalFetch=async(url,init={})=>{
    calls.push({url,method:init.method,body:init.body,requestId:new Headers(init.headers).get("PayPal-Request-Id")});
    if(url.endsWith("/v1/oauth2/token"))return Response.json({access_token:"access-token-test",token_type:"Bearer",expires_in:3600});
    if(url.endsWith("/v2/checkout/orders")&&init.method==="POST"){
      const body=JSON.parse(init.body);targetId=body.purchase_units[0].reference_id;
      assert.equal(body.intent,"CAPTURE");assert.equal(body.purchase_units[0].amount.value,"15.00");assert.equal(body.payment_source.paypal.experience_context.shipping_preference,"NO_SHIPPING");
      return Response.json({id:"PAYPALORDER001",intent:"CAPTURE",status:"CREATED",purchase_units:[{reference_id:targetId,custom_id:targetId,amount:{currency_code:"CAD",value:"15.00"}}]},{status:201,headers:{"paypal-debug-id":"debug-create"}});
    }
    if(url.endsWith("/v2/checkout/orders/PAYPALORDER001")&&init.method==="GET")return Response.json({id:"PAYPALORDER001",intent:"CAPTURE",status:"APPROVED",purchase_units:[{reference_id:targetId,custom_id:targetId,amount:{currency_code:"CAD",value:"15.00"}}]});
    if(url.endsWith("/v2/checkout/orders/PAYPALORDER001/capture")&&init.method==="POST")return Response.json({id:"PAYPALORDER001",intent:"CAPTURE",status:"COMPLETED",purchase_units:[{reference_id:targetId,custom_id:targetId,amount:{currency_code:"CAD",value:"15.00"},payments:{captures:[{id:"CAPTURE001",status:"COMPLETED",amount:{currency_code:"CAD",value:"15.00"}}]}}]},{headers:{"paypal-debug-id":"debug-capture"}});
    throw new Error(`unexpected PayPal request ${init.method} ${url}`);
  };
  const requestId="11111111-1111-4111-8111-111111111111";
  const createdResponse=await donationRoute({request:post("/api/commerce/paypal/donation",{donationRequestId:requestId,amountMinor:1500}),env,data:{paypalFetch}});
  assert.equal(createdResponse.status,201);const created=await createdResponse.json();assert.equal(created.provider,"paypal");assert.equal(created.target,"donation");assert.equal(created.orderId,"PAYPALORDER001");
  const duplicateResponse=await donationRoute({request:post("/api/commerce/paypal/donation",{donationRequestId:requestId,amountMinor:1500}),env,data:{paypalFetch}});
  assert.equal(duplicateResponse.status,201);assert.equal((await duplicateResponse.json()).attemptId,created.attemptId);
  assert.equal(calls.filter((call)=>call.url.endsWith("/v2/checkout/orders")&&call.method==="POST").length,1);
  const captureResponse=await captureRoute({request:post("/api/commerce/paypal/capture",{attemptId:created.attemptId}),env,data:{paypalFetch}});
  assert.equal(captureResponse.status,200);assert.equal((await captureResponse.json()).status,"completed");
  const donation=await harness.commerceDb.prepare("SELECT status,amount_minor,environment FROM commerce_donations").first();assert.deepEqual(donation,{status:"completed",amount_minor:1500,environment:"sandbox"});
  const attempt=await harness.commerceDb.prepare("SELECT provider_order_id,provider_capture_id,normalized_state FROM commerce_payment_attempts").first();assert.deepEqual(attempt,{provider_order_id:"PAYPALORDER001",provider_capture_id:"CAPTURE001",normalized_state:"completed"});
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_orders").first()).count,0);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_operation_jobs").first()).count,0);
});

test("an authenticated Master donation lazily creates the canonical customer and account message",async(t)=>{
  const harness=await createCommerceDatabases();t.after(harness.dispose);await enableSandbox(harness.commerceDb);const timestamp=new Date().toISOString();
  await harness.authDb.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES('env-master-1','master@example.test','Master Admin','admin','master','active',?,?,?,'env_master')").bind(timestamp,timestamp,timestamp).run();
  const body={donationRequestId:"88888888-8888-4888-8888-888888888888",amountMinor:1500};const session={accountId:"env-master-1",account:{id:"env-master-1",displayName:"Master Admin",email:"master@example.test",role:"admin",adminLevel:"master",status:"active"}};
  const paypalFetch=async(url,init={})=>{if(url.endsWith("/v1/oauth2/token"))return Response.json({access_token:"donation-master-token",token_type:"Bearer",expires_in:3600});if(url.endsWith("/v2/checkout/orders")){const requestBody=JSON.parse(init.body);const reference=requestBody.purchase_units[0].reference_id;return Response.json({id:"PAYPALDONMASTER001",intent:"CAPTURE",status:"CREATED",purchase_units:[{reference_id:reference,custom_id:reference,amount:{currency_code:"CAD",value:"15.00"}}]},{status:201});}throw new Error("unexpected request");};
  const created=await createPayPalDonationPayment(envFor(harness),post("/api/commerce/paypal/donation",body),body,session,paypalFetch);
  const donation=await harness.commerceDb.prepare("SELECT d.customer_id,c.linked_account_id FROM commerce_donations d JOIN commerce_customers c ON c.id=d.customer_id").first();assert.equal(donation.linked_account_id,"env-master-1");
  const inbox=await accountInboxMessages(envFor(harness),"env-master-1");assert.equal(inbox.total,1);assert.equal(inbox.items[0].sourceId,created.reference);assert.equal(inbox.items[0].sourceType,"donation.created");
});

test("store order persists authoritative customer, delivery, totals, and PayPal attempt before provider approval",async(t)=>{
  const harness=await createCommerceDatabases();t.after(harness.dispose);await enableSandboxStore(harness.commerceDb);
  await insertTestProduct(harness.commerceDb,{requiresShipping:1,targetPrintfulProductId:"target-product-001",migrationStatus:"target_verified"});
  await insertTestVariant(harness.commerceDb,{migrationStatus:"target_verified"});
  const items=[{productId:"product-test-001",variantId:"variant-test-001",quantity:1}];const shipping=await insertTestShippingQuote(harness.commerceDb,{items});let providerBody;
  const paypalFetch=async(url,init={})=>{if(url.endsWith("/v1/oauth2/token"))return Response.json({access_token:"store-token",token_type:"Bearer",expires_in:3600});if(url.endsWith("/v2/checkout/orders")){providerBody=JSON.parse(init.body);const reference=providerBody.purchase_units[0].reference_id;return Response.json({id:"PAYPALSTORE001",intent:"CAPTURE",status:"CREATED",purchase_units:[{reference_id:reference,custom_id:reference,amount:{currency_code:"CAD",value:"32.50"}}]},{status:201});}throw new Error("unexpected request");};
  const body={checkoutRequestId:"22222222-2222-4222-8222-222222222222",items,recipient:shipping.recipient,quoteId:shipping.quoteId,shippingOptionId:shipping.shippingOptionId,customer:{mode:"guest",name:"Checkout Fixture",email:"store@example.test"}};
  const response=await storeRoute({request:post("/api/commerce/paypal/store",body),env:envFor(harness),data:{paypalFetch}});assert.equal(response.status,201,JSON.stringify(await response.clone().json()));const payload=await response.json();assert.equal(payload.orderId,"PAYPALSTORE001");
  assert.equal(providerBody.purchase_units[0].amount.breakdown.item_total.value,"27.50");assert.equal(providerBody.purchase_units[0].amount.breakdown.shipping.value,"5.00");assert.equal(providerBody.purchase_units[0].payment_source,undefined);assert.equal(providerBody.payment_source.paypal.experience_context.shipping_preference,"SET_PROVIDED_ADDRESS");
  const order=await harness.commerceDb.prepare("SELECT customer_payment_provider,payment_status,customer_gross_amount,product_subtotal_amount,shipping_amount,tax_amount,tax_status,environment FROM commerce_orders").first();assert.deepEqual(order,{customer_payment_provider:"paypal",payment_status:"pending",customer_gross_amount:3250,product_subtotal_amount:2750,shipping_amount:500,tax_amount:0,tax_status:"not_collecting",environment:"test"});
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_order_delivery_snapshots").first()).count,1);assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_customers").first()).count,1);
});

test("an environment Master purchase uses its canonical customer and receives only its transactional account message",async(t)=>{
  const harness=await createCommerceDatabases();t.after(harness.dispose);await enableSandboxStore(harness.commerceDb);
  await insertTestProduct(harness.commerceDb,{requiresShipping:1,targetPrintfulProductId:"target-product-001",migrationStatus:"target_verified"});
  await insertTestVariant(harness.commerceDb,{migrationStatus:"target_verified"});
  const timestamp=new Date().toISOString();
  await harness.authDb.batch([
    harness.authDb.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES('env-master-1','master@example.test','Master Admin','admin','master','active',?,?,?,'env_master')").bind(timestamp,timestamp,timestamp),
    harness.authDb.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES('other-account','other@example.test','Other Account','user','none','active',?,?,?,'test')").bind(timestamp,timestamp,timestamp),
  ]);
  const items=[{productId:"product-test-001",variantId:"variant-test-001",quantity:1}];const shipping=await insertTestShippingQuote(harness.commerceDb,{items});
  const body={checkoutRequestId:"77777777-7777-4777-8777-777777777777",items,recipient:shipping.recipient,quoteId:shipping.quoteId,shippingOptionId:shipping.shippingOptionId,customer:{mode:"account",name:"Master Admin",email:"master@example.test"}};
  const session={accountId:"env-master-1",account:{id:"env-master-1",displayName:"Master Admin",email:"master@example.test",role:"admin",adminLevel:"master",status:"active"}};
  const paypalFetch=async(url,init={})=>{if(url.endsWith("/v1/oauth2/token"))return Response.json({access_token:"master-token",token_type:"Bearer",expires_in:3600});if(url.endsWith("/v2/checkout/orders")){const requestBody=JSON.parse(init.body);const reference=requestBody.purchase_units[0].reference_id;return Response.json({id:"PAYPALMASTER001",intent:"CAPTURE",status:"CREATED",purchase_units:[{reference_id:reference,custom_id:reference,amount:{currency_code:"CAD",value:"32.50"}}]},{status:201});}throw new Error("unexpected request");};
  const created=await createPayPalStorePayment(envFor(harness),post("/api/commerce/paypal/store",body),body,session,paypalFetch);
  const customer=await harness.commerceDb.prepare("SELECT linked_account_id FROM commerce_customers WHERE customer_kind='account'").first();assert.equal(customer.linked_account_id,"env-master-1");
  const inbox=await accountInboxMessages(envFor(harness),"env-master-1");assert.equal(inbox.total,1);assert.equal(inbox.items[0].sourceId,created.reference);assert.equal(inbox.items[0].sourceType,"order.created");
  assert.equal((await accountInboxMessages(envFor(harness),"other-account")).total,0);
});

test("PayPal webhook verifies the exact raw event and unresolved delivery enters bounded recovery", async(t)=>{
  const harness=await createCommerceDatabases();t.after(harness.dispose);const env=envFor(harness);const now=Date.now();
  const raw=`{\n "id":"WH-EVENT-001", "event_type":"PAYMENT.CAPTURE.COMPLETED", "create_time":"${new Date(now).toISOString()}", "resource":{"id":"CAPTURE-MISSING","amount":{"currency_code":"CAD","value":"15.00"},"supplementary_data":{"related_ids":{"order_id":"ORDER-MISSING"}}}\n}`;
  let verifyBody="";const paypalFetch=async(url,init={})=>{if(url.endsWith("/v1/oauth2/token"))return Response.json({access_token:"webhook-token",token_type:"Bearer",expires_in:3600});if(url.endsWith("/v1/notifications/verify-webhook-signature")){verifyBody=String(init.body);return Response.json({verification_status:"SUCCESS"});}throw new Error("unexpected request");};
  const request=new Request(`${API}/api/webhooks/paypal`,{method:"POST",headers:{"Content-Type":"application/json","PayPal-Transmission-Id":"transmission-001","PayPal-Transmission-Time":new Date(now).toISOString(),"PayPal-Transmission-Sig":"signature","PayPal-Cert-Url":"https://api-m.sandbox.paypal.com/certs/test.pem","PayPal-Auth-Algo":"SHA256withRSA"},body:raw});
  const response=await handlePayPalWebhook(request,env,paypalFetch,now);assert.equal(response.status,200);assert.equal((await response.json()).result,"payment_attempt_unresolved");
  assert.ok(verifyBody.includes(`"webhook_event":${raw}`));
  const event=await harness.commerceDb.prepare("SELECT verification_status,processing_status,amount_minor,currency_code,payload_sha256 FROM commerce_paypal_webhook_events").first();assert.equal(event.verification_status,"verified");assert.equal(event.processing_status,"unresolved");assert.equal(event.amount_minor,1500);assert.equal(event.currency_code,"CAD");assert.match(event.payload_sha256,/^[0-9a-f]{64}$/);
  const job=await harness.commerceDb.prepare("SELECT job_kind,state,environment FROM commerce_operation_jobs").first();assert.deepEqual(job,{job_kind:"paypal_webhook_recover",state:"pending",environment:"sandbox"});
  assert.deepEqual(PAYPAL_WEBHOOK_EVENTS,["CHECKOUT.ORDER.APPROVED","CHECKOUT.PAYMENT-APPROVAL.REVERSED","PAYMENT.CAPTURE.PENDING","PAYMENT.CAPTURE.COMPLETED","PAYMENT.CAPTURE.DECLINED","PAYMENT.CAPTURE.REFUNDED","PAYMENT.CAPTURE.REVERSED"]);
});

test("PayPal webhook rejects non-PayPal certificate hosts before provider access",async(t)=>{
  const harness=await createCommerceDatabases();t.after(harness.dispose);const now=Date.now();let calls=0;
  const request=new Request(`${API}/api/webhooks/paypal`,{method:"POST",headers:{"Content-Type":"application/json","PayPal-Transmission-Id":"transmission-evil","PayPal-Transmission-Time":new Date(now).toISOString(),"PayPal-Transmission-Sig":"signature","PayPal-Cert-Url":"https://evilpaypal.com/cert.pem","PayPal-Auth-Algo":"SHA256withRSA"},body:JSON.stringify({id:"WH-EVIL",event_type:"CHECKOUT.ORDER.APPROVED",create_time:new Date(now).toISOString(),resource:{id:"ORDER-EVIL"}})});
  await assert.rejects(()=>handlePayPalWebhook(request,envFor(harness),async()=>{calls+=1;}),/certificate URL is invalid/);assert.equal(calls,0);
});

test("verified refund after completion updates donation authority once without fulfillment",async(t)=>{
  const harness=await createCommerceDatabases();t.after(harness.dispose);await enableSandbox(harness.commerceDb);const timestamp="2026-08-30T00:00:00.000Z",donationId="don_55555555-5555-4555-8555-555555555555",attemptId="pat_66666666-6666-4666-8666-666666666666";
  await harness.commerceDb.batch([
    harness.commerceDb.prepare("INSERT INTO commerce_donations(id,request_id,request_digest,environment,currency_code,amount_minor,status,completed_at,created_at,updated_at) VALUES(?,'44444444-4444-4444-8444-444444444444',?,'sandbox','CAD',1500,'completed',?,?,?)").bind(donationId,"a".repeat(64),timestamp,timestamp,timestamp),
    harness.commerceDb.prepare("INSERT INTO commerce_payment_attempts(id,donation_id,provider,environment,provider_order_id,provider_capture_id,idempotency_key,currency_code,amount_minor,provider_status,normalized_state,create_request_digest,captured_at,created_at,updated_at) VALUES(?,?,'paypal','sandbox','ORDERREFUND','CAPTUREREFUND','paypal-refund-key-001','CAD',1500,'COMPLETED','completed',?, ?,?,?)").bind(attemptId,donationId,"b".repeat(64),timestamp,timestamp,timestamp),
  ]);
  const now=Date.now();const raw=JSON.stringify({id:"WH-REFUND-001",event_type:"PAYMENT.CAPTURE.REFUNDED",create_time:new Date(now).toISOString(),resource:{id:"CAPTUREREFUND",amount:{currency_code:"CAD",value:"15.00"},supplementary_data:{related_ids:{order_id:"ORDERREFUND"}}}});
  const makeRequest=()=>new Request(`${API}/api/webhooks/paypal`,{method:"POST",headers:{"Content-Type":"application/json","PayPal-Transmission-Id":"refund-transmission","PayPal-Transmission-Time":new Date(now).toISOString(),"PayPal-Transmission-Sig":"signature","PayPal-Cert-Url":"https://api-m.sandbox.paypal.com/cert.pem","PayPal-Auth-Algo":"SHA256withRSA"},body:raw});
  const verify=async(url)=>url.endsWith("/v1/oauth2/token")?Response.json({access_token:"refund-token",token_type:"Bearer",expires_in:3600}):Response.json({verification_status:"SUCCESS"});
  const first=await handlePayPalWebhook(makeRequest(),envFor(harness),verify,now);assert.equal((await first.json()).result,"payment_refunded");
  const duplicate=await handlePayPalWebhook(makeRequest(),envFor(harness),verify,now);assert.equal((await duplicate.json()).duplicate,true);
  assert.deepEqual(await harness.commerceDb.prepare("SELECT status,refunded_at FROM commerce_donations WHERE id=?").bind(donationId).first().then((row)=>({status:row.status,refunded:Boolean(row.refunded_at)})),{status:"refunded",refunded:true});
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_operation_jobs").first()).count,0);
});
