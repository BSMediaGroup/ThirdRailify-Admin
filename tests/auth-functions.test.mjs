import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as authRequest } from "../functions/api/auth/[[path]].js";
import { onRequest as accountsRequest } from "../functions/api/admin/accounts/[[path]].js";
import {
  AuthFailure,
  consumeHandoff,
  createSession,
  enforceRateLimit,
  hashPassword,
  loadAccountByEmail,
  resolveSession,
  verifyPassword,
  verifyTurnstile,
} from "../functions/_shared/auth-core.js";
import {
  authEnvironment,
  cookiePair,
  createAuthDatabase,
  jsonRequest,
  makeAuthFetch,
} from "./auth-test-helpers.mjs";

const PUBLIC_ORIGIN = "https://thirdrailify.pages.dev";
const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";

test("PBKDF2 credentials use unique salts and reject wrong passwords", async () => {
  const first = await hashPassword("long-test-password-one");
  const second = await hashPassword("long-test-password-one");
  assert.equal(first.algorithm, "pbkdf2-sha256-v1");
  assert.equal(first.workFactor, 120_000);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.passwordHash, "long-test-password-one");
  assert.equal(await verifyPassword("long-test-password-one", first), true);
  assert.equal(await verifyPassword("wrong-test-password", first), false);
});

test("Turnstile validation requires success, the expected action, hostname, and configuration", async () => {
  const request = new Request(`${ADMIN_ORIGIN}/api/auth/login`, {
    headers: { Origin: ADMIN_ORIGIN, "CF-Connecting-IP": "192.0.2.1" },
  });
  const env = authEnvironment({ prepare() {} });
  await verifyTurnstile(env, request, "valid-login", "thirdrailify-login", async () =>
    Response.json({ success: true, action: "thirdrailify-login", hostname: "thirdrailify-admin.pages.dev", "error-codes": [] }),
  );
  await assert.rejects(
    verifyTurnstile(env, request, "valid-login", "thirdrailify-signup", async () =>
      Response.json({ success: true, action: "thirdrailify-login", hostname: "thirdrailify-admin.pages.dev", "error-codes": [] }),
    ),
    (error) => error instanceof AuthFailure && error.code === "turnstile_invalid",
  );
  await assert.rejects(
    verifyTurnstile(env, request, "valid-login", "thirdrailify-login", async () =>
      Response.json({ success: true, action: "thirdrailify-login", hostname: "attacker.example", "error-codes": [] }),
    ),
    (error) => error instanceof AuthFailure && error.code === "turnstile_invalid",
  );
  await assert.rejects(
    verifyTurnstile({ ...env, THIRDRAILIFY_TURNSTILE_SECRET_KEY: "" }, request, "valid-login", "thirdrailify-login"),
    (error) => error instanceof AuthFailure && error.code === "turnstile_not_configured",
  );
});

