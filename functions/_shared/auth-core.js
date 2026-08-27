const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const AUTH_COOKIE_NAME = "thirdrailify_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 8;
export const HANDOFF_TTL_SECONDS = 60 * 5;
export const OAUTH_TRANSACTION_TTL_SECONDS = 60 * 10;
export const EMAIL_TOKEN_TTL_SECONDS = 60 * 60 * 24;
export const RESET_TOKEN_TTL_SECONDS = 60 * 30;
export const PASSWORD_ALGORITHM = "pbkdf2-sha256-v1";
export const PASSWORD_WORK_FACTOR = 120_000;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

const MAX_BODY_BYTES = 16 * 1024;
const SAFE_AVATAR_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "lh3.googleusercontent.com",
  "avatars.githubusercontent.com",
  "pbs.twimg.com",
]);

const RATE_RULES = {
  login: { limit: 8, windowSeconds: 15 * 60, blockSeconds: 15 * 60 },
  signup: { limit: 5, windowSeconds: 60 * 60, blockSeconds: 60 * 60 },
  forgot: { limit: 5, windowSeconds: 60 * 60, blockSeconds: 60 * 60 },
  resend: { limit: 5, windowSeconds: 60 * 60, blockSeconds: 60 * 60 },
  oauth: { limit: 20, windowSeconds: 15 * 60, blockSeconds: 15 * 60 },
  handoff: { limit: 10, windowSeconds: 15 * 60, blockSeconds: 15 * 60 },
  profile: { limit: 12, windowSeconds: 60 * 60, blockSeconds: 60 * 60 },
  avatar: { limit: 12, windowSeconds: 60 * 60, blockSeconds: 60 * 60 },
  commerce: { limit: 30, windowSeconds: 60 * 60, blockSeconds: 60 * 60 },
  checkout: { limit: 12, windowSeconds: 15 * 60, blockSeconds: 15 * 60 },
};

const ONE_TIME_TABLES = new Set(["email_verification_tokens", "password_reset_tokens"]);

export class AuthFailure extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = "AuthFailure";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

export function addSeconds(seconds, now = Date.now()) {
  return new Date(now + seconds * 1000).toISOString();
}

export function randomId() {
  return crypto.randomUUID();
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(String(value));
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(value)));
  return base64UrlEncode(new Uint8Array(signature));
}

