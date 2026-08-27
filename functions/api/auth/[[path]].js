import {
  AuthFailure,
  EMAIL_TOKEN_TTL_SECONDS,
  RESET_TOKEN_TTL_SECONDS,
  authenticateEnvironmentMaster,
  burnPasswordAttempt,
  clearSessionCookie,
  cleanText,
  configuredOrigins,
  consumeHandoff,
  consumeOAuthTransaction,
  consumeOneTimeToken,
  corsHeaders,
  createHandoff,
  createOneTimeToken,
  createSession,
  enforceRateLimit,
  ensureEnvironmentMasters,
  environmentMasters,
  errorResponse,
  escapeHtml,
  hashPassword,
  isAuthDbConfigured,
  isEnvironmentMasterId,
  jsonResponse,
  loadAccountByEmail,
  loadAccountById,
  loadPasswordCredential,
  normalizeEmail,
  normalizeOrigin,
  nowIso,
  randomId,
  readJsonBody,
  requireAllowedOrigin,
  requireAuthDb,
  requireCsrf,
  requireSession,
  resolveSession,
  revokeSession,
  safeReturnPath,
  sendAccountEmail,
  serializeAccount,
  sessionEnvelope,
  verifyPassword,
  verifyTurnstile,
  writeAudit,
} from "../../_shared/auth-core.js";
import {
  configuredOAuthProviders,
  exchangeOAuthCode,
  fetchOAuthIdentity,
  knownProvider,
  oauthProviderConfig,
  oauthProviderStates,
  registerOAuthIdentity,
  startOAuth,
} from "../../_shared/oauth-providers.js";
import { updateAvatar } from "../../_shared/profile-media.js";

const ROUTE_PREFIX = "/api/auth";

export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
  const fetchImpl = context.data?.authFetch || fetch;
  try {
    if (request.method === "OPTIONS") return handleOptions(request, env);
    const path = new URL(request.url).pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, "");

    if (request.method === "GET" && path === "config") return handleConfig(request, env);
    if (request.method === "GET" && path === "session") return await handleSession(request, env);
    if (request.method === "GET" && path === "email/verify") return await handleEmailVerification(request, env);

    const callbackMatch = path.match(/^oauth\/(discord|google|github|twitter)\/callback$/);
    if (request.method === "GET" && callbackMatch) {
      return await handleOAuthCallback(request, env, callbackMatch[1], fetchImpl);
    }

    if (request.method !== "POST") {
      throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: allowedMethods(path) });
    }

    if (path === "login") return await handleLogin(request, env, fetchImpl);
    if (path === "signup") return await handleSignup(request, env, fetchImpl);
    if (path === "logout") return await handleLogout(request, env);
    if (path === "handoff") return await handleHandoff(request, env);
    if (path === "profile") return await handleProfileUpdate(request, env);
    if (path === "avatar") {
      requireAllowedOrigin(request, env);
      return jsonResponse(await updateAvatar(request, env, fetchImpl), { headers: corsHeaders(request, env) });
    }
    if (path === "email/resend") return await handleVerificationResend(request, env, fetchImpl);
    if (path === "password/forgot") return await handlePasswordForgot(request, env, fetchImpl);
    if (path === "password/reset") return await handlePasswordReset(request, env, fetchImpl);

    const startMatch = path.match(/^oauth\/(discord|google|github|twitter)\/start$/);
    if (startMatch) return await handleOAuthStart(request, env, startMatch[1], fetchImpl);

    throw new AuthFailure(404, "not_found", "The auth route was not found.");
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

function handleOptions(request, env) {
  requireAllowedOrigin(request, env);
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request, env),
      "Access-Control-Allow-Headers": "content-type,x-csrf-token",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin",
    },
  });
}

