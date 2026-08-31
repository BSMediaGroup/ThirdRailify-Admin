import assert from "node:assert/strict";
import test from "node:test";
import { onRequest, MAX_BODY_BYTES, normalizeSteamUrl } from "../functions/api/gaming/suggestions.js";
import { hmacSha256 } from "../functions/_shared/auth-core.js";
import { adminInboxMessages } from "../functions/_shared/admin-inbox.js";
import { createCommerceDatabases, commerceEnvironment } from "./commerce-test-helpers.mjs";
import { makeAuthFetch } from "./auth-test-helpers.mjs";

test("signed manual Gaming suggestions persist as complete discoverable Admin Inbox messages", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = gamingEnvironment(harness);
  const requestId = "12345678-1234-4123-8123-123456789abc";
  const response = await onRequest({ request: await signedRequest(env, { requestId, gameTitle: "Deep Rock Galactic", pitch: "Four dwarves and a bad plan.", accountId: null, displayName: null }), env, data: { gamingFetch: makeAuthFetch() } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reference: "GAM-12345678", idempotent: false });
  const messages = await adminInboxMessages(env, "admin-reader");
  assert.equal(messages.items.length, 1);
  assert.equal(messages.items[0].category, "gaming");
  assert.equal(messages.items[0].sourceType, "gaming_suggestion");
  assert.equal(messages.items[0].sourceId, requestId);
  assert.match(messages.items[0].title, /Deep Rock Galactic/);
  assert.match(messages.items[0].body, /PC via Steam/);
  assert.match(messages.items[0].body, /Four dwarves and a bad plan/);
  assert.match(messages.items[0].body, /Guest request/);
  assert.equal(messages.items[0].actionUrl, null);
});

test("Gaming intake normalizes Steam URLs and records trusted signed account attribution", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = gamingEnvironment(harness);
  const response = await onRequest({ request: await signedRequest(env, { requestId: "22345678-1234-4123-8123-123456789abc", gameTitle: "Luminary", steamUrl: "https://store.steampowered.com/app/1648360/Luminary/?utm_source=fixture", accountId: "account-verified", displayName: "Rail Viewer" }), env, data: { gamingFetch: makeAuthFetch() } });
  assert.equal(response.status, 200);
  const row = await harness.commerceDb.prepare("SELECT * FROM admin_inbox_messages WHERE source_id = ?").bind("22345678-1234-4123-8123-123456789abc").first();
  assert.match(row.body_text, /https:\/\/store\.steampowered\.com\/app\/1648360\//);
  assert.match(row.body_text, /Steam App ID: 1648360/);
  assert.match(row.body_text, /Rail Viewer \(account-verified\)/);
  assert.deepEqual(normalizeSteamUrl(""), { url: null, appId: null });
});

test("Gaming intake is idempotent by signed request ID", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = gamingEnvironment(harness);
  const body = { requestId: "32345678-1234-4123-8123-123456789abc", gameTitle: "Portal 2" };
  const first = await onRequest({ request: await signedRequest(env, body), env, data: { gamingFetch: makeAuthFetch() } });
  const second = await onRequest({ request: await signedRequest(env, body), env, data: { gamingFetch: makeAuthFetch() } });
  assert.equal((await first.json()).idempotent, false);
  assert.equal((await second.json()).idempotent, true);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM admin_inbox_messages WHERE source_type='gaming_suggestion'").first()).count, 1);
});

test("Gaming intake rejects malformed URL, empty title, markup, oversized bodies, forged relays, and wrong origins", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = gamingEnvironment(harness);
  assert.equal((await onRequest({ request: await signedRequest(env, { gameTitle: "Portal", steamUrl: "http://store.steampowered.com/app/400/" }), env, data: { gamingFetch: makeAuthFetch() } })).status, 400);
  assert.equal((await onRequest({ request: await signedRequest(env, { gameTitle: "" }), env, data: { gamingFetch: makeAuthFetch() } })).status, 400);
  assert.equal((await onRequest({ request: await signedRequest(env, { pitch: "<script>alert(1)</script>" }), env, data: { gamingFetch: makeAuthFetch() } })).status, 400);
  const oversized = "x".repeat(MAX_BODY_BYTES + 1);
  assert.equal((await onRequest({ request: new Request("https://thirdrailify-admin.pages.dev/api/gaming/suggestions", { method: "POST", headers: { Origin: env.THIRDRAILIFY_PUBLIC_ORIGIN, "Content-Type": "application/json", "X-ThirdRailify-Timestamp": String(Math.floor(Date.now() / 1000)), "X-ThirdRailify-Signature": "forged" }, body: oversized }), env })).status, 413);
  const forged = await signedRequest(env, {}); forged.headers.set("X-ThirdRailify-Signature", "forged");
  assert.equal((await onRequest({ request: forged, env })).status, 401);
  assert.equal((await onRequest({ request: await signedRequest(env, {}, "https://attacker.example"), env })).status, 403);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM admin_inbox_messages WHERE source_type='gaming_suggestion'").first()).count, 0);
});

test("Gaming intake Turnstile and rate limit fail closed while honeypot creates no inbox row", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = gamingEnvironment(harness);
  const invalid = await onRequest({ request: await signedRequest(env, { turnstileToken: "invalid-gaming-suggestion" }), env, data: { gamingFetch: makeAuthFetch() } });
  assert.equal(invalid.status, 403);
  const honeypot = await onRequest({ request: await signedRequest(env, { website: "spam.example", turnstileToken: "" }), env, data: { gamingFetch: async () => { throw new Error("unexpected"); } } });
  assert.equal(honeypot.status, 200);
  for (let index = 0; index < 5; index += 1) {
    const response = await onRequest({ request: await signedRequest(env, { requestId: `${String(index + 4).padStart(8, "0")}-1234-4123-8123-123456789abc` }), env, data: { gamingFetch: makeAuthFetch() } });
    assert.equal(response.status, 200);
  }
  const blocked = await onRequest({ request: await signedRequest(env, { requestId: "99999999-1234-4123-8123-123456789abc" }), env, data: { gamingFetch: makeAuthFetch() } });
  assert.equal(blocked.status, 429);
  assert.equal((await harness.authDb.prepare("SELECT attempt_count FROM auth_rate_limits WHERE category='gaming_suggestion'").first()).attempt_count, 7);
});

function gamingEnvironment(harness) {
  return commerceEnvironment(harness, { THIRDRAILIFY_COMMUNITY_API_SECRET: "gaming-signing-fixture" });
}

async function signedRequest(env, overrides = {}, origin = env.THIRDRAILIFY_PUBLIC_ORIGIN) {
  const body = JSON.stringify({ requestId: "42345678-1234-4123-8123-123456789abc", gameTitle: "Portal 2", steamUrl: "", pitch: "", website: "", turnstileToken: "valid-gaming-suggestion", accountId: null, displayName: null, rateKey: "a".repeat(43), ...overrides });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = await digestHex(new TextEncoder().encode(body));
  const signature = await hmacSha256(env.THIRDRAILIFY_COMMUNITY_API_SECRET, `${timestamp}\nPOST\n/api/gaming/suggestions\n${digest}`);
  return new Request("https://thirdrailify-admin.pages.dev/api/gaming/suggestions", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.42", "X-ThirdRailify-Timestamp": timestamp, "X-ThirdRailify-Signature": signature }, body });
}

async function digestHex(bytes) { const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