export function timingSafeEqual(left, right) {
  const leftBytes = typeof left === "string" ? encoder.encode(left) : left;
  const rightBytes = typeof right === "string" ? encoder.encode(right) : right;
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return mismatch === 0;
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

export function cleanText(value, maxLength = 120) {
  const printable = Array.from(String(value || ""), (character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
  return printable.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function safeReturnPath(value, fallback = "/account") {
  const path = String(value || "").trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/api/") || /[\r\n]/.test(path)) return fallback;
  return path.slice(0, 1024);
}

export function safeAvatarUrl(value, env = null) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    const configuredMediaOrigins = new Set(
      [env?.THIRDRAILIFY_ADMIN_ORIGIN, env?.THIRDRAILIFY_PROFILE_MEDIA_ORIGIN].map(normalizeOrigin).filter(Boolean),
    );
    if (url.protocol !== "https:" || (!SAFE_AVATAR_HOSTS.has(url.hostname) && !configuredMediaOrigins.has(url.origin))) return null;
    url.username = "";
    url.password = "";
    return url.toString().slice(0, 1024);
  } catch {
    return null;
  }
}

export function configuredOrigins(env) {
  return new Set(
    [env?.THIRDRAILIFY_PUBLIC_ORIGIN, env?.THIRDRAILIFY_ADMIN_ORIGIN]
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}

export function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    if (!new Set(["https:", "http:"]).has(url.protocol)) return "";
    if (url.protocol === "http:" && !isLocalHostname(url.hostname)) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function isLocalEnvironment(env) {
  return new Set(["local", "test", "development"]).has(String(env?.AUTH_ENVIRONMENT || "").toLowerCase());
}

export function isLocalHostname(hostname) {
  return new Set(["localhost", "127.0.0.1", "0.0.0.0"]).has(String(hostname || "").toLowerCase());
}

export function requestOrigin(request) {
  return normalizeOrigin(request.headers.get("origin"));
}

export function requireAllowedOrigin(request, env) {
  const origin = requestOrigin(request);
  if (!origin || !configuredOrigins(env).has(origin)) {
    throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed.");
  }
  return origin;
}

export function corsHeaders(request, env) {
  const origin = requestOrigin(request);
  if (!origin || !configuredOrigins(env).has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function securityHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

export function jsonResponse(payload, init = {}) {
  const headers = securityHeaders(init.headers || {});
  return new Response(JSON.stringify(payload), { ...init, headers });
}

export function errorResponse(error, request, env) {
  if (error instanceof AuthFailure) {
    return jsonResponse(
      { ok: false, error: error.code, message: error.message },
      { status: error.status, headers: { ...corsHeaders(request, env), ...error.headers } },
    );
  }
  return jsonResponse(
    { ok: false, error: "auth_unavailable", message: "The account service is temporarily unavailable." },
    { status: 500, headers: corsHeaders(request, env) },
  );
}

export async function readJsonBody(request) {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new AuthFailure(415, "content_type_required", "A JSON request body is required.");
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new AuthFailure(413, "request_too_large", "The request body is too large.");
  }
  const text = await request.text();
  if (encoder.encode(text).length > MAX_BODY_BYTES) {
    throw new AuthFailure(413, "request_too_large", "The request body is too large.");
  }
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return body;
  } catch {
    throw new AuthFailure(400, "invalid_json", "The request body is not valid JSON.");
  }
}

export function requireAuthDb(env) {
  const db = env?.THIRDRAILIFY_AUTH_DB;
  if (!db || typeof db.prepare !== "function") {
    throw new AuthFailure(503, "auth_database_not_configured", "Account storage is not configured.");
  }
  return db;
}

export function isAuthDbConfigured(env) {
  return Boolean(env?.THIRDRAILIFY_AUTH_DB && typeof env.THIRDRAILIFY_AUTH_DB.prepare === "function");
}

export async function hashPassword(password, workFactor = PASSWORD_WORK_FACTOR) {
  validatePassword(password);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const passwordHash = await derivePasswordHash(password, salt, workFactor);
  return {
    algorithm: PASSWORD_ALGORITHM,
    workFactor,
    salt: base64UrlEncode(salt),
    passwordHash: base64UrlEncode(passwordHash),
  };
}

export async function verifyPassword(password, credential) {
  const algorithm = String(credential?.algorithm || "");
  const workFactor = Number(credential?.work_factor ?? credential?.workFactor);
  let salt;
  let expected;
  try {
    salt = base64UrlDecode(credential?.salt || "");
    expected = base64UrlDecode(credential?.password_hash ?? credential?.passwordHash ?? "");
  } catch {
    salt = new Uint8Array(16);
    expected = new Uint8Array(32);
  }
  const validConfig =
    algorithm === PASSWORD_ALGORITHM &&
    Number.isInteger(workFactor) &&
    workFactor >= 100_000 &&
    workFactor <= 600_000 &&
    salt.length === 16 &&
    expected.length === 32;
  const derived = await derivePasswordHash(String(password || ""), validConfig ? salt : new Uint8Array(16), validConfig ? workFactor : PASSWORD_WORK_FACTOR);
  return validConfig && timingSafeEqual(derived, expected);
}

export async function burnPasswordAttempt(password) {
  await derivePasswordHash(String(password || ""), new Uint8Array(16), PASSWORD_WORK_FACTOR);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new AuthFailure(
      400,
      "password_policy",
      `Use a password between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`,
    );
  }
}

async function derivePasswordHash(password, salt, workFactor) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: workFactor },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export function parseCookies(request) {
  const cookies = {};
  for (const segment of String(request.headers.get("cookie") || "").split(";")) {
    const index = segment.indexOf("=");
    if (index < 1) continue;
    const key = segment.slice(0, index).trim();
    try {
      cookies[key] = decodeURIComponent(segment.slice(index + 1).trim());
    } catch {
      cookies[key] = "";
    }
  }
  return cookies;
}

export function sessionCookie(request, env, token, maxAge = SESSION_TTL_SECONDS) {
  const url = new URL(request.url);
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token || "")}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
  ];
  if (url.protocol === "https:") parts.push("Secure");
  const domain = String(env?.THIRDRAILIFY_AUTH_COOKIE_DOMAIN || "").trim().toLowerCase();
  if (domain === ".thirdrailify.com" && (url.hostname === "thirdrailify.com" || url.hostname.endsWith(".thirdrailify.com"))) {
    parts.push("Domain=.thirdrailify.com");
  }
  return parts.join("; ");
}

