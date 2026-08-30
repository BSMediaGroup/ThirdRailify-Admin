import assert from "node:assert/strict";
import test from "node:test";
import { PRINTFUL_V2_WEBHOOK_EVENTS } from "../functions/_shared/printful-fulfillment.js";
import {
  configurePrintfulV2Webhook,
  PRINTFUL_WEBHOOK_URL,
  PrintfulProviderSupportRequired,
  webhookResult,
} from "../scripts/configure-printful-v2-webhook.mjs";

const PUBLIC_KEY = "c3ludGhldGljLXByaW50ZnVsLXdlYmhvb2s=";
const SECRET_HEX = Buffer.from("synthetic-printful-v2-webhook-secret-32-bytes!!").toString("hex");

function response(result, status = 200, headers = {}) {
  return new Response(JSON.stringify({ code: status, result, extra: [] }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function configured(includeSecret = false) {
  return {
    default_url: PRINTFUL_WEBHOOK_URL,
    expires_at: null,
    events: PRINTFUL_V2_WEBHOOK_EVENTS.map((type) => ({ type, url: null, params: [] })),
    public_key: PUBLIC_KEY,
    ...(includeSecret ? { secret_key: SECRET_HEX } : {}),
  };
}

test("Printful V2 setup posts the official result-level contract once and stores keys without returning them", async () => {
  const calls = [];
  let stored = null;
  const outcome = await configurePrintfulV2Webhook({
    token: "provider-token-not-logged",
    storeId: "18668025",
    tokenClass: "store_level_private_token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body || null });
      if (calls.length === 1) return response({ default_url: null, expires_at: null, events: [], public_key: null });
      if (calls.length === 2) return response(configured(true));
      return response(configured(false));
    },
    storeSecrets: async (values) => { stored = values; },
  });

  assert.deepEqual(outcome.calls, { get: 2, post: 1 });
  assert.equal(outcome.configured, true);
  assert.equal(outcome.readbackVerified, true);
  assert.equal(outcome.secretsStored, true);
  assert.equal(JSON.stringify(outcome).includes(SECRET_HEX), false);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].headers.has("X-PF-Store-Id"), false);
  assert.deepEqual(JSON.parse(calls[1].body), {
    default_url: PRINTFUL_WEBHOOK_URL,
    expires_at: null,
    events: PRINTFUL_V2_WEBHOOK_EVENTS.map((type) => ({ type })),
  });
  assert.deepEqual(stored, {
    PRINTFUL_WEBHOOK_V2_PUBLIC_KEY: PUBLIC_KEY,
    PRINTFUL_WEBHOOK_V2_SECRET_HEX: SECRET_HEX,
  });
});

test("response parsing accepts only the documented top-level result object", () => {
  assert.equal(webhookResult({ result: configured() })?.public_key, PUBLIC_KEY);
  assert.equal(webhookResult(configured()), null);
  assert.equal(webhookResult({ data: configured() }), null);
  assert.equal(webhookResult({ result: [] }), null);
});

test("an HTTP success without signing material stops with a sanitized provider support packet", async () => {
  let stores = 0;
  await assert.rejects(configurePrintfulV2Webhook({
    token: "provider-token-not-logged",
    storeId: "18668025",
    tokenClass: "store_level_private_token",
    fetchImpl: async (_url, init) => init.method === "GET"
      ? response({ default_url: null, expires_at: null, events: [], public_key: null })
      : response(null, 200, { "X-Request-Id": "safe-request-id" }),
    storeSecrets: async () => { stores += 1; },
  }), (error) => {
    assert.equal(error instanceof PrintfulProviderSupportRequired, true);
    assert.equal(error.packet.httpStatus, 200);
    assert.equal(error.packet.resultType, "null_or_missing");
    assert.deepEqual(error.packet.topLevelJsonKeys, ["code", "extra", "result"]);
    assert.equal(error.packet.requestId, "safe-request-id");
    assert.equal(error.packet.storeId, "18668025");
    assert.equal(error.packet.eventCount, PRINTFUL_V2_WEBHOOK_EVENTS.length);
    assert.match(error.packet.payloadDigest, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(error.packet), /provider-token|secret|public_key/i);
    return true;
  });
  assert.equal(stores, 0);
});
