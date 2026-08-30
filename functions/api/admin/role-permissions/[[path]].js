import {
  AuthFailure,
  corsHeaders,
  errorResponse,
  jsonResponse,
  normalizeOrigin,
  readJsonBody,
  requireAdmin,
  requireCsrf,
} from "../../../_shared/auth-core.js";
import {
  replaceFullAdminDenials,
  resetFullAdminDenials,
  rolePolicyPayload,
} from "../../../_shared/admin-capabilities.js";

const PREFIX = "/api/admin/role-permissions";

export async function onRequest({ request, env }) {
  try {
    const path = new URL(request.url).pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "OPTIONS") {
      requireAdminOrigin(request, env);
      return new Response(null, { status: 204, headers: { ...corsHeaders(request, env), "Access-Control-Allow-Headers": "content-type,x-csrf-token", "Access-Control-Allow-Methods": "GET,HEAD,PUT,POST,OPTIONS", "Access-Control-Max-Age": "600", "Cache-Control": "no-store" } });
    }
    requireAdminOriginWhenPresent(request, env);
    const session = await requireAdmin(env, request);
    if ((request.method === "GET" || request.method === "HEAD") && !path) {
      const payload = await rolePolicyPayload(env, session);
      return response(request.method === "HEAD" ? null : payload, request, env);
    }
    if (request.method === "PUT" && !path) {
      requireAdminOrigin(request, env);
      await requireCsrf(request, session);
      return response(await replaceFullAdminDenials(env, session, await readJsonBody(request)), request, env);
    }
    if (request.method === "POST" && path === "reset") {
      requireAdminOrigin(request, env);
      await requireCsrf(request, session);
      const body = await readJsonBody(request);
      if (Object.keys(body).length !== 1 || body.confirmation !== "RESET FULL ADMIN PERMISSIONS") {
        throw new AuthFailure(400, "role_policy_reset_confirmation_required", "Confirm the Full Admin policy reset explicitly.");
      }
      return response(await resetFullAdminDenials(env, session), request, env);
    }
    throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "GET, HEAD, PUT, POST" });
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

function response(payload, request, env) {
  return jsonResponse(payload, { headers: { ...corsHeaders(request, env), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
function requireAdminOriginWhenPresent(request, env) { if (request.headers.get("origin")) requireAdminOrigin(request, env); }
function requireAdminOrigin(request, env) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  const expected = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
  if (!origin || origin !== expected) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed.");
}
