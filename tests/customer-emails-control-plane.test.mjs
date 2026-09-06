import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { customerEmailsControlPlanePayload, renderCommerceTemplate, templatePreviewPayload, recordedEmailVerification } from "../functions/_shared/commerce-control-plane.js";
import { processCommerceJobs } from "../functions/_shared/commerce-operations.js";
import { encryptCommerceSecret, updateTemplate } from "../functions/_shared/commerce-core.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const master = { accountId: "email-master", account: { adminLevel: "master" } };

test("Customer Emails projects server sender state, actual template kinds, canonical readiness, and masked bounded delivery evidence", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { RESEND_API_KEY: "resend-server-secret", MAIL_FROM: "Third Railify Official <receipts@notify.example.test>", MAIL_REPLY_TO: "support@example.test" });
  await harness.commerceDb.prepare("UPDATE commerce_templates SET status='ready',enabled=1 WHERE template_key='order_confirmation'").run();
  await harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='true' WHERE setting_key='resend_domain_verified'").run();
  await harness.commerceDb.prepare("INSERT INTO commerce_orders (id,payment_status,fulfillment_status,currency_code,customer_gross_amount,environment,checkout_status,created_at,updated_at) VALUES ('ord-email-live','paid','disabled','CAD',2500,'live','checkout_created','2026-08-29T01:00:00Z','2026-08-29T01:00:00Z')").run();
  await harness.commerceDb.batch([
    harness.commerceDb.prepare(`INSERT INTO commerce_email_deliveries (id,delivery_key,template_key,template_revision,order_id,event_key,recipient_email,purpose,status,provider_message_id,attempt_count,created_at,updated_at,sent_at)
      VALUES ('delivery-live',?,'order_confirmation',1,'ord-email-live','payment_confirmed','private.customer@example.test','transactional','sent','provider-safe-reference',1,'2026-08-29T02:00:00Z','2026-08-29T02:00:01Z','2026-08-29T02:00:01Z')`).bind("a".repeat(64)),
    harness.commerceDb.prepare(`INSERT INTO commerce_email_deliveries (id,delivery_key,template_key,template_revision,order_id,event_key,recipient_email,purpose,status,safe_metadata_json,attempt_count,created_at,updated_at)
      VALUES ('delivery-test',?,'receipt_notification',1,NULL,'test-preview','admin.private@example.test','test_preview','failed','{"error":"raw provider detail must not project"}',1,'2026-08-29T03:00:00Z','2026-08-29T03:00:01Z')`).bind("b".repeat(64)),
  ]);

  const payload = await customerEmailsControlPlanePayload(env, master);
  assert.deepEqual(payload.templates.map((item) => item.templateKey).sort(), ["cancellation", "invoice_notification", "order_confirmation", "payment_failure", "receipt_notification", "refund", "shipment_notification"]);
  assert.equal(payload.provider.name, "Resend"); assert.equal(payload.provider.configured, true); assert.equal(payload.provider.externalVerification, "unverified");
  assert.equal(payload.sender.fromAddress, "receipts@notify.example.test"); assert.equal(payload.sender.sendingDomain, "notify.example.test"); assert.equal(payload.sender.replyToAddress, "support@example.test"); assert.equal(payload.sender.externallyVerified, false);
  assert.equal(payload.readiness.configurationReady, false); assert.equal(payload.readiness.state, "incomplete"); assert.equal(payload.readiness.minimumReadyTemplates, 1); assert.deepEqual(payload.readiness.requiredTemplateKeys, ["order_confirmation"]); assert.equal(payload.readiness.customerSendsEnabled, false); assert.equal(payload.readiness.productionLifecycleImplemented, true);
  assert.equal(payload.dependencies.documents.receipt.configured, true); assert.equal(payload.dependencies.documents.invoice.configured, false); assert.equal(payload.dependencies.paypalRequired, false);
  assert.deepEqual(payload.deliveries.counts, { total: 2, test: 1, live: 1, unknown: 0, sent: 1, failed: 1, pending: 0, sending: 0 });
  assert.equal(payload.deliveries.recent[0].maskedRecipient, "a***@example.test"); assert.equal(payload.deliveries.recent[1].maskedRecipient, "p***@example.test");
  assert.equal(payload.deliveries.lastFailed.failure, "Provider delivery failed; no raw provider response is exposed.");
  assert.equal(payload.deliveries.lastSuccessful.providerMessageReference, "provider-safe-reference");
  await ensureEnvironmentMasters(env);
  const policyMaster = await harness.authDb.prepare("SELECT id FROM accounts WHERE source='env_master' ORDER BY created_at LIMIT 1").first();
  const now = new Date().toISOString();
  await harness.authDb.prepare("INSERT INTO admin_role_capability_denials (role,capability,denied_by_account_id,created_at,updated_at) VALUES ('full','commerce.templates.manage',?,?,?)").bind(policyMaster.id, now, now).run();
  const viewOnly = await customerEmailsControlPlanePayload(env, { accountId: "view-only", account: { adminLevel: "full" } });
  assert.equal(viewOnly.access.capabilities.includes("commerce.templates.manage"), false); assert.equal(viewOnly.deliveries.lastSuccessful.providerMessageReference, null);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /resend-server-secret|private\.customer|admin\.private|raw provider detail|safe_metadata_json|access_token_hash/i);
});