function handleConfig(request, env) {
  const origin = request.headers.get("origin");
  if (origin) requireAllowedOrigin(request, env);
  const publicOrigin = normalizeOrigin(env?.THIRDRAILIFY_PUBLIC_ORIGIN);
  const adminOrigin = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
  const d1Configured = isAuthDbConfigured(env);
  const turnstileConfigured = Boolean(env?.THIRDRAILIFY_TURNSTILE_SITE_KEY && env?.THIRDRAILIFY_TURNSTILE_SECRET_KEY);
  const rateLimitConfigured = Boolean(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET);
  const resendConfigured = Boolean(env?.RESEND_API_KEY && env?.MAIL_FROM);
  const providers = configuredOAuthProviders(env);
  return jsonResponse(
    {
      ok: true,
      configured: Boolean(d1Configured && turnstileConfigured && rateLimitConfigured && publicOrigin && adminOrigin),
      emailSignupConfigured: Boolean(d1Configured && turnstileConfigured && rateLimitConfigured && resendConfigured),
      turnstileSiteKey: turnstileConfigured ? String(env.THIRDRAILIFY_TURNSTILE_SITE_KEY) : null,
      oauthProviders: providers,
      oauthProviderStates: oauthProviderStates(env),
      publicOrigin: publicOrigin || null,
      adminOrigin: adminOrigin || null,
      environment: String(env?.AUTH_ENVIRONMENT || "unconfigured"),
      cookieMode: env?.THIRDRAILIFY_AUTH_COOKIE_DOMAIN === ".thirdrailify.com" ? "shared-domain" : "host-only",
    },
    { headers: corsHeaders(request, env) },
  );
}

async function handleSession(request, env) {
  const origin = request.headers.get("origin");
  if (origin) requireAllowedOrigin(request, env);
  const session = await resolveSession(env, request);
  return jsonResponse(await sessionEnvelope(env, session), { headers: corsHeaders(request, env) });
}

async function handleProfileUpdate(request, env) {
  requireAllowedOrigin(request, env);
  const session = await requireSession(env, request);
  await requireCsrf(request, session);
  await enforceRateLimit(env, request, "profile", session.accountId);
  const body = await readJsonBody(request);
  const displayName = cleanText(body.displayName, 81);
  if (displayName.length < 2 || displayName.length > 80) {
    throw new AuthFailure(400, "display_name_invalid", "Enter a display name between 2 and 80 characters.");
  }

  const timestamp = nowIso();
  const result = await requireAuthDb(env)
    .prepare("UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ? AND status = 'active'")
    .bind(displayName, timestamp, session.accountId)
    .run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw new AuthFailure(409, "account_unavailable", "This account cannot update its display name.");
  }
  await writeAudit(env, {
    actorAccountId: session.accountId,
    targetAccountId: session.accountId,
    eventType: "profile_display_name_updated",
    result: "success",
  });
  const account = await serializeAccount(env, await loadAccountById(env, session.accountId));
  return jsonResponse(await sessionEnvelope(env, { ...session, account }), { headers: corsHeaders(request, env) });
}

async function handleLogin(request, env, fetchImpl) {
  const origin = requireAllowedOrigin(request, env);
  const body = await readJsonBody(request);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  await enforceRateLimit(env, request, "login", email || "invalid-email");
  await verifyTurnstile(env, request, body.turnstileToken, "thirdrailify-login", fetchImpl);

  let account = null;
  let failureCategory = "credentials_invalid";
  if (email && password.length <= 256) {
    account = await authenticateEnvironmentMaster(env, email, password);
    if (!account) {
      const candidate = await loadAccountByEmail(env, email);
      const credential = candidate ? await loadPasswordCredential(env, candidate.id) : null;
      const passwordValid = credential ? await verifyPassword(password, credential) : (await burnPasswordAttempt(password), false);
      if (candidate?.status === "pending_email") failureCategory = "email_unverified";
      else if (candidate?.status === "disabled") failureCategory = "account_disabled";
      if (candidate && passwordValid && candidate.status === "active" && candidate.email_verified_at) account = candidate;
    }
  } else {
    await burnPasswordAttempt(password);
  }

  if (!account) {
    await safeAudit(env, { eventType: "login", result: "failure", metadata: { category: failureCategory } });
    throw new AuthFailure(401, "invalid_credentials", "Email or password is incorrect, or the account is not available.");
  }

  const response = await completeLogin(request, env, account, origin, body.returnTo);
  await safeAudit(env, { eventType: "login", result: "success", targetAccountId: account.id });
  return response;
}

