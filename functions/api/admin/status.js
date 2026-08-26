import {
  AuthFailure,
  corsHeaders,
  ensureEnvironmentMasters,
  errorResponse,
  jsonResponse,
  normalizeOrigin,
  nowIso,
  requireAdmin,
  requireAuthDb,
  sessionEnvelope,
} from "../../_shared/auth-core.js";
import { configuredOAuthProviders } from "../../_shared/oauth-providers.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    requireAdminOriginWhenPresent(request, env);
    const session = await requireAdmin(env, request);
    await ensureEnvironmentMasters(env);
    const counts = await requireAuthDb(env)
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS regular,
           SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
           SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
           SUM(CASE WHEN status = 'pending_email' THEN 1 ELSE 0 END) AS pending
         FROM accounts`,
      )
      .first();
    const current = await sessionEnvelope(env, session);
    return jsonResponse(
      {
        ok: true,
        authenticatedAccount: current.account,
        access: current.access,
        configuration: {
          d1Configured: true,
          turnstileConfigured: Boolean(env?.THIRDRAILIFY_TURNSTILE_SITE_KEY && env?.THIRDRAILIFY_TURNSTILE_SECRET_KEY),
          resendConfigured: Boolean(env?.RESEND_API_KEY && env?.MAIL_FROM),
          oauthProviders: configuredOAuthProviders(env).map((provider) => provider.id),
        },
        accounts: {
          total: Number(counts?.total || 0),
          regular: Number(counts?.regular || 0),
          admins: Number(counts?.admins || 0),
          disabled: Number(counts?.disabled || 0),
          pending: Number(counts?.pending || 0),
        },
        checkedAt: nowIso(),
      },
      { headers: corsHeaders(request, env) },
    );
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

export async function onRequest(context) {
  if (context.request.method === "GET") return await onRequestGet(context);
  return jsonResponse(
    { ok: false, error: "method_not_allowed", message: "This method is not allowed." },
    { status: 405, headers: { Allow: "GET" } },
  );
}

function requireAdminOriginWhenPresent(request, env) {
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin) return;
  const origin = normalizeOrigin(rawOrigin);
  const adminOrigin = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
  if (!origin || origin !== adminOrigin) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed.");
}