test("Customer Emails read and synthetic preview are non-mutating and never call providers", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { RESEND_API_KEY: "configured-but-unused", MAIL_FROM: "Sender <sender@example.test>" });
  const before = await authorityCounts(harness.commerceDb); let providerCalls = 0;
  const session = await authenticatedMaster(env); const url = `${ADMIN_ORIGIN}/api/admin/commerce/emails`;
  const response = await commerceRequest({ request: jsonRequest(url, { method: "GET", origin: ADMIN_ORIGIN, cookie: session.cookie }), env, data: { commerceFetch: async () => { providerCalls += 1; throw new Error("provider call forbidden"); } } });
  assert.equal(response.headers.get("Cache-Control"), "no-store"); assert.equal(response.status, 200); assert.equal((await response.json()).safety.providerCallsOnRead, false);
  const template = serializeTemplate(await harness.commerceDb.prepare("SELECT * FROM commerce_templates WHERE template_key='order_confirmation'").first());
  const preview = await templatePreviewPayload(env, master, "order_confirmation", { template });
  const after = await authorityCounts(harness.commerceDb);
  assert.equal(preview.source, "synthetic_fixture"); assert.equal(preview.test, true); assert.equal(preview.variables.customer_name, "Preview customer"); assert.match(preview.preview.html, /Order received/i);
  assert.deepEqual(after, before); assert.equal(providerCalls, 0);
  const unavailable = await customerEmailsControlPlanePayload({ ...env, THIRDRAILIFY_COMMERCE_DB: undefined }, master);
  assert.equal(unavailable.databaseConfigured, false); assert.deepEqual(unavailable.templates, []); assert.equal(unavailable.readiness.totalTemplates, 0);

  const unauthenticated = await commerceRequest({ request: jsonRequest(url, { method: "GET", origin: ADMIN_ORIGIN }), env, data: {} }); assert.equal(unauthenticated.status, 401);
  const wrongOrigin = await commerceRequest({ request: jsonRequest(url, { method: "GET", origin: "https://evil.example", cookie: session.cookie }), env, data: {} }); assert.equal(wrongOrigin.status, 403);
});

test("all seven lifecycle templates use the canonical branded HTML shell and semantic plaintext fallback", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { THIRDRAILIFY_ADMIN_ORIGIN: ADMIN_ORIGIN });
  const payload = await customerEmailsControlPlanePayload(env, master); const before = await authorityCounts(harness.commerceDb);
  for (const template of payload.templates) {
    const preview = await templatePreviewPayload(env, master, template.templateKey, {});
    assert.match(preview.preview.html, /^<!doctype html>/i, template.templateKey);
    assert.match(preview.preview.html, /class="tr-card"/, template.templateKey);
    assert.match(preview.preview.html, /THIRD RAILIFY OFFICIAL/, template.templateKey);
    assert.match(preview.preview.html, /https:\/\/thirdrailify-admin\.pages\.dev\/email-assets\/trzapcolorcon\.svg/, template.templateKey);
    assert.match(preview.preview.html, /Third Railify lightning logo/, template.templateKey);
    assert.match(preview.preview.html, /American Captain/, template.templateKey);
    assert.match(preview.preview.html, /Blinker/, template.templateKey);
    assert.match(preview.preview.html, /Geist Mono/, template.templateKey);
    assert.match(preview.preview.html, /#f3f0e5/i, template.templateKey);
    assert.ok(preview.preview.text.length > 0, template.templateKey);
    assert.doesNotMatch(preview.preview.text, /<\/?[a-z][^>]*>/i, template.templateKey);
  }
  const unsafe = renderCommerceTemplate({ ...payload.templates[0], introduction: "Hello {{customer_name}}" }, { customer_name: '<script>alert("x")</script>' }, { assetOrigin: ADMIN_ORIGIN });
  assert.match(unsafe.html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(unsafe.html, /<script>/i); assert.doesNotMatch(unsafe.text, /<script>/i);
  assert.deepEqual(await authorityCounts(harness.commerceDb), before);
});

