import {
  AuthFailure,
  cleanText,
  configuredOrigins,
  createOAuthTransaction,
  hmacSha256,
  loadAccountByEmail,
  loadAccountById,
  normalizeEmail,
  normalizeOrigin,
  nowIso,
  randomId,
  randomToken,
  requireAuthDb,
  safeAvatarUrl,
  safeReturnPath,
  serializeAccount,
  sha256,
  writeAudit,
} from "./auth-core.js";

const PROVIDERS = {
  discord: {
    label: "Discord",
    clientIdEnv: "DISCORD_CLIENT_ID",
    clientSecretEnv: "DISCORD_CLIENT_SECRET",
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    profileUrl: "https://discord.com/api/users/@me",
    scope: "identify email",
    pkce: false,
  },
  google: {
    label: "Google",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    pkce: true,
  },
  github: {
    label: "GitHub",
    clientIdEnv: "GITHUB_CLIENT_ID",
    clientSecretEnv: "GITHUB_CLIENT_SECRET",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    profileUrl: "https://api.github.com/user",
    scope: "read:user user:email",
    pkce: true,
  },
  twitter: {
    label: "X",
    clientIdEnv: "X_OAUTH_CLIENT_ID",
    clientSecretEnv: "X_OAUTH_CLIENT_SECRET",
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    profileUrl: "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url",
    scope: "users.read tweet.read",
    pkce: true,
  },
};

const GOOGLE_DISABLED_MESSAGE = "Available after site migration";

export function knownProvider(provider) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, provider);
}

export function configuredOAuthProviders(env) {
  return oauthProviderStates(env)
    .filter((provider) => provider.status === "enabled")
    .map(({ id, label }) => ({ id, label }));
}

export function oauthProviderStates(env) {
  return Object.entries(PROVIDERS).map(([id, provider]) => {
    if (id === "google" && !googleOAuthEnabled(env)) {
      return { id, label: provider.label, status: "disabled", message: GOOGLE_DISABLED_MESSAGE };
    }
    return {
      id,
      label: provider.label,
      status: oauthCredentialsConfigured(env, provider) ? "enabled" : "unavailable",
    };
  });
}

export function oauthProviderConfig(env, provider) {
  const definition = PROVIDERS[provider];
  if (!definition) throw new AuthFailure(404, "oauth_provider_unknown", "That OAuth provider is not supported.");
  if (provider === "google" && !googleOAuthEnabled(env)) {
    throw new AuthFailure(503, "oauth_provider_disabled", "Google sign-in is disabled until the site migration.");
  }
  const clientId = String(env?.[definition.clientIdEnv] || "");
  const clientSecret = String(env?.[definition.clientSecretEnv] || "");
  if (!clientId || !clientSecret) {
    throw new AuthFailure(503, "oauth_provider_not_configured", `${definition.label} sign-in is not configured.`);
  }
  return { ...definition, id: provider, clientId, clientSecret };
}

function googleOAuthEnabled(env) {
  return String(env?.GOOGLE_OAUTH_ENABLED || "").trim().toLowerCase() === "true";
}

function oauthCredentialsConfigured(env, provider) {
  return Boolean(env?.[provider.clientIdEnv] && env?.[provider.clientSecretEnv]);
}

export function oauthCallbackUrl(env, provider) {
  const adminOrigin = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
  if (!adminOrigin || !configuredOrigins(env).has(adminOrigin)) {
    throw new AuthFailure(503, "auth_origin_not_configured", "The Admin authentication origin is not configured.");
  }
  return `${adminOrigin}/api/auth/oauth/${provider}/callback`;
}

export async function startOAuth(env, provider, targetOrigin, returnTo) {
  const config = oauthProviderConfig(env, provider);
  const verifier = config.pkce ? randomToken(48) : null;
  const state = await createOAuthTransaction(env, provider, targetOrigin, safeReturnPath(returnTo), verifier);
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", oauthCallbackUrl(env, provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  if (verifier) {
    url.searchParams.set("code_challenge", await sha256(verifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (provider === "google") url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeOAuthCode(env, provider, code, transaction, fetchImpl = fetch) {
  const config = oauthProviderConfig(env, provider);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code),
    redirect_uri: oauthCallbackUrl(env, provider),
  });
  const headers = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
  if (provider === "twitter") {
    headers.Authorization = `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
  } else {
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
  }
  if (transaction.pkce_verifier) body.set("code_verifier", transaction.pkce_verifier);
  const response = await fetchWithTimeout(fetchImpl, config.tokenUrl, {
    method: "POST",
    headers,
    redirect: "manual",
    body,
  });
  const payload = await response.json().catch(() => null);
  const accessToken = cleanText(payload?.access_token, 4096);
  if (!response.ok || !accessToken) {
    const failure = new AuthFailure(400, "oauth_exchange_failed", "The OAuth provider did not complete sign-in.");
    failure.providerDiagnostic = {
      httpStatus: response.status,
      responseKeys: payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload).sort().slice(0, 12) : [],
      error: cleanText(payload?.error, 80) || null,
    };
    throw failure;
  }
  return accessToken;
}

export async function fetchOAuthIdentity(env, provider, accessToken, fetchImpl = fetch) {
  const config = oauthProviderConfig(env, provider);
  const response = await fetchWithTimeout(fetchImpl, config.profileUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(provider === "github" ? { "User-Agent": "ThirdRailify-Auth" } : {}),
    },
    redirect: "manual",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw new AuthFailure(400, "oauth_profile_failed", "The OAuth provider did not return a usable identity.");
  }

  if (provider === "discord") {
    const subject = cleanText(payload.id, 160);
    if (!subject) throw new AuthFailure(400, "oauth_profile_failed", "Discord did not return an account identifier.");
    const avatar = payload.avatar ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(subject)}/${encodeURIComponent(payload.avatar)}.png` : null;
    return normalizeIdentity({
      provider,
      subject,
      username: payload.global_name || payload.username,
      displayName: payload.global_name || payload.username,
      email: payload.email,
      emailVerified: Boolean(payload.verified),
      avatarUrl: avatar,
    });
  }

  if (provider === "google") {
    return normalizeIdentity({
      provider,
      subject: payload.sub,
      username: null,
      displayName: payload.name || payload.email,
      email: payload.email,
      emailVerified: Boolean(payload.email_verified),
      avatarUrl: payload.picture,
    });
  }

  if (provider === "github") {
    const emailResponse = await fetchWithTimeout(fetchImpl, "https://api.github.com/user/emails", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "ThirdRailify-Auth",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
    });
    const emails = emailResponse.ok ? await emailResponse.json().catch(() => []) : [];
    const selected = Array.isArray(emails) ? emails.find((entry) => entry?.primary && entry?.verified) : null;
    const email = normalizeEmail(selected?.email);
    const emailVerified = Boolean(email && selected?.verified);
    return normalizeIdentity({
      provider,
      subject: payload.id,
      username: payload.login,
      displayName: payload.name || payload.login,
      email,
      emailVerified,
      avatarUrl: payload.avatar_url,
    });
  }

  const data = payload.data || payload;
  return normalizeIdentity({
    provider,
    subject: data.id,
    username: data.username,
    displayName: data.name || data.username,
    email: null,
    emailVerified: false,
    avatarUrl: data.profile_image_url,
  });
}