export function clearSessionCookie(request, env) {
  return sessionCookie(request, env, "", 0);
}

export function environmentMasters(env) {
  return [1, 2]
    .map((index) => {
      const email = normalizeEmail(env?.[`ADMIN_EMAIL_${index}`]);
      const secret = String(env?.[`ADMIN_SECRET_${index}`] || "");
      if (!email || !secret) return null;
      return {
        id: `env-master-${index}`,
        email,
        secret,
        displayName: `Third Railify Master ${index}`,
      };
    })
    .filter(Boolean);
}

export function isEnvironmentMasterId(env, accountId) {
  return environmentMasters(env).some((master) => master.id === accountId);
}

export async function ensureEnvironmentMasters(env) {
  const db = requireAuthDb(env);
  const masters = environmentMasters(env);
  if (!masters.length) return masters;
  const timestamp = nowIso();
  await db.batch(
    masters.map((master) =>
      db
        .prepare(
          `INSERT INTO accounts (
             id, email_normalized, display_name, avatar_url, role, admin_level, status,
             email_verified_at, created_at, updated_at, last_login_at, source, notes
           ) VALUES (?, ?, ?, NULL, 'admin', 'master', 'active', ?, ?, ?, NULL, 'env_master', NULL)
           ON CONFLICT(id) DO UPDATE SET
             email_normalized = excluded.email_normalized,
             display_name = COALESCE(NULLIF(accounts.display_name, ''), excluded.display_name),
             role = 'admin', admin_level = 'master', status = 'active',
             email_verified_at = COALESCE(accounts.email_verified_at, excluded.email_verified_at),
             updated_at = excluded.updated_at, source = 'env_master'`,
        )
        .bind(master.id, master.email, master.displayName, timestamp, timestamp, timestamp),
    ),
  );
  return masters;
}

export async function authenticateEnvironmentMaster(env, email, password) {
  const candidate = environmentMasters(env).find((master) => master.email === normalizeEmail(email));
  if (!candidate) return null;
  const [providedHash, expectedHash] = await Promise.all([sha256(String(password || "")), sha256(candidate.secret)]);
  if (!timingSafeEqual(providedHash, expectedHash)) return null;
  await ensureEnvironmentMasters(env);
  return loadAccountById(env, candidate.id);
}

export async function loadAccountById(env, accountId) {
  const db = requireAuthDb(env);
  return db.prepare("SELECT * FROM accounts WHERE id = ? LIMIT 1").bind(accountId).first();
}

export async function loadAccountByEmail(env, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return requireAuthDb(env).prepare("SELECT * FROM accounts WHERE email_normalized = ? LIMIT 1").bind(normalized).first();
}

export async function loadPasswordCredential(env, accountId) {
  return requireAuthDb(env)
    .prepare("SELECT * FROM password_credentials WHERE account_id = ? LIMIT 1")
    .bind(accountId)
    .first();
}

export async function accountIdentities(env, accountId) {
  const result = await requireAuthDb(env)
    .prepare(
      `SELECT provider, provider_subject, provider_username, provider_email, provider_email_verified
       FROM auth_identities WHERE account_id = ? ORDER BY created_at ASC`,
    )
    .bind(accountId)
    .all();
  return Array.isArray(result?.results) ? result.results : [];
}

