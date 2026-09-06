import { AuthFailure, corsHeaders, errorResponse, jsonResponse, normalizeOrigin, requireCsrf } from "../../../_shared/auth-core.js";
import { requireAdminCapability } from "../../../_shared/admin-capabilities.js";
import { automationsStatus, readPollJson, updateAutomationConfig } from "../../../_shared/polls-core.js";
import { listAutomationRules, saveAutomationRule, deleteAutomationRule, dryRunAutomation } from "../../../_shared/automation-core.js";

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url); const path = url.pathname.replace(/^\/api\/admin\/automations\/?/, '').replace(/\/$/, '');
    if (request.method === "GET") {
      originWhenPresent(request, env); await requireAdminCapability(env, request, "automations.view");
      if (path === 'rules') { await requireAdminCapability(env, request, 'wheels.view'); return response(await listAutomationRules(env, url.searchParams.get('wheelId') || ''), request, env); }
      if (path) throw new AuthFailure(404, 'automation_route_not_found', 'Unknown automation route.');
      return response(await automationsStatus(env), request, env);
    }
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This Automations method is not allowed.", { Allow: "GET,POST" });
    requireOrigin(request, env); const session = await requireAdminCapability(env, request, "automations.manage"); await requireCsrf(request, session);
    const { body } = await readPollJson(request, 16 * 1024);
    if (path) {
      await requireAdminCapability(env, request, 'wheels.manage');
      if (path === 'rules') return response(await saveAutomationRule(env, session.accountId, body), request, env);
      if (path === 'rules/delete') return response(await deleteAutomationRule(env, session.accountId, body), request, env);
      if (path === 'test') return response(dryRunAutomation(body), request, env);
      throw new AuthFailure(404, 'automation_route_not_found', 'Unknown automation route.');
    }
    return response(await updateAutomationConfig(env, session.accountId, body), request, env);
  } catch (error) { return errorResponse(error, request, env); }
}
function response(payload, request, env) { return jsonResponse(payload, { headers: { ...corsHeaders(request, env), "Cache-Control": "no-store" } }); }
function originWhenPresent(request, env) { if (request.headers.get("origin")) requireOrigin(request, env); }
function requireOrigin(request, env) { if (normalizeOrigin(request.headers.get("origin")) !== normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN)) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed."); }
