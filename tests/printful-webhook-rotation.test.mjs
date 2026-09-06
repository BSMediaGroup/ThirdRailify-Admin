import assert from "node:assert/strict";
import test from "node:test";
import { rotatePrintfulWebhook } from "../scripts/rotate-printful-v2-webhook.mjs";
import { PRINTFUL_V2_WEBHOOK_EVENTS } from "../functions/_shared/printful-fulfillment.js";
import { PRINTFUL_WEBHOOK_URL } from "../scripts/configure-printful-v2-webhook.mjs";

test("rotation activates no events until secret custody, deployment and live verifier succeed", async () => {
  const calls = []; const key = "c3ludGhldGljLWtleQ==", secret = "ab".repeat(32);
  let enabled = [], stored = false, deployed = false;
  const outcome = await rotatePrintfulWebhook({ token: "fixture", storeSecrets: async values => { assert.equal(enabled.length, 0); assert.equal(values.PRINTFUL_WEBHOOK_V2_SECRET_HEX, secret); stored = true; }, deploy: async () => { assert.equal(stored, true); deployed = true; return "fixture-deploy"; }, fetchImpl: async (url, init = {}) => {
    calls.push([url, init.method || "GET"]);
    if (url === PRINTFUL_WEBHOOK_URL) { assert.equal(deployed, true); return Response.json({ error: "printful_webhook_payload_invalid" }, { status: 400 }); }
    if (init.method === "POST" && url.endsWith("/webhooks")) { assert.deepEqual(JSON.parse(init.body).events, []); return Response.json({ data: { public_key: key, secret_key: secret, events: [] } }); }
    if (init.method === "POST") { assert.equal(deployed, true); enabled.push(url.split("/").at(-1)); return Response.json({ data: {} }); }
    return Response.json({ data: { default_url: PRINTFUL_WEBHOOK_URL, public_key: key, events: enabled.map(type => ({ type })) } });
  } });
  assert.deepEqual(enabled, [...PRINTFUL_V2_WEBHOOK_EVENTS]); assert.equal(outcome.readbackVerified, true); assert.doesNotMatch(JSON.stringify(outcome), new RegExp(secret));
});
test("failed runtime verification leaves events disabled", async () => {
  let activationCalls = 0;
  await assert.rejects(rotatePrintfulWebhook({ token: "fixture", storeSecrets: async () => {}, deploy: async () => "fixture", fetchImpl: async (url, init = {}) => {
    if (url === PRINTFUL_WEBHOOK_URL) return Response.json({ error: "printful_webhook_signature_invalid" }, { status: 403 });
    if (init.method === "POST" && !url.endsWith("/webhooks")) activationCalls++;
    return Response.json({ data: { public_key: "c3ludGhldGljLWtleQ==", secret_key: "ab".repeat(32), events: [] } });
  } }), /deployed_verifier_failed/);
  assert.equal(activationCalls, 0);
});
