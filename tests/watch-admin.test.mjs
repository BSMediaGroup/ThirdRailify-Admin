import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { onRequest as authRequest } from "../functions/api/auth/[[path]].js";
import { callPublicWatch, configuredPublicOrigin, onRequest as watchRequest } from "../functions/api/admin/watch.js";
import { createSession } from "../functions/_shared/auth-core.js";
import { authEnvironment, cookiePair, createAuthDatabase, jsonRequest, makeAuthFetch } from "./auth-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const PUBLIC_ORIGIN = "https://thirdrailify.pages.dev";
const SHARED_SECRET = "test-only-shared-watch-secret";
const EPISODE_ID = `ep_${"a".repeat(64)}`;

test("Watch Admin gives Full Admin default view parity and requires exact origin, CSRF, and valid actions", async (t) => {
  const harness = await createAuthDatabase(); t.after(harness.dispose);
  const env = authEnvironment(harness.db, { THIRDRAILIFY_COMMUNITY_API_SECRET: SHARED_SECRET });
  const master = await masterSession(env);
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return Response.json(payload()); };

  assert.equal((await callWatch({ action: "read" }, env, {}, fetchImpl)).status, 403);
  assert.equal((await callWatch({ action: "read" }, env, { origin: ADMIN_ORIGIN }, fetchImpl)).status, 401);
  assert.equal((await callWatch({ action: "read" }, env, { origin: ADMIN_ORIGIN, cookie: master.cookie }, fetchImpl)).status, 403);
  assert.equal((await callWatch({ action: "hide", episodeId: "bad" }, env, master, fetchImpl)).status, 400);
  assert.equal(fetches, 0);

  const fullAccount = { id: "full-admin", email_normalized: "full@example.test", display_name: "Full Admin", avatar_url: null, role: "admin", admin_level: "full", status: "active", email_verified_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_login_at: null, source: "test", notes: null };
  await harness.db.prepare("INSERT INTO accounts (id,email_normalized,display_name,avatar_url,role,admin_level,status,email_verified_at,created_at,updated_at,last_login_at,source,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(fullAccount)).run();
  const full = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { "User-Agent": "watch-test" } }), fullAccount, ADMIN_ORIGIN);
  const fullResponse = await callWatch({ action: "read" }, env, { origin: ADMIN_ORIGIN, cookie: cookiePair(full.cookie), csrfToken: full.csrfToken }, fetchImpl);
  assert.equal(fullResponse.status, 200);
  assert.equal((await fullResponse.json()).ok, true);
  assert.equal(fetches, 1);
});

test("Watch Admin signs only server-to-server, performs show/hide and bulk actions, rate-limits, and audits mutations", async (t) => {
  const harness = await createAuthDatabase(); t.after(harness.dispose);
  const env = authEnvironment(harness.db, { THIRDRAILIFY_COMMUNITY_API_SECRET: SHARED_SECRET });
  const master = await masterSession(env);
  const captured = [];
  const fetchImpl = async (input, init) => {
    captured.push({ input: String(input), init });
    const raw = String(init.body || "");
    const headers = new Headers(init.headers);
    const timestamp = headers.get("X-ThirdRailify-Timestamp");
    const digest = createHash("sha256").update(raw).digest("hex");
    const expected = createHmac("sha256", SHARED_SECRET).update(`${timestamp}\n${init.method}\n/api/watch/manage\n${digest}`).digest("base64url");
    assert.equal(headers.get("X-ThirdRailify-Signature"), expected);
    assert.equal(headers.has("Origin"), false);
    assert.equal("redirect" in init, false, "Pages cross-subrequest uses the normal fetch redirect mode");
    if (init.method === "GET") {
      assert.equal(init.body, undefined);
      assert.equal(headers.has("Content-Type"), false);
      return Response.json(payload());
    }
    assert.equal(init.method, "POST");
    return Response.json(payload(JSON.parse(raw).action));
  };

  for (const [action, episodeId] of [["read"], ["hide", EPISODE_ID], ["show", EPISODE_ID], ["hide_all"], ["show_all"]]) {
    const response = await callWatch({ action, ...(episodeId ? { episodeId } : {}) }, env, master, fetchImpl);
    assert.equal(response.status, 200);
    assert.equal(JSON.stringify(await response.json()).includes(SHARED_SECRET), false);
  }
  assert.equal(captured.every((entry) => entry.input === `${PUBLIC_ORIGIN}/api/watch/manage`), true);
  const audits = await harness.db.prepare("SELECT event_type, metadata_json FROM auth_audit WHERE event_type LIKE 'watch_archive_%' ORDER BY created_at").all();
  assert.equal(audits.results.length, 4);
  assert.equal(audits.results.some((row) => row.event_type === "watch_archive_hide" && row.metadata_json.includes(EPISODE_ID)), true);
  const rate = await harness.db.prepare("SELECT category, key_hash FROM auth_rate_limits WHERE category = 'watch'").first();
  assert.equal(rate.category, "watch");
  assert.equal(rate.key_hash.includes("unknown"), false);
});

