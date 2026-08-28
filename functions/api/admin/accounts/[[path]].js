import {
  AuthFailure,
  corsHeaders,
  cleanupExpiredAuthState,
  ensureEnvironmentMasters,
  errorResponse,
  isEnvironmentMasterId,
  jsonResponse,
  loadAccountById,
  normalizeOrigin,
  nowIso,
  requireAdmin,
  requireAuthDb,
  requireCsrf,
  requireMasterAdmin,
  revokeAccountSessions,
  serializeAccount,
  writeAudit,
} from "../../../_shared/auth-core.js";

const ROUTE_PREFIX = "/api/admin/accounts";
const MUTATIONS = new Set(["promote", "demote", "disable", "enable", "revoke-sessions"]);

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method === "OPTIONS") return handleOptions(request, env);
    const path = new URL(request.url).pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET" && !path) {
      requireAdminOriginWhenPresent(request, env);
      const session = await requireAdmin(env, request);
      return jsonResponse(await accountsPayload(env, session), { headers: corsHeaders(request, env) });
    }
    if (request.method !== "POST") {
      throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "GET, POST, OPTIONS" });
    }
    if (path === "maintenance/cleanup-expired-auth") {
      requireAdminOrigin(request, env);
      const session = await requireMasterAdmin(env, request);
      await requireCsrf(request, session);
      return jsonResponse(await cleanupExpiredAuthState(env, session.accountId), { headers: corsHeaders(request, env) });
    }
    const match = path.match(/^([^/]+)\/(promote|demote|disable|enable|revoke-sessions)$/);
    if (!match || !MUTATIONS.has(match[2])) throw new AuthFailure(404, "not_found", "The account action was not found.");
    requireAdminOrigin(request, env);
    const session = await requireMasterAdmin(env, request);
    await requireCsrf(request, session);
    const accountId = decodeAccountId(match[1]);
    await mutateAccount(env, session, accountId, match[2]);
    return jsonResponse(await accountsPayload(env, session), { headers: corsHeaders(request, env) });
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

async function accountsPayload(env, session) {
  await ensureEnvironmentMasters(env);
  const db = requireAuthDb(env);
  const [accountResult, identityResult] = await Promise.all([
    db.prepare("SELECT * FROM accounts ORDER BY created_at DESC, id ASC").all(),
    db
      .prepare(
        `SELECT provider, provider_subject, provider_username, provider_email, provider_email_verified, account_id
         FROM auth_identities ORDER BY created_at ASC`,
      )
      .all(),
  ]);
  const identityMap = new Map();
  for (const identity of identityResult?.results || []) {
    const identities = identityMap.get(identity.account_id) || [];
    identities.push(identity);
    identityMap.set(identity.account_id, identities);
  }
  const accounts = await Promise.all(
    (accountResult?.results || []).map((row) => serializeAccount(env, row, { identities: identityMap.get(row.id) || [] })),
  );
  return {
    ok: true,
    accounts,
    access: {
      isAdmin: true,
      isMasterAdmin: session.account.adminLevel === "master",
    },
    checkedAt: nowIso(),
  };
}

async function mutateAccount(env, session, accountId, action) {
  if (!accountId || isEnvironmentMasterId(env, accountId)) {
    throw new AuthFailure(409, "environment_master_locked", "Environment Master accounts are locked.");
  }
  const account = await loadAccountById(env, accountId);
  if (!account) throw new AuthFailure(404, "account_not_found", "The account was not found.");
  const db = requireAuthDb(env);
  const timestamp = nowIso();

  if (action === "promote") {
    if (account.status !== "active" || (!account.email_verified_at && account.source === "email")) {
      throw new AuthFailure(409, "account_not_verified", "A pending or disabled account cannot be promoted.");
    }
    await db
      .prepare("UPDATE accounts SET role = 'admin', admin_level = 'full', updated_at = ? WHERE id = ?")
      .bind(timestamp, account.id)
      .run();
  } else if (action === "demote") {
    await db.batch([
      db.prepare("UPDATE accounts SET role = 'user', admin_level = 'none', updated_at = ? WHERE id = ?").bind(timestamp, account.id),
      db.prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id = ?").bind(timestamp, account.id),
    ]);
  } else if (action === "disable") {
    await db.batch([
      db.prepare("UPDATE accounts SET status = 'disabled', updated_at = ? WHERE id = ?").bind(timestamp, account.id),
      db.prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id = ?").bind(timestamp, account.id),
    ]);
  } else if (action === "enable") {
    if (account.source === "email" && !account.email_verified_at) {
      throw new AuthFailure(409, "account_not_verified", "An unverified email account cannot be enabled.");
    }
    await db.prepare("UPDATE accounts SET status = 'active', updated_at = ? WHERE id = ?").bind(timestamp, account.id).run();
  } else if (action === "revoke-sessions") {
    await revokeAccountSessions(env, account.id);
  }

  await writeAudit(env, {
    actorAccountId: session.accountId,
    targetAccountId: account.id,
    eventType: action === "revoke-sessions" ? "sessions_revoked" : `account_${action.replace("-", "_")}`,
    result: "success",
  });
}

function decodeAccountId(value) {
  try {
    return decodeURIComponent(value).slice(0, 160);
  } catch {
    return "";
  }
}

function requireAdminOriginWhenPresent(request, env) {
  if (!request.headers.get("origin")) return;
  requireAdminOrigin(request, env);
}

function requireAdminOrigin(request, env) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  const adminOrigin = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
  if (!origin || origin !== adminOrigin) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed.");
}

function handleOptions(request, env) {
  requireAdminOrigin(request, env);
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request, env),
      "Access-Control-Allow-Headers": "content-type,x-csrf-token",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export { accountsPayload, mutateAccount };