test("Customer Emails isolates an unsafe persisted template and keeps sibling, sender, and delivery projections available", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { RESEND_API_KEY: "configured-but-unused", MAIL_FROM: "Sender <sender@example.test>" });
  await harness.commerceDb.prepare("UPDATE commerce_templates SET subject='<script>unsafe persisted value</script>',status='ready',enabled=1 WHERE template_key='order_confirmation'").run();

  const payload = await customerEmailsControlPlanePayload(env, master);
  assert.equal(payload.templates.length, 7);
  const invalid = payload.templates.find((template) => template.templateKey === "order_confirmation");
  const sibling = payload.templates.find((template) => template.templateKey === "shipment_notification");
  assert.deepEqual(invalid.validity, {
    state: "invalid", action: "action_required", code: "unsafe_template_content",
    message: "Persisted template fields require review before this template can be previewed or enabled.",
  });
  assert.equal(invalid.enabled, false); assert.equal(invalid.status, "disabled"); assert.equal(invalid.subject, "");
  assert.equal(sibling.validity.state, "valid"); assert.match(sibling.subject, /shipped/i);
  assert.equal(payload.provider.name, "Resend"); assert.equal(payload.sender.fromAddress, "sender@example.test");
  assert.equal(payload.readiness.configuredTemplates, 0); assert.equal(payload.readiness.totalTemplates, 7);
  assert.doesNotMatch(JSON.stringify(payload), /unsafe persisted value|<script>/i);

  const siblingPreview = await templatePreviewPayload(env, master, sibling.templateKey, {});
  assert.equal(siblingPreview.ok, true);
  await assert.rejects(updateTemplate(env, master, sibling.templateKey, { ...serializeTemplate(await harness.commerceDb.prepare("SELECT * FROM commerce_templates WHERE template_key=?").bind(sibling.templateKey).first()), purpose: "projection-only" }), /template fields are invalid/i);
});

test("Customer Emails treats delivery history as optional without collapsing template and sender authority", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { MAIL_FROM: "Sender <sender@example.test>" });
  await harness.commerceDb.prepare("DROP TABLE commerce_email_deliveries").run();
  const payload = await customerEmailsControlPlanePayload(env, master);
  assert.equal(payload.templates.length, 7); assert.equal(payload.deliveries.state, "unavailable");
  assert.deepEqual(payload.deliveries.recent, []); assert.equal(payload.sender.fromAddress, "sender@example.test");
});

test("email subject and preheader reject header injection and template audit remains body-free", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness);
  const row = await harness.commerceDb.prepare("SELECT * FROM commerce_templates WHERE template_key='order_confirmation'").first(); const template = serializeTemplate(row);
  await assert.rejects(updateTemplate(env, master, "order_confirmation", { ...template, subject: "Order accepted\r\nBcc: attacker@example.test" }), /line breaks or control characters/i);
  await assert.rejects(updateTemplate(env, master, "order_confirmation", { ...template, preheader: "Safe\nInjected" }), /line breaks or control characters/i);
  await assert.rejects(updateTemplate(env, master, "order_confirmation", { ...template, subject: "x".repeat(161) }), /too long/i);
  await assert.rejects(updateTemplate(env, master, "order_confirmation", { ...template, heading: "{{customer.profile.secret}}" }), /template variables|structured plain text|unsupported/i);
  const saved = await updateTemplate(env, master, "order_confirmation", { ...template, subject: "Order {{order_reference}}", introduction: "Private body text that must not enter audit" });
  assert.equal(saved.templates.find((item) => item.templateKey === "order_confirmation").revision, 2);
  const audit = await harness.commerceDb.prepare("SELECT action,metadata_json FROM commerce_audit WHERE target_id='order_confirmation' ORDER BY created_at DESC LIMIT 1").first();
  assert.equal(audit.action, "customer_email_template_updated"); assert.deepEqual(JSON.parse(audit.metadata_json), { templateKind: "email", status: "draft", enabled: false, revision: 2, revisionSource: "admin" });
  assert.doesNotMatch(JSON.stringify(audit), /Private body text|Order \{\{order_reference\}\}|attacker/i);
});

