import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runCommercePayPal } from "../scripts/commerce-paypal.mjs";

const URL = "https://thirdrailify-admin.pages.dev/api/webhooks/paypal";
const EVENTS = ["CHECKOUT.ORDER.APPROVED","CHECKOUT.PAYMENT-APPROVAL.REVERSED","PAYMENT.CAPTURE.PENDING","PAYMENT.CAPTURE.COMPLETED","PAYMENT.CAPTURE.DECLINED","PAYMENT.CAPTURE.REFUNDED","PAYMENT.CAPTURE.REVERSED"];

function statusResult(metadata = {}) {
  return JSON.stringify([{ results: [{
    safe_metadata_json: JSON.stringify(metadata), stripe_configured: 1,
    preferred_payment_provider: '"paypal"', stripe_enabled: "false",
    paypal_donations_enabled: "false", paypal_store_checkout_enabled: "false",
    paypal_live_capture_enabled: "false", paypal_donation_live_capture_enabled: "false", commerce_emergency_paused: "false",
    sandbox_store_completed: 0, live_store_completed: 0, sandbox_donation_completed: 0, live_donation_completed: 0,
  }] }]);
}

test("PayPal setup status is provider-read-only and projects only named binding presence", async () => {
  let providerCalls = 0; let output;
  const result = await runCommercePayPal(["status"], {
    env: {}, fetch: async () => { providerCalls += 1; throw new Error("must not call provider"); },
    readConfig: async () => '{"vars":{"THIRDRAILIFY_ADMIN_ORIGIN":"https://thirdrailify-admin.pages.dev"}}',
    wrangler: async (args) => args[0] === "pages" ? { stdout: "PAYPAL_SANDBOX_CLIENT_ID\nPAYPAL_LIVE_CLIENT_ID_BACKUP\n" } : { stdout: statusResult() },
    io: { write: (value) => { output = value; } },
  });
  assert.equal(providerCalls, 0);
  assert.equal(result.bindings.PAYPAL_SANDBOX_CLIENT_ID.adminPages, "configured");
  assert.equal(result.bindings.PAYPAL_SANDBOX_CLIENT_SECRET.adminPages, "absent");
  assert.equal(result.bindings.PAYPAL_LIVE_CLIENT_ID.adminPages, "absent");
  assert.equal(result.webhookUrl, URL);
  assert.deepEqual(output.providerCalls, { oauth: 0, webhookListRead: 0, webhookCreate: 0, webhookPatch: 0, orders: 0, captures: 0 });
  assert.doesNotMatch(JSON.stringify(result), /client-secret-value|access-token-value/i);
});

test("PayPal configure validates OAuth, creates one webhook, stores secrets via stdin boundary, deploys, and persists only safe evidence", async () => {
  const calls = []; const stored = []; let deployed = 0; let persistedSql = "";
  const metadata = { sandbox: { oauth_verified: true, webhook_configured: true, webhook_readback_verified: true, webhook_events: EVENTS } };
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "access-token-value", token_type: "Bearer", expires_in: 3600 });
    if (url.endsWith("/v1/notifications/webhooks") && init.method === "GET") return Response.json({ webhooks: [] });
    if (url.endsWith("/v1/notifications/webhooks") && init.method === "POST") return Response.json({ id: "WHCONFIG001", url: URL, event_types: EVENTS.map((name) => ({ name })) }, { status: 201 });
    if (url.endsWith("/v1/notifications/webhooks/WHCONFIG001")) return Response.json({ id: "WHCONFIG001", url: URL, event_types: EVENTS.map((name) => ({ name })) });
    throw new Error(`unexpected:${url}`);
  };
  const wrangler = async (args) => {
    if (args.includes("--file")) { persistedSql = await readFile(args[args.indexOf("--file") + 1], "utf8"); return { stdout: "ok" }; }
    if (args[0] === "pages") return { stdout: "PAYPAL_SANDBOX_CLIENT_ID\nPAYPAL_SANDBOX_CLIENT_SECRET\nPAYPAL_SANDBOX_WEBHOOK_ID\n" };
    return { stdout: statusResult(metadata) };
  };
  const result = await runCommercePayPal(["configure", "sandbox"], {
    env: { PAYPAL_SANDBOX_CLIENT_ID: "sandbox-client-value", PAYPAL_SANDBOX_CLIENT_SECRET: "sandbox-secret-value" }, fetch,
    readConfig: async () => '{"vars":{"THIRDRAILIFY_ADMIN_ORIGIN":"https://thirdrailify-admin.pages.dev"}}', wrangler,
    putSecret: async (name, value) => { stored.push({ name, value }); }, deploy: async () => { deployed += 1; },
    now: () => new Date("2026-08-30T04:00:00.000Z"), io: { write: () => {} },
  });
  assert.deepEqual(stored.map((entry) => entry.name), ["PAYPAL_SANDBOX_CLIENT_ID","PAYPAL_SANDBOX_CLIENT_SECRET","PAYPAL_SANDBOX_WEBHOOK_ID"]);
  assert.equal(deployed, 1);
  assert.equal(result.providerCalls.oauth, 1); assert.equal(result.providerCalls.webhookListRead, 2); assert.equal(result.providerCalls.webhookCreate, 1); assert.equal(result.providerCalls.orders, 0);
  assert.deepEqual(calls.map((call) => `${call.method} ${new globalThis.URL(call.url).pathname}`), [
    "POST /v1/oauth2/token",
    "GET /v1/notifications/webhooks",
    "POST /v1/notifications/webhooks",
    "GET /v1/notifications/webhooks/WHCONFIG001",
  ]);
  assert.match(persistedSql, /commerce\.paypal_provider_configured/);
  assert.doesNotMatch(persistedSql, /sandbox-secret-value|access-token-value|WHCONFIG001/);
  assert.equal(calls.some((call) => call.url.includes("api-m.paypal.com") && !call.url.includes("sandbox")), false);
});