test("auth API covers masters, signup, verification, reset, OAuth, handoff, and Admin account controls", async (t) => {
  const harness = await createAuthDatabase();
  t.after(harness.dispose);
  const env = authEnvironment(harness.db);
  const emails = [];
  const authFetch = makeAuthFetch(emails);

  const configResponse = await callAuth("config", { method: "GET", origin: PUBLIC_ORIGIN }, env, authFetch);
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.configured, true);
  assert.deepEqual(config.oauthProviders.map((provider) => provider.id), ["discord", "google", "github", "twitter"]);
  assert.equal(JSON.stringify(config).includes("SECRET"), false);

  const masterLogin = await callAuth(
    "login",
    {
      origin: ADMIN_ORIGIN,
      body: {
        email: env.ADMIN_EMAIL_1,
        password: env.ADMIN_SECRET_1,
        turnstileToken: "valid-login",
        returnTo: "/access",
      },
    },
    env,
    authFetch,
  );
  assert.equal(masterLogin.status, 200);
  const masterPayload = await masterLogin.json();
  const masterCookie = cookiePair(masterLogin.headers.get("set-cookie"));
  assert.equal(masterPayload.account.id, "env-master-1");
  assert.equal(masterPayload.account.adminLevel, "master");
  assert.equal(masterPayload.account.locked, true);
  assert.ok(masterPayload.csrfToken);
  assert.equal(JSON.stringify(masterPayload).includes(env.ADMIN_SECRET_1), false);

  const wrongMaster = await callAuth(
    "login",
    {
      origin: ADMIN_ORIGIN,
      body: { email: env.ADMIN_EMAIL_1, password: "wrong-master-secret", turnstileToken: "valid-login" },
    },
    env,
    authFetch,
  );
  assert.equal(wrongMaster.status, 401);
  assert.equal((await wrongMaster.json()).error, "invalid_credentials");

  const signup = await callAuth(
    "signup",
    {
      origin: PUBLIC_ORIGIN,
      body: {
        email: "email-user@example.test",
        displayName: "Email User",
        password: "durable-test-password",
        turnstileToken: "valid-signup",
        returnTo: "/account",
      },
    },
    env,
    authFetch,
  );
  assert.equal(signup.status, 202);
  assert.equal(emails.length, 1);
  const pendingAccount = await loadAccountByEmail(env, "email-user@example.test");
  assert.equal(pendingAccount.status, "pending_email");
  const storedCredential = await harness.db
    .prepare("SELECT password_hash, salt FROM password_credentials WHERE account_id = ?")
    .bind(pendingAccount.id)
    .first();
  assert.notEqual(storedCredential.password_hash, "durable-test-password");
  assert.ok(storedCredential.salt);

  const duplicateSignup = await callAuth(
    "signup",
    {
      origin: PUBLIC_ORIGIN,
      body: {
        email: "email-user@example.test",
        displayName: "Different Name",
        password: "another-test-password",
        turnstileToken: "valid-signup",
      },
    },
    env,
    authFetch,
  );
  assert.equal(duplicateSignup.status, 202);
  assert.equal((await duplicateSignup.json()).message, (await signup.clone().json()).message);

  const verificationUrl = firstUrl(emails[0].text);
  const verification = await authRequest({
    request: new Request(verificationUrl),
    env,
    data: { authFetch },
  });
  assert.equal(verification.status, 302);
  const verifiedAccount = await loadAccountByEmail(env, "email-user@example.test");
  assert.equal(verifiedAccount.status, "active");
  assert.ok(verifiedAccount.email_verified_at);
  const handoffUrl = new URL(verification.headers.get("location"));
  const handoffCode = handoffUrl.searchParams.get("handoff");
  const publicSessionRequest = jsonRequest(`${PUBLIC_ORIGIN}/api/auth/handoff`, { origin: PUBLIC_ORIGIN, body: { code: handoffCode } });
  const publicSession = await consumeHandoff(env, publicSessionRequest, handoffCode, PUBLIC_ORIGIN);
  assert.equal(publicSession.account.id, verifiedAccount.id);
  assert.match(publicSession.cookie, /HttpOnly/);
  assert.doesNotMatch(publicSession.cookie, /Domain=/);
  await assert.rejects(consumeHandoff(env, publicSessionRequest, handoffCode, PUBLIC_ORIGIN), /invalid or expired/i);

  const forgot = await callAuth(
    "password/forgot",
    {
      origin: PUBLIC_ORIGIN,
      body: { email: "email-user@example.test", turnstileToken: "valid-password-reset", returnTo: "/account" },
    },
    env,
    authFetch,
  );
  assert.equal(forgot.status, 200);
  assert.equal(emails.length, 2);
  const resetUrl = new URL(firstUrl(emails[1].text));
  const reset = await callAuth(
    "password/reset",
    {
      origin: PUBLIC_ORIGIN,
      body: {
        token: resetUrl.searchParams.get("reset"),
        password: "replacement-test-password",
        turnstileToken: "valid-password-reset",
      },
    },
    env,
    authFetch,
  );
  assert.equal(reset.status, 200);
  assert.ok((await reset.json()).handoffCode);
  const revokedAfterReset = await harness.db
    .prepare("SELECT revoked_at FROM sessions WHERE id = ?")
    .bind(publicSession.session.id)
    .first();
  assert.ok(revokedAfterReset.revoked_at);

  const oldPassword = await callAuth(
    "login",
    {
      origin: PUBLIC_ORIGIN,
      body: { email: "email-user@example.test", password: "durable-test-password", turnstileToken: "valid-login" },
    },
    env,
    authFetch,
  );
  assert.equal(oldPassword.status, 401);
  const newPassword = await callAuth(
    "login",
    {
      origin: PUBLIC_ORIGIN,
      body: { email: "email-user@example.test", password: "replacement-test-password", turnstileToken: "valid-login" },
    },
    env,
    authFetch,
  );
  assert.equal(newPassword.status, 200);
  assert.ok((await newPassword.json()).handoffCode);

  const oauthStart = await callAuth(
    "oauth/github/start",
    { origin: PUBLIC_ORIGIN, body: { turnstileToken: "valid-oauth", returnTo: "/community" } },
    env,
    authFetch,
  );
  assert.equal(oauthStart.status, 200);
  const authorizeUrl = new URL((await oauthStart.json()).authorizationUrl);
  assert.equal(authorizeUrl.origin, "https://github.com");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  const oauthCallback = await authRequest({
    request: new Request(`${ADMIN_ORIGIN}/api/auth/oauth/github/callback?code=test-code&state=${encodeURIComponent(authorizeUrl.searchParams.get("state"))}`),
    env,
    data: { authFetch },
  });
  assert.equal(oauthCallback.status, 302);
  const oauthAccount = await loadAccountByEmail(env, "oauth-user@example.test");
  assert.equal(oauthAccount.role, "user");
  assert.equal(oauthAccount.admin_level, "none");
  const oauthIdentity = await harness.db
    .prepare("SELECT provider_subject, provider_email_verified FROM auth_identities WHERE account_id = ?")
    .bind(oauthAccount.id)
    .first();
  assert.equal(oauthIdentity.provider_subject, "4242");
  assert.equal(oauthIdentity.provider_email_verified, 1);

  const adminOauthStart = await callAuth(
    "oauth/github/start",
    { origin: ADMIN_ORIGIN, body: { turnstileToken: "valid-oauth", returnTo: "/access" } },
    env,
    authFetch,
  );
  const adminAuthorizeUrl = new URL((await adminOauthStart.json()).authorizationUrl);
  const cancelledAdminOauth = await authRequest({
    request: new Request(
      `${ADMIN_ORIGIN}/api/auth/oauth/github/callback?error=access_denied&state=${encodeURIComponent(adminAuthorizeUrl.searchParams.get("state"))}`,
    ),
    env,
    data: { authFetch },
  });
  assert.equal(cancelledAdminOauth.status, 302);
  assert.equal(cancelledAdminOauth.headers.get("location"), `${ADMIN_ORIGIN}/?auth_error=oauth_failed`);

  const pendingPromotion = await callAccounts(
    `${encodeURIComponent(pendingAccount.id)}/promote`,
    { method: "POST", origin: ADMIN_ORIGIN, cookie: masterCookie, csrfToken: masterPayload.csrfToken },
    env,
  );
  assert.equal(pendingPromotion.status, 200, "verified email account can be promoted after verification");

  const promoteOauth = await callAccounts(
    `${encodeURIComponent(oauthAccount.id)}/promote`,
    { method: "POST", origin: ADMIN_ORIGIN, cookie: masterCookie, csrfToken: masterPayload.csrfToken },
    env,
  );
  assert.equal(promoteOauth.status, 200);
  assert.equal((await loadAccountByEmail(env, "oauth-user@example.test")).admin_level, "full");

  const oauthAdminSession = await createSession(
    env,
    new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }),
    await loadAccountByEmail(env, "oauth-user@example.test"),
    ADMIN_ORIGIN,
  );
  const oauthAdminCookie = cookiePair(oauthAdminSession.cookie);
  const fullAdminList = await callAccounts("", { method: "GET", cookie: oauthAdminCookie }, env);
  assert.equal(fullAdminList.status, 200);
  const forbiddenMutation = await callAccounts(
    `${encodeURIComponent(verifiedAccount.id)}/disable`,
    { method: "POST", origin: ADMIN_ORIGIN, cookie: oauthAdminCookie, csrfToken: oauthAdminSession.csrfToken },
    env,
  );
  assert.equal(forbiddenMutation.status, 403);

  const lockedMaster = await callAccounts(
    "env-master-1/demote",
    { method: "POST", origin: ADMIN_ORIGIN, cookie: masterCookie, csrfToken: masterPayload.csrfToken },
    env,
  );
  assert.equal(lockedMaster.status, 409);

  const demoteOauth = await callAccounts(
    `${encodeURIComponent(oauthAccount.id)}/demote`,
    { method: "POST", origin: ADMIN_ORIGIN, cookie: masterCookie, csrfToken: masterPayload.csrfToken },
    env,
  );
  assert.equal(demoteOauth.status, 200);
  assert.equal(await resolveSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Cookie: oauthAdminCookie } })), null);

  const auditCount = await harness.db.prepare("SELECT COUNT(*) AS count FROM auth_audit").first();
  assert.ok(Number(auditCount.count) >= 8);
  const leakedSecrets = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM auth_audit WHERE metadata_json LIKE ? OR metadata_json LIKE ?")
    .bind(`%${env.ADMIN_SECRET_1}%`, "%temporary-github-access-token%")
    .first();
  assert.equal(Number(leakedSecrets.count), 0);
});

