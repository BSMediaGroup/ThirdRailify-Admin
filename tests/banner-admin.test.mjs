import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as authRequest } from "../functions/api/auth/[[path]].js";
import { onRequest as bannerAdminRequest } from "../functions/api/admin/banner.js";
import { onRequestGet as publicBannerRequest } from "../functions/api/banner.js";
import { DEFAULT_BANNER_CONFIG, normalizeBannerConfig, publicBannerProjection, readBannerSettings } from "../functions/_shared/banner-core.js";
import { createSession } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest, makeAuthFetch } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const VALID = {
  normal: { enabled: true, messages: [{ text: "A concise announcement", ctaLabel: "Learn more", href: "/watch", newTab: false }], mode: "ticker", speed: "slow" },
  live: { enabled: true, label: "LIVE NOW", showTitle: true, supportingText: "The rail is active", ctaLabel: "WATCH NOW", animation: "pulse-sweep", intensity: "normal" },
};

test("banner defaults and valid normal/live modes normalize to a bounded safe model", () => {
  assert.deepEqual(normalizeBannerConfig(DEFAULT_BANNER_CONFIG), DEFAULT_BANNER_CONFIG);
  for (const mode of ["static", "ticker", "crossfade"]) assert.equal(normalizeBannerConfig({ ...VALID, normal: { ...VALID.normal, mode } }).normal.mode, mode);
  assert.equal(normalizeBannerConfig(VALID).normal.messages[0].href, "/watch");
});

test("malformed, oversized, unsafe-link, and unsupported banner values are rejected", () => {
  const invalid = [
    { ...VALID, extra: true },
    { ...VALID, normal: { ...VALID.normal, messages: [{ ...VALID.normal.messages[0], text: "x".repeat(161) }] } },
    { ...VALID, normal: { ...VALID.normal, messages: [{ ...VALID.normal.messages[0], href: "javascript:alert(1)" }] } },
    { ...VALID, normal: { ...VALID.normal, messages: [{ ...VALID.normal.messages[0], href: "/api/private" }] } },
    { ...VALID, normal: { ...VALID.normal, mode: "blink" } },
    { ...VALID, live: { ...VALID.live, animation: "flash" } },
    { ...VALID, live: { ...VALID.live, intensity: "extreme" } },
  ];
  for (const value of invalid) assert.throws(() => normalizeBannerConfig(value), (error) => error.status === 400);
});

test("banner mutation enforces Master auth, exact origin, CSRF, validation, persistence, revision checks, rate limit, and audit", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const master = await masterSession(env);

  assert.equal((await callPut(env, {}, VALID, 1)).status, 403);
  assert.equal((await callPut(env, { origin: ADMIN_ORIGIN }, VALID, 1)).status, 401);
  assert.equal((await callPut(env, { ...master, csrfToken: "wrong" }, VALID, 1)).status, 403);
  assert.equal((await callPut(env, { ...master, origin: "https://example.test" }, VALID, 1)).status, 403);

  const fullRow = { id: "full-banner-admin", email_normalized: "full-banner@example.test", display_name: "Full Banner Admin", avatar_url: null, role: "admin", admin_level: "full", status: "active", email_verified_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_login_at: null, source: "test", notes: null };
  await harness.authDb.prepare("INSERT INTO accounts (id,email_normalized,display_name,avatar_url,role,admin_level,status,email_verified_at,created_at,updated_at,last_login_at,source,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(fullRow)).run();
  const fullSession = await createSession(env, new Request(`${ADMIN_ORIGIN}/`), fullRow, ADMIN_ORIGIN);
  const full = { origin: ADMIN_ORIGIN, cookie: cookiePair(fullSession.cookie), csrfToken: fullSession.csrfToken };
  assert.equal((await callPut(env, full, VALID, 1)).status, 403);

  assert.equal((await callPut(env, master, { ...VALID, live: { ...VALID.live, animation: "flash" } }, 1)).status, 400);
  const savedResponse = await callPut(env, master, VALID, 1);
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.revision, 2);
  assert.deepEqual((await readBannerSettings(env)).config, VALID);
  assert.equal((await callPut(env, master, VALID, 1)).status, 409, "stale revision cannot overwrite a newer save");
  const audit = await harness.authDb.prepare("SELECT event_type,result,metadata_json FROM auth_audit WHERE event_type='site_banner_updated'").first();
  assert.equal(audit.result, "success"); assert.match(audit.metadata_json, /revision/);
  assert.equal((await harness.authDb.prepare("SELECT category FROM auth_rate_limits WHERE category='site_content'").first()).category, "site_content");
});

test("Public banner projection is read-only, cacheable, and contains no revision, actor, audit, or privileged fields", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const settings = await readBannerSettings(env);
  const projection = publicBannerProjection(settings);
  assert.equal(projection.live.ctaPath, "/watch/live");
  assert.equal("revision" in projection, false);
  assert.equal(JSON.stringify(projection).includes("updated_by"), false);
  const response = await publicBannerRequest({ request: new Request(`${ADMIN_ORIGIN}/api/banner`), env });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /s-maxage=180/);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload).sort(), ["live", "normal", "ok", "schema", "updatedAt"].sort());
});

async function masterSession(env) {
  const response = await authRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/auth/login`, { origin: ADMIN_ORIGIN, body: { email: env.ADMIN_EMAIL_1, password: env.ADMIN_SECRET_1, turnstileToken: "valid-login" } }), env, data: { authFetch: makeAuthFetch() } });
  const body = await response.json();
  return { origin: ADMIN_ORIGIN, cookie: cookiePair(response.headers.get("set-cookie")), csrfToken: body.csrfToken };
}

function callPut(env, session, config, expectedRevision) {
  return bannerAdminRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/banner`, { method: "PUT", origin: session.origin, cookie: session.cookie, csrfToken: session.csrfToken, body: { config, expectedRevision } }), env });
}