test("PayPal configure reuses one exact Live webhook without creating or patching", async () => {
  const calls = []; const stored = [];
  const webhook = { id: "WHLIVE001", url: URL, event_types: EVENTS.map((name) => ({ name })) };
  const fetch = async (url, init = {}) => {
    const method = init.method || "GET"; calls.push({ url, method });
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "live-reuse-access-token", token_type: "Bearer", expires_in: 3600 });
    if (url.endsWith("/v1/notifications/webhooks") && method === "GET") return Response.json({ webhooks: [webhook] });
    if (url.endsWith("/v1/notifications/webhooks/WHLIVE001") && method === "GET") return Response.json(webhook);
    throw new Error(`unexpected:${method}:${url}`);
  };
  const metadata = { live: { oauth_verified: true, webhook_configured: true, webhook_readback_verified: true, webhook_events: EVENTS } };
  const result = await runCommercePayPal(["configure", "live"], {
    env: { PAYPAL_LIVE_CLIENT_ID: "live-reuse-client", PAYPAL_LIVE_CLIENT_SECRET: "live-reuse-secret" }, fetch,
    readConfig: async () => '{"vars":{"THIRDRAILIFY_ADMIN_ORIGIN":"https://thirdrailify-admin.pages.dev"}}',
    wrangler: async (args) => {
      if (args.includes("--file")) return { stdout: "ok" };
      if (args[0] === "pages") return { stdout: "PAYPAL_LIVE_CLIENT_ID\nPAYPAL_LIVE_CLIENT_SECRET\nPAYPAL_LIVE_WEBHOOK_ID\n" };
      return { stdout: statusResult(metadata) };
    },
    putSecret: async (name) => { stored.push(name); }, deploy: async () => {}, io: { write: () => {} },
    now: () => new Date("2026-08-30T05:00:00.000Z"),
  });
  assert.equal(result.webhook.action, "unchanged");
  assert.deepEqual(stored, ["PAYPAL_LIVE_CLIENT_ID", "PAYPAL_LIVE_CLIENT_SECRET", "PAYPAL_LIVE_WEBHOOK_ID"]);
  assert.deepEqual(result.providerCalls, { oauth: 1, webhookListRead: 2, webhookCreate: 0, webhookPatch: 0, orders: 0, captures: 0 });
  assert.equal(calls.every((call) => call.url.startsWith("https://api-m.paypal.com/")), true);
  assert.equal(calls.some((call) => call.url.includes("sandbox.paypal.com")), false);
});

test("PayPal configure reconciles a non-exact event multiset with one patch", async () => {
  const calls = [];
  const duplicateEvents = [...EVENTS, EVENTS[0]].map((name) => ({ name }));
  const corrected = { id: "WHPATCH001", url: URL, event_types: EVENTS.map((name) => ({ name })) };
  const fetch = async (url, init = {}) => {
    const method = init.method || "GET"; calls.push({ url, method });
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "patch-access-token", token_type: "Bearer", expires_in: 3600 });
    if (url.endsWith("/v1/notifications/webhooks") && method === "GET") return Response.json({ webhooks: [{ ...corrected, event_types: duplicateEvents }] });
    if (url.endsWith("/v1/notifications/webhooks/WHPATCH001") && method === "PATCH") return Response.json(corrected);
    if (url.endsWith("/v1/notifications/webhooks/WHPATCH001") && method === "GET") return Response.json(corrected);
    throw new Error(`unexpected:${method}:${url}`);
  };
  const metadata = { sandbox: { oauth_verified: true, webhook_configured: true, webhook_readback_verified: true, webhook_events: EVENTS } };
  const result = await runCommercePayPal(["configure", "sandbox"], {
    env: { PAYPAL_SANDBOX_CLIENT_ID: "patch-client-value", PAYPAL_SANDBOX_CLIENT_SECRET: "patch-secret-value" }, fetch,
    readConfig: async () => '{"vars":{"THIRDRAILIFY_ADMIN_ORIGIN":"https://thirdrailify-admin.pages.dev"}}',
    wrangler: async (args) => {
      if (args.includes("--file")) return { stdout: "ok" };
      if (args[0] === "pages") return { stdout: "PAYPAL_SANDBOX_CLIENT_ID\nPAYPAL_SANDBOX_CLIENT_SECRET\nPAYPAL_SANDBOX_WEBHOOK_ID\n" };
      return { stdout: statusResult(metadata) };
    },
    putSecret: async () => {}, deploy: async () => {}, io: { write: () => {} },
    now: () => new Date("2026-08-30T06:00:00.000Z"),
  });
  assert.equal(result.webhook.action, "updated");
  assert.deepEqual(result.providerCalls, { oauth: 1, webhookListRead: 2, webhookCreate: 0, webhookPatch: 1, orders: 0, captures: 0 });
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
});