test("D1-backed rate limiting stores only hashed composite keys and blocks bounded attempts", async (t) => {
  const harness = await createAuthDatabase();
  t.after(harness.dispose);
  const env = authEnvironment(harness.db);
  const request = new Request(`${ADMIN_ORIGIN}/api/auth/login`, {
    headers: { Origin: ADMIN_ORIGIN, "CF-Connecting-IP": "198.51.100.23" },
  });
  for (let index = 0; index < 8; index += 1) await enforceRateLimit(env, request, "login", "rate-user@example.test");
  await assert.rejects(
    enforceRateLimit(env, request, "login", "rate-user@example.test"),
    (error) => error instanceof AuthFailure && error.status === 429,
  );
  const row = await harness.db.prepare("SELECT key_hash FROM auth_rate_limits WHERE category = 'login'").first();
  assert.ok(row.key_hash);
  assert.equal(row.key_hash.includes("198.51.100.23"), false);
  assert.equal(row.key_hash.includes("rate-user@example.test"), false);
});

async function callAuth(path, options, env, authFetch) {
  const request = jsonRequest(`${ADMIN_ORIGIN}/api/auth/${path}`, options);
  return authRequest({ request, env, data: { authFetch } });
}

async function callAccounts(path, options, env) {
  const suffix = path ? `/${path}` : "";
  return accountsRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/accounts${suffix}`, options), env, data: {} });
}

function firstUrl(text) {
  const match = String(text || "").match(/https:\/\/[^\s]+/);
  assert.ok(match, "email contains an HTTPS action link");
  return match[0];
}