async function authenticatedMaster(env) {
  await ensureEnvironmentMasters(env); const account = await loadAccountByEmail(env, "master-one@example.test");
  const session = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), account, ADMIN_ORIGIN);
  return { session, cookie: cookiePair(session.cookie) };
}
async function authorityCounts(db) { const [deliveries, documents, orders, audit] = await Promise.all([db.prepare("SELECT COUNT(*) count FROM commerce_email_deliveries").first(), db.prepare("SELECT COUNT(*) count FROM commerce_order_documents").first(), db.prepare("SELECT COUNT(*) count FROM commerce_orders").first(), db.prepare("SELECT COUNT(*) count FROM commerce_audit").first()]); return { deliveries: deliveries.count, documents: documents.count, orders: orders.count, audit: audit.count }; }
function serializeTemplate(row) { return { templateKey: row.template_key, templateKind: row.template_kind, displayName: row.display_name, subject: row.subject, preheader: row.preheader, heading: row.heading, introduction: row.introduction, bodyBlocks: JSON.parse(row.body_blocks_json), ctaLabel: row.cta_label, ctaUrl: row.cta_url, supportText: row.support_text, footer: row.footer, accentColor: row.accent_color, status: row.status, enabled: row.enabled === 1, revision: Number(row.revision) }; }


test("recorded domain evidence requires matching identity and never invents an observation", () => {
  const settings = { resend_domain_verified: true, resend_domain_status: "verified", resend_domain_id: "recorded-domain-id", resend_domain_checked_at: "2026-09-01T04:03:30.000Z", resend_domain_dns_records: [{ name: "send.notify.thirdrailify.com", status: "verified" }] };
  assert.equal(recordedEmailVerification(settings, "notify.thirdrailify.com").status, "verified");
  assert.equal(recordedEmailVerification(settings, "different.test").status, "unavailable");
  assert.equal(recordedEmailVerification({ resend_domain_verified: true }, "notify.thirdrailify.com").status, "unavailable");
  assert.equal(recordedEmailVerification({ ...settings, resend_domain_checked_at: undefined }, "notify.thirdrailify.com").observedAt, null);
  assert.equal(recordedEmailVerification({ ...settings, resend_domain_verified: false, resend_domain_status: "failure" }, "notify.thirdrailify.com").status, "failed");
});

test("enabled delivery projects runtime prerequisites and template eligibility independently of an empty ledger", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { RESEND_API_KEY: "fixture-only", MAIL_FROM: "Sender <alerts@notify.thirdrailify.com>", COMMERCE_WORKER_SECRET: "x".repeat(32) });
  const settings = { customer_document_access_enabled: true, transactional_email_enabled: true, resend_domain_verified: true, resend_domain_status: "verified", resend_domain_id: "recorded-domain-id", resend_domain_checked_at: "2026-09-01T04:03:30.000Z", resend_domain_dns_records: [{ name: "send.notify.thirdrailify.com", status: "verified" }], commerce_operations_worker_configured: true };
  for (const [key,value] of Object.entries(settings)) await harness.commerceDb.prepare("INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at) VALUES (?,?,'safe','2026-09-01') ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json").bind(key,JSON.stringify(value)).run();
  await harness.commerceDb.prepare("UPDATE commerce_templates SET status='ready',enabled=1 WHERE template_key='order_confirmation'").run();
  let payload = await customerEmailsControlPlanePayload(env, master);
  assert.equal(payload.readiness.delivery.state, "active", JSON.stringify(payload.readiness.delivery));
  assert.equal(payload.readiness.customerSendsEnabled, true);
  assert.equal(payload.deliveries.counts.total, 0);
  assert.equal(payload.readiness.delivery.events.find(e=>e.templateKey==='shipment_notification').eligible, false);
  assert.equal(payload.verification.status, "verified");
  payload = await customerEmailsControlPlanePayload({...env,COMMERCE_WORKER_SECRET:undefined}, master);
  assert.equal(payload.readiness.delivery.state, "action_required");
  assert.deepEqual(payload.readiness.delivery.blockers, ["Commerce Operations Worker dispatch is not configured"]);
  await harness.commerceDb.prepare("UPDATE commerce_templates SET enabled=0 WHERE template_key='order_confirmation'").run();
  payload = await customerEmailsControlPlanePayload(env, master);
  assert.equal(payload.readiness.customerSendsEnabled, true);
  assert.deepEqual(payload.readiness.delivery.blockers, ["order_confirmation template is disabled"]);
  await harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='false' WHERE setting_key='transactional_email_enabled'").run();
  assert.equal((await customerEmailsControlPlanePayload(env,master)).readiness.delivery.state,"disabled");
  const unavailable=await customerEmailsControlPlanePayload({...env,THIRDRAILIFY_COMMERCE_DB:undefined},master);
  assert.equal(unavailable.readiness.customerSendsEnabled,null); assert.equal(unavailable.readiness.delivery.state,"unavailable");
});