test("PayPal verify uses the masked secret prompt boundary and requires stored Live readiness", async () => {
  const calls = []; const prompts = []; let output;
  const webhook = { id: "WHVERIFY001", url: URL, event_types: EVENTS.map((name) => ({ name })) };
  const metadata = { live: { oauth_verified: true, webhook_configured: true, webhook_readback_verified: true, webhook_events: EVENTS } };
  const result = await runCommercePayPal(["verify", "live"], {
    env: { PAYPAL_LIVE_CLIENT_ID: "verify-live-client" },
    promptSecret: async (label) => { prompts.push(label); return "verify-live-secret"; },
    fetch: async (url, init = {}) => {
      const method = init.method || "GET"; calls.push({ url, method });
      if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "verify-access-token", token_type: "Bearer", expires_in: 3600 });
      if (url.endsWith("/v1/notifications/webhooks") && method === "GET") return Response.json({ webhooks: [webhook] });
      if (url.endsWith("/v1/notifications/webhooks/WHVERIFY001") && method === "GET") return Response.json(webhook);
      throw new Error(`unexpected:${method}:${url}`);
    },
    readConfig: async () => '{"vars":{"THIRDRAILIFY_ADMIN_ORIGIN":"https://thirdrailify-admin.pages.dev"}}',
    wrangler: async (args) => args[0] === "pages"
      ? { stdout: "PAYPAL_LIVE_CLIENT_ID\nPAYPAL_LIVE_CLIENT_SECRET\nPAYPAL_LIVE_WEBHOOK_ID\n" }
      : { stdout: statusResult(metadata) },
    putSecret: async () => { throw new Error("verify must not store"); }, deploy: async () => { throw new Error("verify must not deploy"); },
    io: { write: (value) => { output = value; } },
  });
  assert.deepEqual(prompts, ["LIVE Client Secret: "]);
  assert.equal(result.configuration.webhook, "configured");
  assert.deepEqual(result.providerCalls, { oauth: 1, webhookListRead: 2, webhookCreate: 0, webhookPatch: 0, orders: 0, captures: 0 });
  assert.equal(calls.every((call) => call.url.startsWith("https://api-m.paypal.com/")), true);
  assert.doesNotMatch(JSON.stringify(output), /verify-live-secret|verify-access-token|WHVERIFY001/);
});

test("PayPal configure refuses duplicate canonical webhooks before secret or D1 mutation", async () => {
  let mutations = 0;
  const fetch = async (url) => {
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "duplicate-token", token_type: "Bearer", expires_in: 3600 });
    return Response.json({ webhooks: [{ id: "WHDUPE001", url: URL, event_types: [] }, { id: "WHDUPE002", url: URL, event_types: [] }] });
  };
  await assert.rejects(() => runCommercePayPal(["configure", "sandbox"], {
    env: { PAYPAL_SANDBOX_CLIENT_ID: "duplicate-client", PAYPAL_SANDBOX_CLIENT_SECRET: "duplicate-secret" }, fetch,
    readConfig: async () => '{"vars":{"THIRDRAILIFY_ADMIN_ORIGIN":"https://thirdrailify-admin.pages.dev"}}',
    putSecret: async () => { mutations += 1; }, deploy: async () => { mutations += 1; }, wrangler: async () => { mutations += 1; return { stdout: "" }; }, io: { write: () => {} },
  }), (error) => error?.providerCode === "duplicate_webhooks");
  assert.equal(mutations, 0);
});

test("PayPal CLI rejects command-line credential material", async () => {
  await assert.rejects(() => runCommercePayPal(["configure", "live", "secret-on-argv"]), /Credentials are never accepted/);
});