export async function serializeAccount(env, row, options = {}) {
  if (!row) return null;
  const identities = options.identities || (await accountIdentities(env, row.id));
  const locked = isEnvironmentMasterId(env, row.id) || row.source === "env_master";
  return {
    id: row.id,
    email: row.email_normalized || null,
    displayName: row.display_name,
    username: identities.find((identity) => identity.provider_username)?.provider_username || null,
    avatarUrl: safeAvatarUrl(row.avatar_url, env),
    providers: identities.map((identity) => identity.provider),
    identities: identities.map((identity) => ({
      provider: identity.provider,
      subject: cleanText(identity.provider_subject, 160),
      username: cleanText(identity.provider_username, 120) || null,
      email: normalizeEmail(identity.provider_email) || null,
      emailVerified: Boolean(identity.provider_email_verified),
    })),
    role: locked ? "admin" : row.role,
    adminLevel: locked ? "master" : row.admin_level,
    status: locked ? "active" : row.status,
    emailVerified: Boolean(row.email_verified_at),
    emailVerifiedAt: row.email_verified_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at || null,
    source: locked ? "Environment Master" : cleanText(row.source, 80),
    locked,
  };
}

export function accessForAccount(account) {
  return {
    isAdmin: Boolean(account && account.role === "admin" && account.status === "active"),
    isMasterAdmin: Boolean(account && account.adminLevel === "master" && account.status === "active"),
  };
}

export async function createSession(env, request, accountRow, sourceOrigin) {
  const db = requireAuthDb(env);
  if (!accountRow || accountRow.status !== "active") {
    throw new AuthFailure(403, "account_unavailable", "This account cannot create a session.");
  }
  const sessionId = randomId();
  const token = randomToken(32);
  const csrfSecret = String(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET || "");
  if (!csrfSecret) throw new AuthFailure(503, "session_protection_not_configured", "Session protection is not configured.");
  const csrfToken = await hmacSha256(csrfSecret, `csrf:${token}`);
  const timestamp = nowIso();
  const expiresAt = addSeconds(SESSION_TTL_SECONDS);
  const userAgent = cleanText(request.headers.get("user-agent"), 512);
  const [tokenHash, csrfTokenHash, userAgentHash] = await Promise.all([
    sha256(token),
    sha256(csrfToken),
    userAgent ? sha256(userAgent) : Promise.resolve(null),
  ]);
  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (
           id, account_id, token_hash, csrf_token_hash, created_at, expires_at,
           last_seen_at, revoked_at, source_origin, user_agent_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(sessionId, accountRow.id, tokenHash, csrfTokenHash, timestamp, expiresAt, timestamp, sourceOrigin, userAgentHash),
    db.prepare("UPDATE accounts SET last_login_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, accountRow.id),
  ]);
  const account = await serializeAccount(env, { ...accountRow, last_login_at: timestamp, updated_at: timestamp });
  return {
    cookie: sessionCookie(request, env, token),
    csrfToken,
    session: { id: sessionId, accountId: accountRow.id, csrfTokenHash, expiresAt, sourceOrigin },
    account,
  };
}

export async function resolveSession(env, request) {
  const token = parseCookies(request)[AUTH_COOKIE_NAME];
  if (!token) return null;
  const csrfSecret = String(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET || "");
  if (!csrfSecret) throw new AuthFailure(503, "session_protection_not_configured", "Session protection is not configured.");
  await ensureEnvironmentMasters(env);
  const tokenHash = await sha256(token);
  const row = await requireAuthDb(env)
    .prepare(
      `SELECT
         sessions.id AS session_id, sessions.account_id, sessions.csrf_token_hash,
         sessions.created_at AS session_created_at, sessions.expires_at,
         sessions.last_seen_at, sessions.revoked_at, sessions.source_origin,
         accounts.*
       FROM sessions JOIN accounts ON accounts.id = sessions.account_id
       WHERE sessions.token_hash = ? LIMIT 1`,
    )
    .bind(tokenHash)
    .first();
  if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now() || row.status !== "active") return null;
  if (Date.now() - Date.parse(row.last_seen_at) >= 15 * 60 * 1000) {
    const timestamp = nowIso();
    await requireAuthDb(env).prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(timestamp, row.session_id).run();
    row.last_seen_at = timestamp;
  }
  const account = await serializeAccount(env, row);
  return {
    id: row.session_id,
    accountId: row.account_id,
    csrfTokenHash: row.csrf_token_hash,
    expiresAt: row.expires_at,
    sourceOrigin: row.source_origin,
    csrfToken: await hmacSha256(csrfSecret, `csrf:${token}`),
    account,
  };
}

