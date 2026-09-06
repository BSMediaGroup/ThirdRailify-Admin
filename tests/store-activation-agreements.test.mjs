import { fulfillmentShippingPayload } from "../functions/_shared/commerce-control-plane.js";
import { processCommerceJobs } from "../functions/_shared/commerce-operations.js";
import { onRequest as commerceRoute } from "../functions/api/admin/commerce/[[path]].js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createCommerceDatabases, commerceEnvironment, insertTestProduct, insertTestVariant, insertTestShippingQuote } from "./commerce-test-helpers.mjs";
import { updateBusinessProfile, revealPrivateBusinessProfile, browserSafeBusinessProjection } from "../functions/_shared/commerce-core.js";
import { commerceLaunchPlan, activateCommerceLaunch, reconcileActiveCommerceStore, pauseCommerceLaunch, STORE_ACTIVATION_SETTINGS } from "../functions/_shared/commerce-launch.js";
import { checkoutReadiness } from "../functions/_shared/checkout-readiness.js";
import { offerCheckoutAgreement, prepareAgreementAcceptance, acceptedAgreementAppendix } from "../functions/_shared/commerce-agreements.js";
import { productionReadinessPayload, businessInformationPayload, ensureCompletedOrderReceipt, customerDocumentByToken, renderOrderLifecycleEmail } from "../functions/_shared/commerce-control-plane.js";
import { paypalPublicConfiguration, createPayPalStorePayment } from "../functions/_shared/paypal-commerce.js";
import { PAYPAL_WEBHOOK_EVENTS } from "../functions/_shared/paypal-client.js";
import { normalizeCartItems, normalizeDeliveryRecipient, authoritativeCartLines, resolveShippingSelection, worldwideShippingMarkets } from "../functions/_shared/shipping-core.js";
import { validateCheckoutCustomer, prepareCheckoutCustomer } from "../functions/_shared/commerce-customers.js";
import { shippingManagerPayload, saveShippingWeights, mutateShippingRatebook } from "../functions/_shared/shipping-ratebook.js";
import { createShippingQuote } from "../functions/_shared/shipping-core.js";

const master={accountId:"synthetic-owner",account:{adminLevel:"master"}};
const PHONE="Téléphone ☎ owner extension 四";
const ADDRESS="Lieu privé — arrière bâtiment";
const request=()=>new Request("https://thirdrailify.com/api/commerce/agreement",{method:"POST",headers:{Origin:"https://thirdrailify.com"}});
const confirm=plan=>({confirmation:"SAVE, CONFIRM & ENABLE STORE",expectedRevision:plan.revision,expectedDigest:plan.digest,businessProfileRevision:plan.business.revision,ownerAttestation:true,transactionDisclosureAuthorization:true,productionEnvironment:"production"});

test("fulfillment readiness accepts dynamic shipping without weights and repairs production mode drift", async t => {
  const {env,db}=await fixture(t);
  const active=await activateCommerceLaunch(env,confirm(await commerceLaunchPlan(env)),master);
  await db.prepare("INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at) VALUES ('printful_api_configured','true','safe','fixture') ON CONFLICT(setting_key) DO UPDATE SET value_json='true'").run();
  const ready=await fulfillmentShippingPayload(env,master);
  assert.equal(ready.readiness.production.state,"ready",JSON.stringify(ready.gates)); assert.equal(ready.mapping.potentiallyFulfillableVariants,1);
  assert.equal(ready.draftPreview.eligible,true); assert.equal(ready.webhook.subscription,"not_verified");
  assert.equal((await shippingManagerPayload(env)).coverage.covered,0);
  await db.prepare("UPDATE commerce_settings SET value_json='\"disabled\"' WHERE setting_key='printful_order_mode'").run();
  await db.prepare("UPDATE commerce_provider_connections SET safe_metadata_json=json_set(safe_metadata_json,'$.order_mode','disabled') WHERE provider='printful'").run();
  assert.equal((await fulfillmentShippingPayload(env,master)).readiness.production.state,"blocked");
  const plan=await commerceLaunchPlan(env);
  const repaired=await reconcileActiveCommerceStore(env,{confirmation:"RECONCILE ACTIVE STORE",expectedRevision:plan.revision,expectedDigest:plan.digest},master);
  assert.equal(repaired.settings.printfulOrderMode,"draft_then_confirm");assert.equal(repaired.activatedAt,active.activatedAt);
  assert.equal((await fulfillmentShippingPayload(env,master)).readiness.production.state,"ready");
  const again=await reconcileActiveCommerceStore(env,{confirmation:"RECONCILE ACTIVE STORE",expectedRevision:repaired.revision,expectedDigest:repaired.digest},master);
  assert.equal(again.reconciliation.idempotent,true);
});