test("Watch upstream handling is bounded, sanitized, and rejects unsafe Public origins", async () => {
  const env = { THIRDRAILIFY_COMMUNITY_API_SECRET: SHARED_SECRET, THIRDRAILIFY_PUBLIC_ORIGIN: PUBLIC_ORIGIN };
  assert.equal(configuredPublicOrigin(env), PUBLIC_ORIGIN);
  for (const origin of ["http://thirdrailify.pages.dev", "https://user@example.test", "https://thirdrailify.pages.dev/path", "https://thirdrailify.pages.dev?x=1", "not-a-url"]) {
    assert.throws(() => configuredPublicOrigin({ THIRDRAILIFY_PUBLIC_ORIGIN: origin }), (error) => error.code === "watch_management_not_configured");
  }
  assert.equal((await callPublicWatch(env, { action: "read" }, async () => Response.json(payload()))).summary.retained, 1);
  for (const status of [401, 403]) {
    await assert.rejects(callPublicWatch(env, { action: "read" }, async () => Response.json({ error: "invalid_signature" }, { status })), (error) => error.status === 502 && error.code === "watch_management_unavailable");
  }
  await assert.rejects(callPublicWatch(env, { action: "read" }, async () => Response.json({ error: "unavailable" }, { status: 503 })), (error) => error.status === 503);
  await assert.rejects(callPublicWatch(env, { action: "read" }, async () => new Response("not-json")), (error) => error.status === 502);
  await assert.rejects(callPublicWatch(env, { action: "read" }, async (_input, init) => { assert.ok(init.signal); throw new DOMException("Aborted", "AbortError"); }), (error) => error.status === 503);
});

async function masterSession(env) {
  const response = await authRequest({
    request: jsonRequest(`${ADMIN_ORIGIN}/api/auth/login`, { origin: ADMIN_ORIGIN, body: { email: env.ADMIN_EMAIL_1, password: env.ADMIN_SECRET_1, turnstileToken: "valid-login" } }),
    env,
    data: { authFetch: makeAuthFetch() },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return { origin: ADMIN_ORIGIN, cookie: cookiePair(response.headers.get("set-cookie")), csrfToken: body.csrfToken };
}

function callWatch(body, env, session, watchFetch) {
  return watchRequest({
    request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/watch`, { method: "POST", origin: session.origin, body, cookie: session.cookie, csrfToken: session.csrfToken }),
    env,
    data: { watchFetch },
  });
}

function payload(action = "read") {
  const visible = !new Set(["hide", "hide_all"]).has(action);
  return {
    ok: true, current: null,
    summary: { retained: 1, visible: visible ? 1 : 0, hidden: visible ? 0 : 1, remaining: 23, newest: null, oldest: null },
    episodes: [{ id: EPISODE_ID, identityKey: "youtube:abc123DEF45", platform: "youtube", contentId: "abc123DEF45", title: "Real episode", description: null, thumbnailUrl: null, thumbnailState: "fallback", watchUrl: "https://www.youtube.com/watch?v=abc123DEF45", archiveDate: "2026-08-28T00:00:00.000Z", visible, archiveOrder: 1, publicRoute: visible ? `${PUBLIC_ORIGIN}/watch/v/${EPISODE_ID}` : null }],
  };
}
