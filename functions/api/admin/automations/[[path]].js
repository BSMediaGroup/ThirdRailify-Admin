import { pollVotingAdmin, savePollPolicy, reconcilePollCredit, matchPaidTrigger } from '../../../_shared/poll-credits.js';
import { AuthFailure, corsHeaders, errorResponse, jsonResponse, normalizeOrigin, requireCsrf } from "../../../_shared/auth-core.js";
import { requireAdminCapability } from "../../../_shared/admin-capabilities.js";
import { automationsStatus, readPollJson, updateAutomationConfig } from "../../../_shared/polls-core.js";
import { listAutomationRules, saveAutomationRule, deleteAutomationRule, dryRunAutomation } from "../../../_shared/automation-core.js";
import { listRosterRules, previewRosterSync, saveRosterRule, syncRosterRule } from "../../../_shared/subscriber-roster.js";

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url); const path = url.pathname.replace(/^\/api\/admin\/automations\/?/, '').replace(/\/$/, '');
    if (request.method === "GET") {
      originWhenPresent(request, env); await requireAdminCapability(env, request, "automations.view");
      if (path === 'poll-voting') { await requireAdminCapability(env, request, 'polls.manage'); return response(await pollVotingAdmin(env, Object.fromEntries(url.searchParams)), request, env); }
      if (path === 'rules') { await requireAdminCapability(env, request, 'wheels.view'); return response(await listAutomationRules(env, url.searchParams.get('wheelId') || '', url.searchParams.get('ruleId') || ''), request, env); }
      if (path === 'rosters') { await requireAdminCapability(env, request, 'wheels.view'); return response(await listRosterRules(env, url.searchParams.get('wheelId') || '', url.searchParams.get('ruleId') || ''), request, env); }
      if (path) throw new AuthFailure(404, 'automation_route_not_found', 'Unknown automation route.');
      return response(await automationsStatus(env), request, env);
    }
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This Automations method is not allowed.", { Allow: "GET,POST" });
    requireOrigin(request, env); const session = await requireAdminCapability(env, request, "automations.manage"); await requireCsrf(request, session);
    const { body } = await readPollJson(request, 16 * 1024);
    if (path.startsWith('poll-voting')) {
      await requireAdminCapability(env, request, 'polls.manage');
      if (path === 'poll-voting/policy') return response(await savePollPolicy(env, session.accountId, body), request, env);
      if (path === 'poll-voting/reconcile') return response(await reconcilePollCredit(env, session.accountId, body), request, env);
      if (path === 'poll-voting/test') return response({ ok: true, matches: matchPaidTrigger(String(body.text || '').slice(0, 4000), Array.isArray(body.options) ? body.options : [], body.rant === true) }, request, env);
      throw new AuthFailure(404, 'automation_route_not_found', 'Unknown Poll voting route.');
    }
    if (path) {
      await requireAdminCapability(env, request, 'wheels.manage');
      if (path === 'rules') return response(await saveAutomationRule(env, session.accountId, body), request, env);
      if (path === 'rules/delete') return response(await deleteAutomationRule(env, session.accountId, body), request, env);
      if (path === 'test') return response(dryRunAutomation(body), request, env);
      if (path === 'rosters') return response(await saveRosterRule(env, session.accountId, body), request, env);
      if (path === 'rosters/preview') return response(await previewRosterSync(env, body.ruleId), request, env);
      if (path === 'rosters/sync') return response(await syncRosterRule(env, session.accountId, body), request, env);
      throw new AuthFailure(404, 'automation_route_not_found', 'Unknown automation route.');
    }
    return response(await updateAutomationConfig(env, session.accountId, body), request, env);
  } catch (error) { return errorResponse(error, request, env); }
}
function response(payload, request, env) { return jsonResponse(payload, { headers: { ...corsHeaders(request, env), "Cache-Control": "no-store" } }); }
function originWhenPresent(request, env) { if (request.headers.get("origin")) requireOrigin(request, env); }
function requireOrigin(request, env) { if (normalizeOrigin(request.headers.get("origin")) !== normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN)) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed."); }
