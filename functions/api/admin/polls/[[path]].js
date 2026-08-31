import { AuthFailure, corsHeaders, errorResponse, jsonResponse, normalizeOrigin, requireCsrf } from "../../../_shared/auth-core.js";
import { requireAdminCapability } from "../../../_shared/admin-capabilities.js";
import { adminPollAccess, adminPollLibrary, changePollLifecycle, getPublicPoll, mutatePollCreatorGrant, readPollJson } from "../../../_shared/polls-core.js";

const PREFIX = "/api/admin/polls";

export async function onRequest({ request, env }) {
  try {
    if (request.method === "OPTIONS") return options(request, env);
    originWhenPresent(request, env);
    const path = new URL(request.url).pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET") {
      await requireAdminCapability(env, request, "polls.view");
      if (!path) { const url = new URL(request.url); return response(await adminPollLibrary(env, { state: url.searchParams.get("state"), owner: url.searchParams.get("owner") }), request, env); }
      if (path === "access") return response(await adminPollAccess(env), request, env);
      return response(await getPublicPoll(env, decode(path), (await requireAdminCapability(env, request, "polls.view")).accountId, true), request, env);
    }
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This Admin Poll method is not allowed.", { Allow: "GET,POST,OPTIONS" });
    requireOrigin(request, env); const session = await requireAdminCapability(env, request, "polls.manage"); await requireCsrf(request, session);
    const { body } = await readPollJson(request);
    if (path === "grants") return response(await mutatePollCreatorGrant(env, session.accountId, body), request, env);
    const lifecycle = path.match(/^([^/]+)\/lifecycle$/);
    if (lifecycle) return response(await changePollLifecycle(env, session.accountId, decode(lifecycle[1]), body), request, env);
    throw new AuthFailure(404, "poll_route_not_found", "The Admin Poll action was not found.");
  } catch (error) { return errorResponse(error, request, env); }
}

function response(payload, request, env) { return jsonResponse(payload, { headers: { ...corsHeaders(request, env), "Cache-Control": "no-store" } }); }
function originWhenPresent(request, env) { if (request.headers.get("origin")) requireOrigin(request, env); }
function requireOrigin(request, env) { if (normalizeOrigin(request.headers.get("origin")) !== normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN)) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed."); }
function options(request, env) { requireOrigin(request, env); return new Response(null, { status: 204, headers: { ...corsHeaders(request, env), "Access-Control-Allow-Headers": "content-type,x-csrf-token", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Cache-Control": "no-store" } }); }
function decode(value) { try { return decodeURIComponent(value); } catch { return ""; } }