test("paid LIVE quote reaches mocked draft and confirm; replay never confirms twice", async t => {
  const {env,db,body}=await fixture(t);
  await activateCommerceLaunch(env,confirm(await commerceLaunchPlan(env)),master);
  const quote=await createShippingQuote(env,request(),{items:body.items,recipient:body.recipient},async()=>Response.json({code:200,result:[{id:"STANDARD",name:"Provider service",rate:"13.50",currency:"CAD"}]}));
  body.quoteId=quote.quote.id;body.shippingOptionId=quote.quote.options[0].id;
  const offer=await offerCheckoutAgreement(env,request(),body,null);
  await createPayPalStorePayment(env,request(),{...body,agreementId:offer.agreement.id,agreementToken:offer.acceptanceToken,agreementAccepted:true},null,async (url,init)=>{
    if(url.endsWith('/v1/oauth2/token'))return Response.json({access_token:'synthetic-token',token_type:'Bearer',expires_in:3600});
    const unit=JSON.parse(init.body).purchase_units[0];return Response.json({id:'FULFILLMENTFIXTURE1',intent:'CAPTURE',status:'CREATED',purchase_units:[unit]},{status:201});
  });
  const order=await db.prepare("SELECT id FROM commerce_orders WHERE checkout_request_id=?").bind(body.checkoutRequestId).first();
  await db.prepare("UPDATE commerce_orders SET payment_status='paid' WHERE id=?").bind(order.id).run();
  await db.prepare("UPDATE commerce_payment_attempts SET normalized_state='completed',provider_capture_id='FIXTURECAPTURE' WHERE commerce_order_id=?").bind(order.id).run();
  await db.prepare("INSERT INTO commerce_operation_jobs(id,job_kind,event_key,order_id,environment,payload_digest,state,next_attempt_at,created_at,updated_at) VALUES ('coj_12345678-1234-4234-8234-123456789abc','fulfillment_submit','fixture',?,'live',?,'pending','2000-01-01','2000-01-01','2000-01-01')").bind(order.id,'a'.repeat(64)).run();
  let draft=null,creates=0,confirms=0,pauseBeforeConfirm=true;
  const provider=async(url,init={})=>{
    assert.ok(url.startsWith('https://api.printful.com/orders'));
    if(init.method==='POST'&&url.endsWith('/confirm')){confirms++;draft.status='pending';return Response.json({code:200,result:draft});}
    if(init.method==='POST'){creates++;draft={...JSON.parse(init.body),id:990001,status:'draft',store_id:18668025};assert.equal(draft.shipping,'STANDARD');assert.deepEqual(draft.items,[{sync_variant_id:7001,quantity:1}]);return Response.json({code:200,result:draft});}
    if(draft && pauseBeforeConfirm) { pauseBeforeConfirm=false; await db.prepare("UPDATE commerce_settings SET value_json='true' WHERE setting_key='commerce_emergency_paused'").run(); }
    return draft?Response.json({code:200,result:draft}):Response.json({code:404},{status:404});
  };
  await db.prepare("UPDATE commerce_orders SET payment_status='pending' WHERE id=?").bind(order.id).run();
  const unpaid=await processCommerceJobs(env,provider);assert.equal(unpaid.results[0].state,'action_required');assert.equal(creates,0);
  await db.prepare("UPDATE commerce_orders SET payment_status='paid' WHERE id=?").bind(order.id).run();
  await db.prepare("UPDATE commerce_operation_jobs SET state='pending',next_attempt_at='2000-01-01' WHERE id='coj_12345678-1234-4234-8234-123456789abc'").run();
  const paused=await processCommerceJobs(env,provider);assert.equal(paused.results[0].state,'action_required');assert.equal(confirms,0);assert.equal(creates,1);
  await db.prepare("UPDATE commerce_settings SET value_json='false' WHERE setting_key='commerce_emergency_paused'").run();
  await db.prepare("UPDATE commerce_operation_jobs SET state='pending',next_attempt_at='2000-01-01' WHERE id='coj_12345678-1234-4234-8234-123456789abc'").run();
  const first=await processCommerceJobs(env,provider);assert.equal(first.results[0].state,'completed',JSON.stringify(first));assert.equal(creates,1);assert.equal(confirms,1);
  await db.prepare("UPDATE commerce_operation_jobs SET state='pending' WHERE id='coj_12345678-1234-4234-8234-123456789abc'").run();
  const repeated=await processCommerceJobs(env,provider);assert.ok(repeated.results.every(r=>r.state==='completed'),JSON.stringify(repeated));assert.equal(creates,1);assert.equal(confirms,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM commerce_email_deliveries').first()).n,0);
});

test("merchant shipping agrees across agreement, mocked PayPal, order, receipt and email; established orders never reprice",async t=>{
  const {env,db,body}=await fixture(t);
  env.PRINTFUL_API_TOKEN="synthetic-provider-token";
  const manager=await shippingManagerPayload(env),draft=manager.books.find(b=>b.status==="draft");
  await saveShippingWeights(env,"product-test-001",{assignments:[{variantId:null,revision:0,value:"1100",unit:"g",provenance:"Synthetic measured fixture"}]});
  await mutateShippingRatebook(env,{action:"publish",ratebookId:draft.id,revision:draft.revision,body:draft.body});
  const plan=await commerceLaunchPlan(env);assert.equal(plan.hardGates.find(g=>g.id==="shipping").ready,true);await activateCommerceLaunch(env,confirm(plan),master);
  const quote=await createShippingQuote(env,request(),{items:body.items,recipient:body.recipient},async()=>Response.json({code:200,result:[{id:"STANDARD",name:"Provider service",rate:"13.50",currency:"CAD"}]}));
  const checkout={...body,quoteId:quote.quote.id,shippingOptionId:quote.quote.options[0].id};
  const offer=await offerCheckoutAgreement(env,request(),checkout,null);assert.equal(offer.agreement.totals.shippingAmount,2300);assert.equal(offer.agreement.totals.totalAmount,8300);
  let creates=0;
  const mockedPayPal=async(url,init)=>{
    if(url.endsWith("/v1/oauth2/token"))return Response.json({access_token:"synthetic-token",token_type:"Bearer",expires_in:3600});
    assert.ok(url.endsWith("/v2/checkout/orders"));creates++;
    const payment=JSON.parse(init.body),unit=payment.purchase_units[0];assert.equal(unit.amount.value,"83.00");assert.equal(unit.amount.breakdown.shipping.value,"23.00");
    return Response.json({id:"MERCHANTPOLICY1",intent:"CAPTURE",status:"CREATED",purchase_units:[{reference_id:unit.reference_id,custom_id:unit.custom_id,amount:unit.amount}]},{status:201});
  };
  const accepted={...checkout,agreementId:offer.agreement.id,agreementToken:offer.acceptanceToken,agreementAccepted:true};
  await createPayPalStorePayment(env,request(),accepted,null,mockedPayPal);
  const order=await db.prepare("SELECT id,shipping_amount,customer_gross_amount FROM commerce_orders WHERE checkout_request_id=?").bind(body.checkoutRequestId).first();assert.equal(order.shipping_amount,2300);assert.equal(order.customer_gross_amount,8300);
  const stored=await db.prepare("SELECT * FROM commerce_order_shipping_policies WHERE order_id=?").bind(order.id).first();assert.equal(stored.provider_cost_amount,1350);assert.equal(JSON.parse(stored.snapshot_json).weight.totalMg,1100000);
  const delivery=await db.prepare("SELECT provider_shipping_method_id,display_shipping_method,shipping_amount FROM commerce_order_delivery_snapshots WHERE order_id=?").bind(order.id).first();assert.equal(delivery.provider_shipping_method_id,"STANDARD");assert.equal(delivery.display_shipping_method,"Standard Shipping (CA)");assert.equal(delivery.shipping_amount,2300);
  await saveShippingWeights(env,"product-test-001",{assignments:[{variantId:null,revision:1,value:"6601",unit:"g",provenance:"Synthetic later revision"}]});
  await createPayPalStorePayment(env,request(),accepted,null,mockedPayPal);assert.equal(creates,1);
  await db.prepare("UPDATE commerce_orders SET payment_status='paid' WHERE id=?").bind(order.id).run();
  const receipt=await ensureCompletedOrderReceipt(env,order.id),doc=await customerDocumentByToken(env,receipt.token);assert.equal(doc.document.total,8300);assert.equal(doc.document.shipping,2300);
  const mail=await renderOrderLifecycleEmail(env,order.id,"order_confirmation");assert.match(mail.rendered.text,/83\.00/);assert.match((await acceptedAgreementAppendix(env,order.id)).text,/Shipping \(Standard Shipping \(CA\)\): 23\.00 CAD/);
  assert.equal((await db.prepare("SELECT customer_gross_amount FROM commerce_orders WHERE id=?").bind(order.id).first()).customer_gross_amount,8300);
});

async function fixture(t) {
  const h=await createCommerceDatabases();t.after(h.dispose);const db=h.commerceDb;
  const env=commerceEnvironment(h,{PRINTFUL_STORE_ID:"18668025",PAYPAL_LIVE_CLIENT_ID:"synthetic-live-client",PAYPAL_LIVE_CLIENT_SECRET:"synthetic-live-secret",PAYPAL_LIVE_WEBHOOK_ID:"WH-SYNTHETIC",PRINTFUL_API_TOKEN:"synthetic-printful-token-never-called",RESEND_API_KEY:"synthetic-resend-never-called",MAIL_FROM:"Third Railify <alerts@example.test>"});
  await updateBusinessProfile(env,master,{revision:1,tradingName:"Synthetic Store",legalBusinessName:"Synthetic Legal Owner",supportEmail:"support@example.test",privatePhone:`  ${PHONE}  `,privateAddress:{line1:ADDRESS}});
  await insertTestProduct(db,{targetPrintfulProductId:"9001",migrationStatus:"target_verified",requiresShipping:1,unitAmount:6000});
  await insertTestVariant(db,{isSellable:1,targetPrintfulProductId:"9001",targetPrintfulSyncVariantId:"7001",targetCatalogueVariantId:"11576",migrationStatus:"target_verified",unitAmount:6000});
  const settings={commerce_environment:"production",preferred_payment_provider:"paypal",stripe_enabled:false,stripe_tax_enabled:false,paypal_live_configured:true,paypal_live_webhook_configured:true,paypal_donations_enabled:true,paypal_donation_live_capture_enabled:true,commerce_operations_worker_configured:true,resend_domain_verified:true,shipping_strategy:"printful_dynamic",tax_calculation_provider:"not_collecting",commerce_emergency_paused:false};
  await db.batch([
    ...Object.entries(settings).map(([k,v])=>db.prepare("INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at) VALUES (?,?,'safe','fixture') ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").bind(k,JSON.stringify(v))),
    db.prepare("UPDATE commerce_products SET provider_presence='current',provider_store_id='18668025',provider_reconciliation_status='current',safe_metadata_json=json_set(safe_metadata_json,'$.publicImage','https://example.test/fixture.png')"),db.prepare("UPDATE commerce_product_variants SET provider_presence='current',provider_store_id='18668025'"),
    db.prepare("UPDATE commerce_templates SET status='ready',enabled=CASE WHEN template_key IN ('order_confirmation','payment_receipt') THEN 1 ELSE 0 END"),
    db.prepare("UPDATE commerce_provider_connections SET status='connected',environment='live',integration_mode='direct_merchant',country_code='CA',currency_code='CAD',safe_metadata_json=? WHERE provider='paypal'").bind(JSON.stringify({live:{oauth_verified:true,webhook_readback_verified:true,webhook_configured:true,webhook_events:PAYPAL_WEBHOOK_EVENTS}})),
    db.prepare("UPDATE commerce_provider_connections SET status='connected',integration_mode='fulfillment',external_account_id='18668025',safe_metadata_json='{"+'"api_configured":true'+"}' WHERE provider='printful'"),
    db.prepare("INSERT INTO commerce_catalogue_migrations(id,status,phase,safe_state_json,updated_at) VALUES ('permanent-printful-2026-08','completed','completed','{}','fixture') ON CONFLICT(id) DO UPDATE SET status='completed',phase='completed',step_lease_token=NULL,safe_state_json='{}'"),
  ]);
  await db.batch(worldwideShippingMarkets().map(m=>db.prepare("INSERT OR IGNORE INTO commerce_shipping_markets(country_code,display_name,status,strategy,created_at,updated_at) VALUES (?, ?, 'active', 'printful_dynamic', 'fixture', 'fixture')").bind(m.countryCode,m.displayName)));
  const shipping=await insertTestShippingQuote(db);
  const body={checkoutRequestId:"33333333-3333-4333-8333-333333333333",items:[{productId:"product-test-001",variantId:"variant-test-001",quantity:1}],recipient:shipping.recipient,quoteId:shipping.quoteId,shippingOptionId:shipping.shippingOptionId,customer:{mode:"guest",name:"Synthetic Customer",email:"customer@example.test"}};
  return {h,db,env,body};
}

test("publication exclusions do not disable safe checkout after activation", async t => {
  const { env, db, body } = await fixture(t);
  await activateCommerceLaunch(env, confirm(await commerceLaunchPlan(env)), master);
  await insertTestProduct(db, { id: "hidden-product", slug: "hidden-product", visibility: "private", checkoutEnvironment: "live" });
  await insertTestVariant(db, { id: "hidden-variant", productId: "hidden-product", isSellable: 1 });
  const plan = await commerceLaunchPlan(env);
  assert.equal(plan.hardGates.find(g => g.id === "catalogue").ready, false);
  assert.equal(plan.operationalReady, true);
  assert.equal((await paypalPublicConfiguration(env)).storeCheckoutEnabled, true);
  assert.equal((await authoritativeCartLines(db, body.items, { gate: "normal", environment: "live" })).length, 1);
  await assert.rejects(authoritativeCartLines(db, [{ productId: "hidden-product", variantId: "hidden-variant", quantity: 1 }], { gate: "normal", environment: "live" }));
  await db.prepare("UPDATE commerce_products SET visibility='private'").run();
  assert.equal((await commerceLaunchPlan(env)).operationalReady, false);
});

test("active reconciliation restores a drifted setting atomically and preserves original activation evidence", async t => {
  const { env, db } = await fixture(t);
  const active = await activateCommerceLaunch(env, confirm(await commerceLaunchPlan(env)), master);
  const original = await db.prepare("SELECT * FROM commerce_launch_state").first();
  const revision = (await checkoutReadiness(env)).revision;
  await db.prepare("UPDATE commerce_settings SET value_json='false' WHERE setting_key='checkout_enabled'").run();
  const drift = await commerceLaunchPlan(env);
  assert.equal(drift.operationalState, "degraded");
  assert.equal((await checkoutReadiness(env)).checkoutEnabled, false);
  const repaired = await reconcileActiveCommerceStore(env, { confirmation: "RECONCILE ACTIVE STORE", expectedRevision: drift.revision, expectedDigest: drift.digest }, master);
  assert.deepEqual(repaired.reconciliation.changedSettings, ["checkout_enabled"]);
  assert.equal(repaired.activatedAt, active.activatedAt);
  assert.deepEqual(await db.prepare("SELECT * FROM commerce_launch_state").first(), original);
  assert.equal((await checkoutReadiness(env)).checkoutEnabled, true);
  assert.notEqual((await checkoutReadiness(env)).revision, revision);
  const repeat = await reconcileActiveCommerceStore(env, { confirmation: "RECONCILE ACTIVE STORE", expectedRevision: repaired.revision, expectedDigest: repaired.digest }, master);
  assert.equal(repeat.reconciliation.idempotent, true);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM commerce_audit WHERE action='commerce.active_store_reconciled'").first()).n, 1);
  await pauseCommerceLaunch(env, { confirmation: "PAUSE LIVE COMMERCE", expectedRevision: repaired.revision }, master.accountId);
  const paused = await commerceLaunchPlan(env);
  await assert.rejects(reconcileActiveCommerceStore(env, { confirmation: "RECONCILE ACTIVE STORE", expectedRevision: paused.revision, expectedDigest: paused.digest }, master), e => e.code === "commerce_reconcile_blocked");
});

test("safe unconventional private values persist, decrypt, reload and reject malformed replacements",async t=>{
  const {env,db}=await fixture(t);
  const values=await revealPrivateBusinessProfile(env);assert.equal(values.privatePhone,PHONE);assert.equal(values.privateAddress.line1,ADDRESS);assert.equal(values.privateAddress.postalCode,"");
  const row=await db.prepare("SELECT private_phone_ciphertext,private_address_ciphertext FROM commerce_business_profiles").first();assert.ok(!JSON.stringify(row).includes(PHONE));assert.ok(!JSON.stringify(row).includes(ADDRESS));
  const payload=await businessInformationPayload(env,master);assert.equal(payload.profile.private.privatePhoneStored,true);assert.equal(payload.readiness.profile.address,"complete");assert.equal(payload.readiness.profile.tax,"complete");
  assert.ok(!JSON.stringify(payload).includes(ADDRESS));
  await assert.rejects(updateBusinessProfile(env,master,{revision:1,privatePhone:"Changed"}),e=>e.code==="business_profile_revision_conflict");
  for(const value of ["\u0000bad",{},123])await assert.rejects(updateBusinessProfile(env,master,{revision:2,privatePhone:value}),e=>e.code==="private_phone_invalid");
  await assert.rejects(updateBusinessProfile(env,master,{revision:2,privatePhone:""}),e=>e.code==="private_phone_required");
  await assert.rejects(updateBusinessProfile(env,master,{revision:2,privateAddress:"invalid"}),e=>e.code==="private_address_invalid");
  await assert.rejects(updateBusinessProfile(env,master,{revision:2,privateAddress:{line1:{bad:true}}}),e=>e.code==="private_address_invalid");
  await assert.rejects(updateBusinessProfile(env,master,{revision:2,private:{privatePhoneStored:true}}),e=>e.code==="business_profile_fields_invalid");
  const audit=await db.prepare("SELECT metadata_json FROM commerce_audit").all();assert.ok(!JSON.stringify(audit).includes(PHONE));assert.ok(!JSON.stringify(audit).includes(ADDRESS));
});

test("canonical readiness excludes Stripe, invoices, shipment and signed-webhook evidence; activation is coherent and idempotent",async t=>{
  const {env,db}=await fixture(t);const plan=await commerceLaunchPlan(env);
  assert.deepEqual(plan.hardGates.filter(g=>!g.ready),[]);
  assert.equal((await productionReadinessPayload(env,master)).productionReady,true);
  const input=confirm(plan);const active=await activateCommerceLaunch(env,input,master).catch(error=>{throw error.cause || error;});
  assert.equal(active.state,"active");assert.equal(active.business.ownerConfirmed,true);assert.equal(active.business.disclosureAuthorized,true);
  for(const [key,value]of Object.entries(STORE_ACTIVATION_SETTINGS))assert.equal(JSON.parse((await db.prepare("SELECT value_json FROM commerce_settings WHERE setting_key=?").bind(key).first()).value_json),value);
  assert.equal((await paypalPublicConfiguration(env)).storeCheckoutEnabled,true);
  assert.equal((await activateCommerceLaunch(env,input,master)).activationResult.idempotent,true);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM commerce_audit WHERE action='commerce.production_activated'").first()).n,1);
  const audit = JSON.parse((await db.prepare("SELECT metadata_json FROM commerce_audit WHERE action='commerce.production_activated'").first()).metadata_json);
  assert.deepEqual(audit.attestation.categories,["legal_identity","business_phone","business_premises_address","tax_policy"]);
  assert.equal(audit.attestation.accountId,master.accountId);
  assert.equal(audit.attestation.profileRevision,active.business.revision);
  assert.equal(audit.attestation.transactionDisclosureAuthorized,true);
  assert.equal(audit.attestation.evidenceStatus,"OPERATOR ATTESTED");
  assert.equal(audit.attestation.legalPolicyRevision,plan.attestationPolicy.legalRevision);
  assert.equal(audit.attestation.taxPolicyRevision,plan.attestationPolicy.taxRevision);
  assert.equal(audit.attestation.disclosurePolicyRevision,plan.attestationPolicy.disclosureRevision);
  assert.ok(!JSON.stringify(audit).includes(PHONE));assert.ok(!JSON.stringify(audit).includes(ADDRESS));
  assert.equal(active.hardGates.find(g=>g.id==="merchant_identity").evidenceStatus,"OPERATOR ATTESTED");
  assert.equal(active.hardGates.find(g=>g.id==="paypal_live_webhook").evidenceStatus,"PROVIDER VERIFIED");
  assert.deepEqual(plan.activationSettings,STORE_ACTIVATION_SETTINGS);
  const paused=await pauseCommerceLaunch(env,{confirmation:"PAUSE LIVE COMMERCE",expectedRevision:active.revision},master.accountId);
  assert.equal(paused.settings.checkoutEnabled,false);assert.equal(paused.settings.liveCaptureEnabled,false);assert.equal(paused.settings.fulfillmentEnabled,false);
  assert.equal((await paypalPublicConfiguration(env)).donationsEnabled,true);
});

test("activation requires both attestations and current readiness and profile revisions",async t=>{
  const {env,db}=await fixture(t);const plan=await commerceLaunchPlan(env);
  for(const field of ["ownerAttestation","transactionDisclosureAuthorization"])await assert.rejects(activateCommerceLaunch(env,{...confirm(plan),[field]:false},master),e=>e.code==="commerce_launch_confirmation_required");
  await assert.rejects(activateCommerceLaunch(env,{...confirm(plan),businessProfileRevision:999},master),e=>e.code==="commerce_business_revision_conflict");
  await db.prepare("UPDATE commerce_settings SET value_json='false' WHERE setting_key='resend_domain_verified'").run();
  await assert.rejects(activateCommerceLaunch(env,confirm(plan),master),e=>e.code==="commerce_launch_revision_conflict");
  assert.equal((await commerceLaunchPlan(env)).settings.checkoutEnabled,false);
  const config=await paypalPublicConfiguration(env);assert.equal(config.storeReadiness.ready,false);assert.equal(config.storeReadiness.hardBlockerCount,1);assert.equal(config.donationsEnabled,true);
});

test("failed activation write rolls back settings, owner attestation, profile edits and audit",async t=>{
  const {env,db}=await fixture(t);const plan=await commerceLaunchPlan(env);const initial=await db.prepare("SELECT revision,owner_attested_revision FROM commerce_business_profiles").first();
  const failing={...env,THIRDRAILIFY_COMMERCE_DB:{prepare:sql=>db.prepare(sql),batch:statements=>db.batch([...statements,db.prepare("INSERT INTO commerce_settings (setting_key,value_json) VALUES (NULL, NULL)")])}};
  await assert.rejects(activateCommerceLaunch(failing,{...confirm(plan),profile:{revision:plan.business.revision,privatePhone:"Changed synthetic phone"}},master),e=>e.code==="commerce_activation_write_failed");
  assert.deepEqual(await db.prepare("SELECT revision,owner_attested_revision FROM commerce_business_profiles").first(),initial);
  assert.equal((await commerceLaunchPlan(env)).settings.checkoutEnabled,false);
  assert.equal((await revealPrivateBusinessProfile(env)).privatePhone,PHONE);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM commerce_audit WHERE action='commerce.production_activated'").first()).n,0);
});

test("a concurrent gate change inside activation is caught before any activation writes",async t=>{
  const {env,db}=await fixture(t);const plan=await commerceLaunchPlan(env);
  const racing={...env,THIRDRAILIFY_COMMERCE_DB:{prepare:sql=>db.prepare(sql),batch:async statements=>{await db.prepare("UPDATE commerce_settings SET value_json='false' WHERE setting_key='resend_domain_verified'").run();return db.batch(statements);}}};
  await assert.rejects(activateCommerceLaunch(racing,confirm(plan),master),e=>e.code==="commerce_launch_revision_conflict");
  assert.equal((await commerceLaunchPlan(env)).settings.checkoutEnabled,false);
  assert.equal((await revealPrivateBusinessProfile(env)).revision,plan.business.revision);
});

test("save and activate accepts the latest edits in one transaction and subsequent saves invalidate revision-bound authority",async t=>{
  const {env}=await fixture(t);const plan=await commerceLaunchPlan(env);
  const active=await activateCommerceLaunch(env,{...confirm(plan),profile:{revision:plan.business.revision,privatePhone:"Phone nouvelle 二"}},master);
  assert.equal(active.business.revision,plan.business.revision+1);assert.equal(active.business.ownerConfirmed,true);assert.equal((await revealPrivateBusinessProfile(env)).privatePhone,"Phone nouvelle 二");
  const retry=await activateCommerceLaunch(env,{...confirm(plan),profile:{revision:plan.business.revision,privatePhone:(await revealPrivateBusinessProfile(env)).privatePhone}},master);assert.equal(retry.activationResult.idempotent,true);assert.equal(retry.business.revision,active.business.revision);
  await updateBusinessProfile(env,master,{revision:active.business.revision,privateAddress:{line1:"A different safe place"}});
  const after=await commerceLaunchPlan(env);assert.equal(after.business.ownerConfirmed,false);assert.equal(after.settings.checkoutEnabled,false);assert.equal((await paypalPublicConfiguration(env)).donationsEnabled,true);
});

test("scoped review and acceptance precede PayPal; retained agreement and encrypted receipt are immutable",async t=>{
  const {env,db,body}=await fixture(t);
  await assert.rejects(offerCheckoutAgreement(env,request(),body,null),e=>e.code==="agreement_disclosure_unavailable");
  const plan=await commerceLaunchPlan(env);await activateCommerceLaunch(env,confirm(plan),master);
  await db.prepare("UPDATE commerce_shipping_quotes SET environment='live'").run();
  await assert.rejects(offerCheckoutAgreement(env,request(),{...body,quoteId:"shq_00000000-0000-4000-8000-000000000000"},null));
  const offer=await offerCheckoutAgreement(env,request(),body,null);
  assert.equal(offer.agreement.merchant.phone,undefined);assert.equal(offer.agreement.merchant.address,undefined);assert.ok(!JSON.stringify(offer).includes(PHONE));assert.ok(!JSON.stringify(offer).includes(ADDRESS));assert.equal(offer.agreement.totals.taxAmount,0);assert.equal(offer.agreement.tax.policy,"not_collecting");
  assert.equal(offer.agreement.policies.returns.version,"2026.09-store-agreement-2");
  let providerCalls=0;
  await assert.rejects(createPayPalStorePayment(env,request(),body,null,async()=>{providerCalls++;throw new Error("No provider calls permitted");}),e=>e.code==="agreement_acceptance_required");assert.equal(providerCalls,0);
  const checkout={...body,items:normalizeCartItems(body.items),recipient:normalizeDeliveryRecipient(body.recipient),customer:validateCheckoutCustomer(body.customer,null),agreementId:offer.agreement.id,agreementToken:offer.acceptanceToken,agreementAccepted:true};
  const lines=await authoritativeCartLines(db,body.items,{gate:"normal",environment:"live"});const shipping=await resolveShippingSelection(db,{lines,recipient:body.recipient,quoteId:body.quoteId,optionId:body.shippingOptionId,environment:"live"});
  await assert.rejects(prepareAgreementAcceptance(env,{...checkout,agreementToken:"A".repeat(43)},"ord_synthetic",null,lines,shipping),e=>e.code==="agreement_token_invalid");
  const customer=await prepareCheckoutCustomer(env,db,checkout.customer);const acceptance=await prepareAgreementAcceptance(env,checkout,"ord_synthetic",customer.id,lines,shipping);
  await db.batch([acceptance.guard,customer.statement,db.prepare("INSERT INTO commerce_orders(id,customer_payment_provider,payment_status,fulfillment_provider,fulfillment_status,currency_code,customer_gross_amount,environment,created_at,updated_at) VALUES ('ord_synthetic','paypal','paid','printful','pending','CAD',6500,'live','fixture','fixture')"),acceptance.statement]);
  const appendix=await acceptedAgreementAppendix(env,"ord_synthetic");assert.ok(appendix.text.includes(PHONE));assert.ok(appendix.text.includes(ADDRESS));assert.ok(appendix.text.includes("Synthetic Customer"));assert.match(appendix.text,/NOT COLLECTING|not being collected/i);
  await assert.rejects(db.prepare("UPDATE commerce_order_agreements SET snapshot_ciphertext='tampered' WHERE status='accepted'").run(),/immutable/);
  await assert.rejects(db.prepare("DELETE FROM commerce_order_agreements WHERE status='accepted'").run(),/immutable/);
  const receipt=await ensureCompletedOrderReceipt(env,"ord_synthetic");assert.deepEqual(await ensureCompletedOrderReceipt(env,"ord_synthetic"),receipt);
  const doc=await customerDocumentByToken(env,receipt.token);assert.ok(doc.document.text.includes(ADDRESS));assert.equal(doc.document.tax,0);
  const stored=await db.prepare("SELECT snapshot_json,snapshot_ciphertext FROM commerce_order_documents").first();assert.equal(stored.snapshot_json,"{}");assert.ok(!stored.snapshot_ciphertext.includes(ADDRESS));
  const mail=await renderOrderLifecycleEmail(env,"ord_synthetic","order_confirmation");assert.ok(mail.rendered.text.includes(ADDRESS));assert.match(mail.rendered.text,/https:\/\/thirdrailify.com\/receipt#/);
  await updateBusinessProfile(env,master,{revision:plan.business.revision,privateAddress:{line1:"New synthetic address"}});
  assert.ok((await acceptedAgreementAppendix(env,"ord_synthetic")).text.includes(ADDRESS));
  assert.equal(providerCalls,0);
});

test("general browser projections and PayPal configuration never expose encrypted private records",async t=>{
  const {env,db}=await fixture(t);const row=await db.prepare("SELECT * FROM commerce_business_profiles").first();
  const publicSurfaces=[browserSafeBusinessProjection(row),await paypalPublicConfiguration(env),await commerceLaunchPlan(env)];
  for(const value of publicSurfaces){const json=JSON.stringify(value);assert.ok(!json.includes(PHONE));assert.ok(!json.includes(ADDRESS));assert.ok(!json.includes("ciphertext"));assert.ok(!json.includes("authorityFingerprint"));}
});

test("permanent activation route requires a real local Master session, CSRF and exact production origin",async t=>{
 const {env,db}=await fixture(t);const production="https://admin.thirdrailify.com";
 const e={...env,THIRDRAILIFY_ADMIN_ORIGIN:production,THIRDRAILIFY_PUBLIC_ORIGIN:"https://thirdrailify.com"};
 await ensureEnvironmentMasters(e);const account=await loadAccountByEmail(e,e.ADMIN_EMAIL_1);assert.ok(account);
 const made=await createSession(e,new Request(production+"/",{headers:{Origin:production}}),account,production);const cookie=cookiePair(made.cookie);
 const body=confirm(await commerceLaunchPlan(e));
 const send=(url,origin,csrfToken,sessionCookie=cookie,scope=e)=>commerceRoute({env:scope,request:jsonRequest(url,{origin,cookie:sessionCookie,csrfToken,body}),data:{}});
 const url=production+"/api/admin/commerce/launch/activate";
 assert.equal((await send(url,production,made.csrfToken,"")).status,401);
 assert.equal((await send(url,production,undefined)).status,403);
 assert.equal((await send(url,"https://wrong.example.test",made.csrfToken)).status,403);
 const preview="https://thirdrailify-admin.pages.dev", pe={...e,THIRDRAILIFY_ADMIN_ORIGIN:preview};
 const pm=await createSession(pe,new Request(preview+"/",{headers:{Origin:preview}}),account,preview);
 const wrongEnvironment=await send(preview+"/api/admin/commerce/launch/activate",preview,pm.csrfToken,cookiePair(pm.cookie),pe);assert.equal(wrongEnvironment.status,403);assert.equal((await wrongEnvironment.json()).error,"production_origin_required");
 assert.equal((await db.prepare("SELECT state FROM commerce_launch_state").first()).state,"preflight");
});

test("unchanged operations heartbeat does not stale an otherwise current launch review",async t=>{
 const {env,db}=await fixture(t);const plan=await commerceLaunchPlan(env);
 await db.prepare("UPDATE commerce_settings SET updated_at='2099-09-06T00:00:00Z' WHERE setting_key='commerce_operations_worker_configured'").run();
 assert.equal((await commerceLaunchPlan(env)).digest,plan.digest);
 const active=await activateCommerceLaunch(env,confirm(plan),master);assert.equal(active.state,"active");
});
