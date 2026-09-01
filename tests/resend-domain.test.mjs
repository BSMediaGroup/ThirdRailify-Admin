import assert from "node:assert/strict";
import test from "node:test";
import { createCommerceDatabases, commerceEnvironment } from "./commerce-test-helpers.mjs";
import { reconcileRequestedResendDomain } from "../functions/_shared/resend-domain.js";

test("Resend sending-domain reconciliation is bounded, safe, and purpose-specific", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { RESEND_API_KEY: "resend-production-secret", MAIL_FROM: "Third Railify Official <alerts@notify.thirdrailify.com>", MAIL_REPLY_TO: "info@thirdrailify.com" });
  const domain = {
    id: "domain-safe-1234",
    name: "notify.thirdrailify.com",
    status: "pending",
    region: "us-east-1",
    capabilities: { sending: "enabled", receiving: "disabled" },
    records: [
      { record: "SPF", type: "MX", name: "send", value: "feedback-smtp.example.test", priority: 10, status: "pending" },
      { record: "SPF", type: "TXT", name: "send", value: "v=spf1 include:example.test ~all", status: "pending" },
      { record: "DKIM", type: "TXT", name: "resend._domainkey", value: "p=public-dkim-value", status: "pending" },
    ],
  };
  await request(harness.commerceDb);
  const calls = [];
  const first = await reconcileRequestedResendDomain(env, async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", authorization: init.headers.Authorization });
    if (url.endsWith("/domains") && !init.method) return Response.json({ object: "list", data: [] });
    if (url.endsWith("/domains") && init.method === "POST") return Response.json(domain);
    if (url.endsWith("/verify")) return Response.json({ object: "domain", id: domain.id });
    return Response.json(domain);
  });
  assert.equal(first.status, "pending");
  assert.equal(first.created, true);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.authorization === "Bearer resend-production-secret"));
  assert.equal(JSON.stringify(first).includes("resend-production-secret"), false);
  assert.equal(await setting(harness.commerceDb, "resend_domain_verified"), false);
  assert.deepEqual(JSON.parse(await settingRaw(harness.commerceDb, "resend_domain_dns_records")).map((record) => record.name), ["send.notify.thirdrailify.com", "send.notify.thirdrailify.com", "resend._domainkey.notify.thirdrailify.com"]);
  assert.deepEqual(await templateStates(harness.commerceDb), { order_confirmation: "draft:0", shipment_notification: "draft:0" });
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_email_deliveries").first()).count, 0);

  await request(harness.commerceDb);
  domain.status = "verified";
  domain.records = domain.records.map((record) => ({ ...record, status: "verified" }));
  const second = await reconcileRequestedResendDomain(env, async (url, init = {}) => {
    if (url.endsWith("/domains")) return Response.json({ object: "list", data: [domain] });
    if (url.endsWith("/verify")) return Response.json({ object: "domain", id: domain.id });
    return Response.json(domain);
  });
  assert.equal(second.status, "verified");
  assert.equal(second.created, false);
  assert.equal(await setting(harness.commerceDb, "resend_domain_verified"), true);
  assert.deepEqual(await templateStates(harness.commerceDb), { order_confirmation: "ready:1", shipment_notification: "draft:0" });
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_email_deliveries").first()).count, 0);
});

test("Resend reconciliation refuses a sender outside the canonical subdomain without provider calls", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await request(harness.commerceDb);
  let calls = 0;
  const result = await reconcileRequestedResendDomain(commerceEnvironment(harness, { RESEND_API_KEY: "resend-production-secret", MAIL_FROM: "Wrong <alerts@thirdrailify.com>" }), async () => { calls += 1; return Response.json({}); });
  assert.equal(result.status, "error");
  assert.equal(calls, 0);
  assert.equal(await setting(harness.commerceDb, "resend_domain_verified"), false);
});

async function request(db) {
  await db.prepare("INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at) VALUES ('resend_domain_reconcile_requested','true','safe','2026-09-01T00:00:00Z') ON CONFLICT(setting_key) DO UPDATE SET value_json='true'").run();
}
async function settingRaw(db, key) { return (await db.prepare("SELECT value_json FROM commerce_settings WHERE setting_key=?").bind(key).first()).value_json; }
async function setting(db, key) { return JSON.parse(await settingRaw(db, key)); }
async function templateStates(db) { const rows = await db.prepare("SELECT template_key,status,enabled FROM commerce_templates WHERE template_key IN ('order_confirmation','shipment_notification') ORDER BY template_key").all(); return Object.fromEntries(rows.results.map((row) => [row.template_key, `${row.status}:${row.enabled}`])); }