test("existing dispatcher renders eligible shipment jobs, persists mocked outcomes and prevents duplicate delivery", async t => {
  const harness=await createCommerceDatabases();t.after(harness.dispose);
  const base=commerceEnvironment(harness,{RESEND_API_KEY:"fixture-only",MAIL_FROM:"Sender <sender@example.test>"});
  const recipient=await encryptCommerceSecret(base,JSON.stringify({customerContact:{email:"synthetic@example.test",name:"Synthetic customer"}}),"order-delivery:ord-email-dispatch");
  const db=harness.commerceDb;
  const env={...base,THIRDRAILIFY_COMMERCE_DB:{prepare:sql=>sql==="SELECT recipient_ciphertext FROM commerce_order_delivery_snapshots WHERE order_id=?"?{bind:()=>({first:async()=>({recipient_ciphertext:recipient})})}:db.prepare(sql),batch:statements=>db.batch(statements)}};
  await db.prepare("INSERT INTO commerce_orders(id,payment_status,fulfillment_status,currency_code,customer_gross_amount,environment,checkout_status,created_at,updated_at) VALUES ('ord-email-dispatch','paid','disabled','CAD',2500,'live','checkout_created','2026-09-01','2026-09-01')").run();
  await db.prepare("UPDATE commerce_settings SET value_json='true' WHERE setting_key IN ('transactional_email_enabled','resend_domain_verified')").run();
  await db.prepare("UPDATE commerce_templates SET status='ready',enabled=1 WHERE template_key='shipment_notification'").run();
  await db.prepare("INSERT INTO commerce_operation_jobs(id,job_kind,event_key,order_id,environment,payload_digest,state,next_attempt_at,created_at,updated_at) VALUES ('coj_11111111-1111-4111-8111-111111111111','email_send','shipment:synthetic','ord-email-dispatch','live',?,'pending','2026-09-01','2026-09-01','2026-09-01')").bind('a'.repeat(64)).run();
  let calls=0;
  const mock=async(url,init)=>{calls++;assert.equal(url,"https://api.resend.com/emails");assert.ok(init.headers['Idempotency-Key']);assert.match(JSON.parse(init.body).html,/THIRD RAILIFY OFFICIAL/);return new Response(JSON.stringify({id:"mock-message"}),{status:200});};
  assert.equal((await processCommerceJobs(env,mock)).results[0].state,"completed");
  assert.equal((await db.prepare("SELECT status FROM commerce_email_deliveries").first()).status,"sent");
  await db.prepare("UPDATE commerce_operation_jobs SET state='pending' WHERE id='coj_11111111-1111-4111-8111-111111111111'").run();
  assert.equal((await processCommerceJobs(env,mock)).results[0].result.duplicate,true);assert.equal(calls,1);
  await db.prepare("UPDATE commerce_settings SET value_json='false' WHERE setting_key='transactional_email_enabled'").run();
  await db.prepare("UPDATE commerce_operation_jobs SET state='pending' WHERE id='coj_11111111-1111-4111-8111-111111111111'").run();
  assert.equal((await processCommerceJobs(env,mock)).results[0].state,"action_required");assert.equal(calls,1);
});