async function handleSignup(request, env, fetchImpl) {
  const origin = requireAllowedOrigin(request, env);
  const body = await readJsonBody(request);
  const email = normalizeEmail(body.email);
  const displayName = String(body.displayName || "").replace(/\s+/g, " ").trim().slice(0, 80);
  await enforceRateLimit(env, request, "signup", email || "invalid-email");
  await verifyTurnstile(env, request, body.turnstileToken, "thirdrailify-signup", fetchImpl);
  ensureEmailDeliveryConfigured(env);
  if (!email || displayName.length < 2) {
    throw new AuthFailure(400, "signup_invalid", "Enter a valid email address and display name.");
  }

  await ensureEnvironmentMasters(env);
  const existing = await loadAccountByEmail(env, email);
  if (existing || environmentMasters(env).some((master) => master.email === email)) {
    return genericVerificationResponse(request, env);
  }

  const credential = await hashPassword(body.password);
  const db = requireAuthDb(env);
  const accountId = randomId();
  const timestamp = nowIso();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO accounts (
             id, email_normalized, display_name, avatar_url, role, admin_level, status,
             email_verified_at, created_at, updated_at, last_login_at, source, notes
           ) VALUES (?, ?, ?, NULL, 'user', 'none', 'pending_email', NULL, ?, ?, NULL, 'email', NULL)`,
        )
        .bind(accountId, email, displayName, timestamp, timestamp),
      db
        .prepare(
          `INSERT INTO password_credentials (
             account_id, algorithm, work_factor, salt, password_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          accountId,
          credential.algorithm,
          credential.workFactor,
          credential.salt,
          credential.passwordHash,
          timestamp,
          timestamp,
        ),
    ]);
  } catch {
    return genericVerificationResponse(request, env);
  }

  const verificationToken = await createOneTimeToken(
    env,
    "email_verification_tokens",
    accountId,
    origin,
    body.returnTo,
    EMAIL_TOKEN_TTL_SECONDS,
  );
  await sendVerificationEmail(env, { email, displayName, token: verificationToken }, fetchImpl);
  await safeAudit(env, { eventType: "signup", result: "pending_email", targetAccountId: accountId });
  return genericVerificationResponse(request, env);
}

async function handleVerificationResend(request, env, fetchImpl) {
  const origin = requireAllowedOrigin(request, env);
  const body = await readJsonBody(request);
  const email = normalizeEmail(body.email);
  await enforceRateLimit(env, request, "resend", email || "invalid-email");
  await verifyTurnstile(env, request, body.turnstileToken, "thirdrailify-signup", fetchImpl);
  ensureEmailDeliveryConfigured(env);
  const account = email ? await loadAccountByEmail(env, email) : null;
  if (account?.status === "pending_email" && account.email_normalized && !isEnvironmentMasterId(env, account.id)) {
    const token = await createOneTimeToken(
      env,
      "email_verification_tokens",
      account.id,
      origin,
      body.returnTo,
      EMAIL_TOKEN_TTL_SECONDS,
    );
    await sendVerificationEmail(env, { email: account.email_normalized, displayName: account.display_name, token }, fetchImpl);
  }
  return genericVerificationResponse(request, env);
}

async function handleEmailVerification(request, env) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const record = await consumeOneTimeToken(env, "email_verification_tokens", token);
  const db = requireAuthDb(env);
  const timestamp = nowIso();
  await db
    .prepare(
      `UPDATE accounts SET status = 'active', email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
       WHERE id = ? AND status = 'pending_email'`,
    )
    .bind(timestamp, timestamp, record.account_id)
    .run();
  const account = await loadAccountById(env, record.account_id);
  if (!account || account.status !== "active") throw new AuthFailure(400, "verification_failed", "The account could not be verified.");
  const handoff = await createHandoff(env, account.id, record.target_origin, record.return_to);
  await safeAudit(env, { eventType: "email_verified", result: "success", targetAccountId: account.id });
  return handoffRedirect(env, handoff);
}

async function handlePasswordForgot(request, env, fetchImpl) {
  const origin = requireAllowedOrigin(request, env);
  const body = await readJsonBody(request);
  const email = normalizeEmail(body.email);
  await enforceRateLimit(env, request, "forgot", email || "invalid-email");
  await verifyTurnstile(env, request, body.turnstileToken, "thirdrailify-password-reset", fetchImpl);
  ensureEmailDeliveryConfigured(env);
  const account = email ? await loadAccountByEmail(env, email) : null;
  if (account?.status === "active" && !isEnvironmentMasterId(env, account.id) && (await loadPasswordCredential(env, account.id))) {
    const token = await createOneTimeToken(
      env,
      "password_reset_tokens",
      account.id,
      origin,
      body.returnTo,
      RESET_TOKEN_TTL_SECONDS,
    );
    await sendResetEmail(env, { email: account.email_normalized, displayName: account.display_name, token, targetOrigin: origin }, fetchImpl);
  }
  return jsonResponse(
    { ok: true, message: "If an eligible account exists, a password-reset email has been sent." },
    { headers: corsHeaders(request, env) },
  );
}