export async function requireSession(env, request) {
  const session = await resolveSession(env, request);
  if (!session) throw new AuthFailure(401, "unauthenticated", "A signed-in account is required.");
  return session;
}

export async function requireAdmin(env, request) {
  const session = await requireSession(env, request);
  if (!accessForAccount(session.account).isAdmin) {
    throw new AuthFailure(403, "admin_required", "Admin access is required.");
  }
  return session;
}

export async function requireMasterAdmin(env, request) {
  const session = await requireAdmin(env, request);
  if (!accessForAccount(session.account).isMasterAdmin) {
    throw new AuthFailure(403, "master_admin_required", "Master Admin access is required.");
  }
  return session;
}

export async function requireCsrf(request, session) {
  const token = String(request.headers.get("x-csrf-token") || "");
  if (!token || token.length > 512) throw new AuthFailure(403, "csrf_required", "The request could not be verified.");
  const tokenHash = await sha256(token);
  if (!timingSafeEqual(tokenHash, session.csrfTokenHash)) {
    throw new AuthFailure(403, "csrf_invalid", "The request could not be verified.");
  }
}

export async function sessionEnvelope(env, session, csrfToken = null) {
  if (!session) return { ok: true, authenticated: false, account: null, access: { isAdmin: false, isMasterAdmin: false } };
  const account = session.account || (await serializeAccount(env, await loadAccountById(env, session.accountId)));
  return {
    ok: true,
    authenticated: true,
    account,
    access: accessForAccount(account),
    csrfToken: csrfToken || session.csrfToken || undefined,
  };
}

export async function revokeSession(env, sessionId) {
  await requireAuthDb(env)
    .prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
    .bind(nowIso(), sessionId)
    .run();
}

export async function revokeAccountSessions(env, accountId) {
  return requireAuthDb(env)
    .prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id = ?")
    .bind(nowIso(), accountId)
    .run();
}

export async function createHandoff(env, accountId, targetOrigin, returnTo) {
  const allowedOrigins = configuredOrigins(env);
  if (!allowedOrigins.has(targetOrigin)) throw new AuthFailure(400, "invalid_target_origin", "The login destination is not allowed.");
  const code = randomToken(32);
  const timestamp = nowIso();
  await requireAuthDb(env)
    .prepare(
      `INSERT INTO auth_handoffs (
         id, code_hash, account_id, target_origin, return_to, created_at, expires_at, consumed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(randomId(), await sha256(code), accountId, targetOrigin, safeReturnPath(returnTo), timestamp, addSeconds(HANDOFF_TTL_SECONDS))
    .run();
  return { code, targetOrigin, returnTo: safeReturnPath(returnTo) };
}

export async function consumeHandoff(env, request, code, origin) {
  const db = requireAuthDb(env);
  const codeHash = await sha256(String(code || ""));
  const row = await db
    .prepare(
      `SELECT auth_handoffs.*, accounts.status AS account_status
       FROM auth_handoffs JOIN accounts ON accounts.id = auth_handoffs.account_id
       WHERE auth_handoffs.code_hash = ? LIMIT 1`,
    )
    .bind(codeHash)
    .first();
  if (
    !row ||
    row.consumed_at ||
    Date.parse(row.expires_at) <= Date.now() ||
    row.target_origin !== origin ||
    row.account_status !== "active"
  ) {
    throw new AuthFailure(400, "handoff_invalid", "The login handoff is invalid or expired.");
  }
  const consumedAt = nowIso();
  const result = await db
    .prepare("UPDATE auth_handoffs SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?")
    .bind(consumedAt, row.id, consumedAt)
    .run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw new AuthFailure(400, "handoff_invalid", "The login handoff is invalid or expired.");
  }
  const accountRow = await loadAccountById(env, row.account_id);
  return { ...(await createSession(env, request, accountRow, origin)), returnTo: safeReturnPath(row.return_to) };
}

export async function createOneTimeToken(env, table, accountId, targetOrigin, returnTo, ttlSeconds) {
  if (!ONE_TIME_TABLES.has(table)) throw new Error("Unsupported one-time token table.");
  if (!configuredOrigins(env).has(targetOrigin)) throw new AuthFailure(400, "invalid_target_origin", "The account destination is not allowed.");
  const db = requireAuthDb(env);
  const token = randomToken(32);
  const timestamp = nowIso();
  await db
    .prepare(`UPDATE ${table} SET consumed_at = ? WHERE account_id = ? AND consumed_at IS NULL`)
    .bind(timestamp, accountId)
    .run();
  await db
    .prepare(
      `INSERT INTO ${table} (
         id, account_id, token_hash, target_origin, return_to, created_at, expires_at, consumed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(randomId(), accountId, await sha256(token), targetOrigin, safeReturnPath(returnTo), timestamp, addSeconds(ttlSeconds))
    .run();
  return token;
}

export async function consumeOneTimeToken(env, table, token, expectedOrigin = null) {
  if (!ONE_TIME_TABLES.has(table)) throw new Error("Unsupported one-time token table.");
  const db = requireAuthDb(env);
  const row = await db.prepare(`SELECT * FROM ${table} WHERE token_hash = ? LIMIT 1`).bind(await sha256(String(token || ""))).first();
  const timestamp = nowIso();
  if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now() || (expectedOrigin && row.target_origin !== expectedOrigin)) {
    throw new AuthFailure(400, "token_invalid", "This account link is invalid or expired.");
  }
  const result = await db
    .prepare(`UPDATE ${table} SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`)
    .bind(timestamp, row.id, timestamp)
    .run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw new AuthFailure(400, "token_invalid", "This account link is invalid or expired.");
  }
  return row;
}

