import { onRequest as commerceRoute } from "../functions/api/admin/commerce/[[path]].js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createCommerceDatabases, commerceEnvironment, insertTestProduct, insertTestVariant, insertTestShippingQuote } from "./commerce-test-helpers.mjs";
import { updateBusinessProfile, revealPrivateBusinessProfile, browserSafeBusinessProjection } from "../functions/_shared/commerce-core.js";
import { commerceLaunchPlan, activateCommerceLaunch, pauseCommerceLaunch, STORE_ACTIVATION_SETTINGS } from "../functions/_shared/commerce-launch.js";
import { offerCheckoutAgreement, prepareAgreementAcceptance, acceptedAgreementAppendix } from "../functions/_shared/commerce-agreements.js";
import { productionReadinessPayload, businessInformationPayload, ensureCompletedOrderReceipt, customerDocumentByToken, renderOrderLifecycleEmail } from "../functions/_shared/commerce-control-plane.js";
import { paypalPublicConfiguration, createPayPalStorePayment } from "../functions/_shared/paypal-commerce.js";
import { PAYPAL_WEBHOOK_EVENTS } from "../functions/_shared/paypal-client.js";
import { normalizeCartItems, normalizeDeliveryRecipient, authoritativeCartLines, resolveShippingSelection, worldwideShippingMarkets } from "../functions/_shared/shipping-core.js";
import { validateCheckoutCustomer, prepareCheckoutCustomer } from "../functions/_shared/commerce-customers.js";

const master={accountId:"synthetic-owner",account:{adminLevel:"master"}};
const PHONE="Téléphone ☎ owner extension 四";
const ADDRESS="Lieu privé — arrière bâtiment";
const request=()=>new Request("https://thirdrailify.com/api/commerce/agreement",{method:"POST",headers:{Origin:"https://thirdrailify.com"}});
const confirm=plan=>({confirmation:"SAVE, CONFIRM & ENABLE STORE",expectedRevision:plan.revision,expectedDigest:plan.digest,businessProfileRevision:plan.business.revision,ownerAttestation:true,transactionDisclosureAuthorization:true,productionEnvironment:"production"});

async function fixture(t) {
  const h=await createCommerceDatabases();t.after(h.dispose);const db=h.commerceDb;
  const env=commerceEnvironment(h,{PAYPAL_LIVE_CLIENT_ID:"synthetic-live-client",PAYPAL_LIVE_CLIENT_SECRET:"synthetic-live-secret",PAYPAL_LIVE_WEBHOOK_ID:"WH-SYNTHETIC",PRINTFUL_API_TOKEN:"synthetic-printful-token-never-called",RESEND_API_KEY:"synthetic-resend-never-called",MAIL_FROM:"Third Railify <alerts@example.test>"});
  await updateBusinessProfile(env,master,{revision:1,tradingName:"Synthetic Store",legalBusinessName:"Synthetic Legal Owner",supportEmail:"support@example.test",privatePhone:`  ${PHONE}  `,privateAddress:{line1:ADDRESS}});
  await insertTestProduct(db,{targetPrintfulProductId:"9001",migrationStatus:"target_verified",requiresShipping:1,unitAmount:6000});
  await insertTestVariant(db,{isSellable:1,targetPrintfulProductId:"9001",targetPrintfulSyncVariantId:"7001",targetCatalogueVariantId:"11576",migrationStatus:"target_verified",unitAmount:6000});
  const settings={commerce_environment:"production",preferred_payment_provider:"paypal",stripe_enabled:false,stripe_tax_enabled:false,paypal_live_configured:true,paypal_live_webhook_configured:true,paypal_donations_enabled:true,paypal_donation_live_capture_enabled:true,commerce_operations_worker_configured:true,resend_domain_verified:true,shipping_strategy:"printful_dynamic",tax_calculation_provider:"not_collecting",commerce_emergency_paused:false};
  await db.batch([
    ...Object.entries(settings).map(([k,v])=>db.prepare("INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at) VALUES (?,?,'safe','fixture') ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").bind(k,JSON.stringify(v))),
    db.prepare("UPDATE commerce_products SET provider_presence='current'"),db.prepare("UPDATE commerce_product_variants SET provider_presence='current'"),
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
  assert.equal(offer.agreement.merchant.phone,PHONE);assert.equal(offer.agreement.merchant.address.line1,ADDRESS);assert.equal(offer.agreement.totals.taxAmount,0);assert.equal(offer.agreement.tax.policy,"not_collecting");
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