async function handlePasswordReset(request, env, fetchImpl) {
  const origin = requireAllowedOrigin(request, env);
  const body = await readJsonBody(request);
  await enforceRateLimit(env, request, "forgot", "reset-token");
  await verifyTurnstile(env, request, body.turnstileToken, "thirdrailify-password-reset", fetchImpl);
  const credential = await hashPassword(body.password);
  const record = await consumeOneTimeToken(env, "password_reset_tokens", body.token, origin);
  const account = await loadAccountById(env, record.account_id);
  if (!account || account.status !== "active" || isEnvironmentMasterId(env, account.id)) {
    throw new AuthFailure(400, "token_invalid", "This password-reset link is invalid or expired.");
  }
  const timestamp = nowIso();
  await requireAuthDb(env).batch([
    requireAuthDb(env)
      .prepare(
        `UPDATE password_credentials SET
           algorithm = ?, work_factor = ?, salt = ?, password_hash = ?, updated_at = ?
         WHERE account_id = ?`,
      )
      .bind(credential.algorithm, credential.workFactor, credential.salt, credential.passwordHash, timestamp, account.id),
    requireAuthDb(env)
      .prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id = ?")
      .bind(timestamp, account.id),
  ]);
  await safeAudit(env, { eventType: "password_reset", result: "success", targetAccountId: account.id });
  return completeLogin(request, env, account, origin, record.return_to);
}

async function handleOAuthStart(request, env, provider, fetchImpl) {
  const origin = requireAllowedOrigin(request, env);
  oauthProviderConfig(env, provider);
  const body = await readJsonBody(request);
  await enforceRateLimit(env, request, "oauth", provider);
  await verifyTurnstile(env, request, body.turnstileToken, "thirdrailify-oauth", fetchImpl);
  const authorizationUrl = await startOAuth(env, provider, origin, body.returnTo);
  return jsonResponse({ ok: true, provider, authorizationUrl }, { headers: corsHeaders(request, env) });
}

async function handleOAuthCallback(request, env, provider, fetchImpl) {
  if (!knownProvider(provider)) throw new AuthFailure(404, "oauth_provider_unknown", "That OAuth provider is not supported.");
  oauthProviderConfig(env, provider);
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const transaction = await consumeOAuthTransaction(env, provider, state);
  try {
    const code = url.searchParams.get("code") || "";
    if (!code || url.searchParams.get("error")) throw new AuthFailure(400, "oauth_cancelled", "OAuth sign-in was not completed.");
    const accessToken = await exchangeOAuthCode(env, provider, code, transaction, fetchImpl);
    const identity = await fetchOAuthIdentity(env, provider, accessToken, fetchImpl);
    const account = await registerOAuthIdentity(env, identity);
    if (account.status !== "active") throw new AuthFailure(403, "account_disabled", "This account is disabled.");
    const adminOrigin = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
    if (transaction.target_origin === adminOrigin) {
      const created = await createSession(env, request, account, transaction.target_origin);
      return redirectResponse(new URL(safeReturnPath(transaction.return_to, "/"), transaction.target_origin).toString(), {
        "Set-Cookie": created.cookie,
      });
    }
    return handoffRedirect(env, await createHandoff(env, account.id, transaction.target_origin, transaction.return_to));
  } catch (error) {
    await safeAudit(env, { eventType: "oauth_login", provider, result: "failure", metadata: { category: error?.code || "provider_error" } });
    const target = configuredOrigins(env).has(transaction.target_origin)
      ? transaction.target_origin
      : normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
    const adminOrigin = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
    const redirect = new URL(target === adminOrigin ? "/" : "/account/login", target);
    redirect.searchParams.set("auth_error", "oauth_failed");
    return redirectResponse(redirect.toString());
  }
}

async function handleHandoff(request, env) {
  const origin = requireAllowedOrigin(request, env);
  if (origin !== normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN)) {
    throw new AuthFailure(403, "origin_not_allowed", "Public handoffs must be exchanged on the Public origin.");
  }
  const body = await readJsonBody(request);
  await enforceRateLimit(env, request, "handoff", String(body.code || "").slice(0, 24));
  const created = await consumeHandoff(env, request, body.code, origin);
  const headers = { ...corsHeaders(request, env), "Set-Cookie": created.cookie };
  return jsonResponse(
    { ...(await sessionEnvelope(env, { ...created.session, account: created.account }, created.csrfToken)), returnTo: created.returnTo },
    { headers },
  );
}