export async function createOAuthTransaction(env, provider, targetOrigin, returnTo, pkceVerifier = null) {
  if (!configuredOrigins(env).has(targetOrigin)) throw new AuthFailure(400, "invalid_target_origin", "The login destination is not allowed.");
  const state = randomToken(32);
  const timestamp = nowIso();
  await requireAuthDb(env)
    .prepare(
      `INSERT INTO oauth_transactions (
         id, state_hash, provider, pkce_verifier, target_origin, return_to, created_at, expires_at, consumed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(randomId(), await sha256(state), provider, pkceVerifier, targetOrigin, safeReturnPath(returnTo), timestamp, addSeconds(OAUTH_TRANSACTION_TTL_SECONDS))
    .run();
  return state;
}

export async function consumeOAuthTransaction(env, provider, state) {
  const db = requireAuthDb(env);
  const stateHash = await sha256(String(state || ""));
  const row = await db
    .prepare("SELECT * FROM oauth_transactions WHERE state_hash = ? AND provider = ? LIMIT 1")
    .bind(stateHash, provider)
    .first();
  const timestamp = nowIso();
  if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) {
    throw new AuthFailure(400, "oauth_state_invalid", "The OAuth transaction is invalid or expired.");
  }
  const result = await db
    .prepare("UPDATE oauth_transactions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?")
    .bind(timestamp, row.id, timestamp)
    .run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw new AuthFailure(400, "oauth_state_invalid", "The OAuth transaction is invalid or expired.");
  }
  return row;
}

export async function enforceRateLimit(env, request, category, identifier = "") {
  const rule = RATE_RULES[category];
  if (!rule) throw new Error("Unsupported rate-limit category.");
  const secret = String(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET || "");
  if (!secret) throw new AuthFailure(503, "rate_limit_not_configured", "Account protection is not configured.");
  const ip = cleanText(request.headers.get("CF-Connecting-IP") || "unknown", 80);
  const keyHash = await hmacSha256(secret, `${category}\n${ip}\n${cleanText(identifier, 254).toLowerCase()}`);
  const db = requireAuthDb(env);
  const row = await db
    .prepare("SELECT * FROM auth_rate_limits WHERE key_hash = ? AND category = ? LIMIT 1")
    .bind(keyHash, category)
    .first();
  const now = Date.now();
  if (row?.blocked_until && Date.parse(row.blocked_until) > now) {
    const retryAfter = Math.max(1, Math.ceil((Date.parse(row.blocked_until) - now) / 1000));
    throw new AuthFailure(429, "too_many_attempts", "Too many attempts. Try again later.", { "Retry-After": String(retryAfter) });
  }
  const windowExpired = !row || now - Date.parse(row.window_started_at) >= rule.windowSeconds * 1000;
  const attemptCount = windowExpired ? 1 : Number(row.attempt_count || 0) + 1;
  const windowStartedAt = windowExpired ? nowIso(now) : row.window_started_at;
  const blockedUntil = attemptCount > rule.limit ? addSeconds(rule.blockSeconds, now) : null;
  await db
    .prepare(
      `INSERT INTO auth_rate_limits (
         key_hash, category, window_started_at, attempt_count, blocked_until, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_hash, category) DO UPDATE SET
         window_started_at = excluded.window_started_at,
         attempt_count = excluded.attempt_count,
         blocked_until = excluded.blocked_until,
         updated_at = excluded.updated_at`,
    )
    .bind(keyHash, category, windowStartedAt, attemptCount, blockedUntil, nowIso(now))
    .run();
  if (blockedUntil) {
    throw new AuthFailure(429, "too_many_attempts", "Too many attempts. Try again later.", { "Retry-After": String(rule.blockSeconds) });
  }
}

export async function verifyTurnstile(env, request, token, expectedAction, fetchImpl = fetch) {
  const secret = String(env?.THIRDRAILIFY_TURNSTILE_SECRET_KEY || "");
  if (!secret) throw new AuthFailure(503, "turnstile_not_configured", "Human verification is not configured.");
  const responseToken = String(token || "");
  if (!responseToken || responseToken.length > 2048) {
    throw new AuthFailure(403, "turnstile_required", "Complete the human verification challenge.");
  }
  const allowedHostnames = new Set(
    [...configuredOrigins(env)].map((origin) => new URL(origin).hostname),
  );
  if (isLocalEnvironment(env)) {
    allowedHostnames.add("localhost");
    allowedHostnames.add("127.0.0.1");
  }
  if (!allowedHostnames.size) throw new AuthFailure(503, "turnstile_not_configured", "Human verification is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let result;
  try {
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "manual",
      signal: controller.signal,
      body: JSON.stringify({
        secret,
        response: responseToken,
        remoteip: request.headers.get("CF-Connecting-IP") || undefined,
        idempotency_key: randomId(),
      }),
    });
    if (!response.ok) throw new Error("siteverify unavailable");
    result = await response.json();
  } catch {
    throw new AuthFailure(503, "turnstile_unavailable", "Human verification is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
  if (!result?.success || result.action !== expectedAction || !allowedHostnames.has(String(result.hostname || "").toLowerCase())) {
    const duplicate = Array.isArray(result?.["error-codes"]) && result["error-codes"].includes("timeout-or-duplicate");
    throw new AuthFailure(
      403,
      duplicate ? "turnstile_expired" : "turnstile_invalid",
      duplicate ? "Human verification expired. Complete it again." : "Human verification failed.",
    );
  }
}

export async function writeAudit(env, event) {
  if (!isAuthDbConfigured(env)) return;
  const metadata = event.metadata && typeof event.metadata === "object" ? JSON.stringify(event.metadata).slice(0, 1024) : null;
  await env.THIRDRAILIFY_AUTH_DB
    .prepare(
      `INSERT INTO auth_audit (
         id, actor_account_id, target_account_id, event_type, provider, result, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      randomId(),
      event.actorAccountId || null,
      event.targetAccountId || null,
      cleanText(event.eventType, 80),
      cleanText(event.provider, 40) || null,
      cleanText(event.result, 40),
      metadata,
      nowIso(),
    )
    .run();
}

export async function sendAccountEmail(env, message, fetchImpl = fetch) {
  const apiKey = String(env?.RESEND_API_KEY || "");
  const from = cleanText(env?.MAIL_FROM, 254);
  const replyTo = normalizeEmail(env?.MAIL_REPLY_TO);
  if (!apiKey || !from) throw new AuthFailure(503, "email_not_configured", "Account email delivery is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      redirect: "manual",
      signal: controller.signal,
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!response.ok) throw new Error("email delivery failed");
  } catch {
    throw new AuthFailure(503, "email_unavailable", "Account email delivery is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    return JSON.parse(decoder.decode(base64UrlDecode(part)));
  } catch {
    return null;
  }
}
