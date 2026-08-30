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
  adminInboxMessages,
  adminInboxSummary,
  markAdminInboxRead,
  markAllAdminInboxRead,
  mutateAdminInboxMessages,
} from "../../../_shared/admin-inbox.js";

const ROUTE_PREFIX = "/api/admin/inbox";

export async function onRequest({ request, env }) {
  try {
    requireAdminOriginWhenPresent(request, env);
    const session = await requireAdmin(env, request);
    const url = new URL(request.url);
    const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "summary") return response(await adminInboxSummary(env, session.accountId), request, env);
      if (!path) return response(await adminInboxMessages(env, session.accountId, { unread: url.searchParams.get("unread"), page: url.searchParams.get("page"), pageSize: url.searchParams.get("pageSize") }), request, env);
    }
    if (request.method === "POST") {
      requireAdminOrigin(request, env);
      await requireCsrf(request, session);
      const body = await readJsonBody(request);
      if (path === "read-all") return response(await markAllAdminInboxRead(env, session.accountId), request, env);
      if (path === "bulk") return response(await mutateAdminInboxMessages(env, session.accountId, body), request, env);
      const read = path.match(/^([^/]+)\/read$/);
      if (read) return response(await markAdminInboxRead(env, session.accountId, decodePart(read[1])), request, env);
      const mutation = path.match(/^([^/]+)\/(unread|delete)$/);
      if (mutation) return response(await mutateAdminInboxMessages(env, session.accountId, { ids: [decodePart(mutation[1])], action: mutation[2] }), request, env);
    }
    throw new AuthFailure(404, "not_found", "The Admin inbox route was not found.");
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

function response(payload, request, env) { return jsonResponse(payload, { headers: { ...corsHeaders(request, env), "Cache-Control": "no-store" } }); }
function requireAdminOriginWhenPresent(request, env) { if (request.headers.get("origin")) requireAdminOrigin(request, env); }
function requireAdminOrigin(request, env) { const origin = normalizeOrigin(request.headers.get("origin")); const expected = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN); if (!origin || origin !== expected) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed."); }
function decodePart(value) { try { return decodeURIComponent(value); } catch { return ""; } }
