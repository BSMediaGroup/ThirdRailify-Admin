import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../functions/api/contact.js";
import { hmacSha256 } from "../functions/_shared/auth-core.js";
import { authEnvironment, createAuthDatabase, makeAuthFetch } from "./auth-test-helpers.mjs";

test("contact delivery verifies Turnstile and sends exact Resend To, CC, and Reply-To fields", async (t) => {
  const harness = await createAuthDatabase(); t.after(harness.dispose);
  const messages = [];
  const env = contactEnvironment(harness.db);
  const response = await onRequest({ request: await relayedContactRequest(env, { name: "Rail Viewer", email: "viewer@example.test", topic: "show-media", message: "I would like to ask about an upcoming programme.", consent: true, turnstileToken: "valid-contact" }), env, data: { contactFetch: makeAuthFetch(messages) } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, message: "Your message has been sent to Third Railify." });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].to, ["info@thirdrailify.com"]);
  assert.deepEqual(messages[0].cc, ["thirdmailify@gmail.com"]);
  assert.equal(messages[0].reply_to, "viewer@example.test");
  assert.match(messages[0].subject, /Show and media — Rail Viewer/);
  assert.match(messages[0].text, /upcoming programme/);
  assert.doesNotMatch(messages[0].html, /<script>/i);
});

test("contact delivery fails closed for invalid origin, verification, fields, and method", async (t) => {
  const harness = await createAuthDatabase(); t.after(harness.dispose);
  const env = contactEnvironment(harness.db);
  const fetchImpl = makeAuthFetch([]);
  assert.equal((await onRequest({ request: contactRequest({}, "https://attacker.example"), env, data: { contactFetch: fetchImpl } })).status, 403);
  assert.equal((await onRequest({ request: contactRequest({ turnstileToken: "invalid-contact" }), env, data: { contactFetch: fetchImpl } })).status, 403);
  assert.equal((await onRequest({ request: contactRequest({ message: "short" }), env, data: { contactFetch: fetchImpl } })).status, 400);
  assert.equal((await onRequest({ request: contactRequest({}, "https://thirdrailify.pages.dev", { "X-ThirdRailify-Contact-Rate-Key": "forged", "X-ThirdRailify-Timestamp": String(Math.floor(Date.now() / 1000)), "X-ThirdRailify-Signature": "forged" }), env, data: { contactFetch: fetchImpl } })).status, 401);
  assert.equal((await onRequest({ request: new Request("https://thirdrailify-admin.pages.dev/api/contact", { method: "GET", headers: { Origin: "https://thirdrailify.pages.dev" } }), env })).status, 405);
});

test("contact honeypot returns generic success without Turnstile or Resend traffic", async (t) => {
  const harness = await createAuthDatabase(); t.after(harness.dispose);
  let calls = 0;
  const env = contactEnvironment(harness.db);
  const response = await onRequest({ request: contactRequest({ website: "spam.example", turnstileToken: "" }), env, data: { contactFetch: async () => { calls += 1; throw new Error("unexpected"); } } });
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
});

function contactEnvironment(db) {
  return authEnvironment(db, { CONTACT_TO_EMAIL: "info@thirdrailify.com", CONTACT_CC_EMAIL: "thirdmailify@gmail.com", THIRDRAILIFY_COMMUNITY_API_SECRET: "contact-signing-fixture" });
}

async function relayedContactRequest(env, overrides = {}) {
  const rateKey = "a".repeat(64);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await hmacSha256(env.THIRDRAILIFY_COMMUNITY_API_SECRET, `${timestamp}\ncontact\n${rateKey}`);
  return contactRequest(overrides, "https://thirdrailify.pages.dev", { "X-ThirdRailify-Contact-Rate-Key": rateKey, "X-ThirdRailify-Timestamp": timestamp, "X-ThirdRailify-Signature": signature });
}

function contactRequest(overrides = {}, origin = "https://thirdrailify.pages.dev", extraHeaders = {}) {
  return new Request("https://thirdrailify-admin.pages.dev/api/contact", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...extraHeaders }, body: JSON.stringify({ name: "Rail Viewer", email: "viewer@example.test", topic: "general", message: "This is a complete fixture contact message for Third Railify.", website: "", consent: true, turnstileToken: "valid-contact", ...overrides }) });
}