async function handleLogout(request, env) {
  requireAllowedOrigin(request, env);
  const session = await resolveSession(env, request);
  if (session) {
    await requireCsrf(request, session);
    await revokeSession(env, session.id);
    await safeAudit(env, { eventType: "logout", result: "success", actorAccountId: session.accountId });
  }
  return jsonResponse(
    { ok: true, authenticated: false, account: null, access: { isAdmin: false, isMasterAdmin: false } },
    { headers: { ...corsHeaders(request, env), "Set-Cookie": clearSessionCookie(request, env) } },
  );
}

async function completeLogin(request, env, accountRow, origin, returnTo) {
  const account = await loadAccountById(env, accountRow.id);
  if (!account || account.status !== "active") throw new AuthFailure(403, "account_unavailable", "This account cannot create a session.");
  const adminOrigin = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
  if (origin !== adminOrigin) {
    const handoff = await createHandoff(env, account.id, origin, returnTo);
    return jsonResponse(
      { ok: true, handoffCode: handoff.code, returnTo: handoff.returnTo },
      { headers: corsHeaders(request, env) },
    );
  }
  const created = await createSession(env, request, account, origin);
  return jsonResponse(
    await sessionEnvelope(env, { ...created.session, account: created.account }, created.csrfToken),
    { headers: { ...corsHeaders(request, env), "Set-Cookie": created.cookie } },
  );
}

function genericVerificationResponse(request, env) {
  return jsonResponse(
    { ok: true, verificationPending: true, message: "If the account can be created, check your email for a verification link." },
    { status: 202, headers: corsHeaders(request, env) },
  );
}

function ensureEmailDeliveryConfigured(env) {
  if (!env?.RESEND_API_KEY || !env?.MAIL_FROM) {
    throw new AuthFailure(503, "email_not_configured", "Account email delivery is not configured.");
  }
}

async function sendVerificationEmail(env, account, fetchImpl) {
  const adminOrigin = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
  const link = new URL("/api/auth/email/verify", adminOrigin);
  link.searchParams.set("token", account.token);
  const name = escapeHtml(account.displayName || "there");
  const safeLink = escapeHtml(link.toString());
  await sendAccountEmail(
    env,
    {
      to: account.email,
      subject: "Verify your Third Railify account",
      html: `<p>Hi ${name},</p><p>Verify your Third Railify account:</p><p><a href="${safeLink}">Verify account</a></p><p>This one-time link expires in 24 hours.</p>`,
      text: `Hi ${account.displayName || "there"},\n\nVerify your Third Railify account:\n${link}\n\nThis one-time link expires in 24 hours.`,
    },
    fetchImpl,
  );
}

async function sendResetEmail(env, account, fetchImpl) {
  const adminOrigin = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
  const link = new URL(account.targetOrigin === adminOrigin ? "/" : "/account/login", account.targetOrigin);
  link.searchParams.set("reset", account.token);
  const name = escapeHtml(account.displayName || "there");
  const safeLink = escapeHtml(link.toString());
  await sendAccountEmail(
    env,
    {
      to: account.email,
      subject: "Reset your Third Railify password",
      html: `<p>Hi ${name},</p><p>Use this one-time link to reset your Third Railify password:</p><p><a href="${safeLink}">Reset password</a></p><p>This link expires in 30 minutes. Ignore this email if you did not request it.</p>`,
      text: `Hi ${account.displayName || "there"},\n\nReset your Third Railify password:\n${link}\n\nThis one-time link expires in 30 minutes.`,
    },
    fetchImpl,
  );
}

function handoffRedirect(env, handoff) {
  const adminOrigin = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
  const path = handoff.targetOrigin === adminOrigin ? "/" : "/account/login";
  const url = new URL(path, handoff.targetOrigin);
  url.searchParams.set("handoff", handoff.code);
  url.searchParams.set("return_to", handoff.returnTo);
  return redirectResponse(url.toString());
}

function redirectResponse(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function allowedMethods(path) {
  if (path === "config" || path === "session" || path === "email/verify" || /\/callback$/.test(path)) return "GET, OPTIONS";
  return "POST, OPTIONS";
}

async function safeAudit(env, event) {
  try {
    await writeAudit(env, event);
  } catch {
    // Audit failure must not disclose or replace the primary auth result.
  }
}