function normalizeIdentity(identity) {
  const subject = cleanText(identity.subject, 160);
  if (!subject) throw new AuthFailure(400, "oauth_profile_failed", "The OAuth provider did not return an account identifier.");
  return {
    provider: identity.provider,
    subject,
    username: cleanText(identity.username, 120) || null,
    displayName: cleanText(identity.displayName, 80) || `${PROVIDERS[identity.provider].label} user`,
    email: normalizeEmail(identity.email) || null,
    emailVerified: Boolean(identity.email && identity.emailVerified),
    avatarUrl: safeAvatarUrl(identity.avatarUrl),
  };
}

export async function registerOAuthIdentity(env, identity) {
  const db = requireAuthDb(env);
  const timestamp = nowIso();
  const existingIdentity = await db
    .prepare("SELECT * FROM auth_identities WHERE provider = ? AND provider_subject = ? LIMIT 1")
    .bind(identity.provider, identity.subject)
    .first();

  if (existingIdentity) {
    const account = await loadAccountById(env, existingIdentity.account_id);
    if (!account || account.status === "disabled") throw new AuthFailure(403, "account_disabled", "This account is disabled.");
    await db.batch([
      db
        .prepare(
          `UPDATE auth_identities SET
             provider_username = ?, provider_email = ?, provider_email_verified = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(identity.username, identity.email, identity.emailVerified ? 1 : 0, timestamp, existingIdentity.id),
      db
        .prepare(
          `UPDATE accounts SET
             display_name = ?, avatar_url = COALESCE(?, avatar_url), updated_at = ?
           WHERE id = ?`,
        )
        .bind(identity.displayName, identity.avatarUrl, timestamp, account.id),
    ]);
    await writeAudit(env, {
      eventType: "oauth_login",
      provider: identity.provider,
      result: "success",
      targetAccountId: account.id,
      metadata: { linked: true },
    });
    return loadAccountById(env, account.id);
  }

  let account = null;
  if (identity.email && identity.emailVerified) {
    const emailAccount = await loadAccountByEmail(env, identity.email);
    if (emailAccount?.email_verified_at) account = emailAccount;
  }

  if (!account) {
    const conflictingEmail = identity.email ? await loadAccountByEmail(env, identity.email) : null;
    const accountId = randomId();
    await db
      .prepare(
        `INSERT INTO accounts (
           id, email_normalized, display_name, avatar_url, role, admin_level, status,
           email_verified_at, created_at, updated_at, last_login_at, source, notes
         ) VALUES (?, ?, ?, ?, 'user', 'none', 'active', ?, ?, ?, NULL, ?, NULL)`,
      )
      .bind(
        accountId,
        conflictingEmail ? null : identity.email,
        identity.displayName,
        identity.avatarUrl,
        identity.email && identity.emailVerified && !conflictingEmail ? timestamp : null,
        timestamp,
        timestamp,
        `oauth:${identity.provider}`,
      )
      .run();
    account = await loadAccountById(env, accountId);
  }

  await db
    .prepare(
      `INSERT INTO auth_identities (
         id, account_id, provider, provider_subject, provider_username, provider_email,
         provider_email_verified, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      randomId(),
      account.id,
      identity.provider,
      identity.subject,
      identity.username,
      identity.email,
      identity.emailVerified ? 1 : 0,
      timestamp,
      timestamp,
    )
    .run();

  await writeAudit(env, {
    eventType: account.source?.startsWith("oauth:") ? "oauth_account_created" : "oauth_account_linked",
    provider: identity.provider,
    result: "success",
    targetAccountId: account.id,
    metadata: { verifiedEmailLinked: Boolean(identity.email && identity.emailVerified && account.email_normalized === identity.email) },
  });
  return loadAccountById(env, account.id);
}

export async function oauthRequestFingerprint(env, provider, state) {
  const secret = String(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET || "");
  return secret ? hmacSha256(secret, `${provider}\n${state}`) : "";
}

export async function serializedOAuthAccount(env, accountRow) {
  return serializeAccount(env, accountRow);
}

async function fetchWithTimeout(fetchImpl, url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    throw new AuthFailure(503, "oauth_provider_unavailable", "The OAuth provider is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}
