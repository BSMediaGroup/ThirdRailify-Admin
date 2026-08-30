import { AuthFailure, enforceRateLimit, errorResponse, jsonResponse, normalizeOrigin, readJsonBody, requireCsrf, writeAudit } from "../../_shared/auth-core.js";
import { requireAdminCapability } from "../../_shared/admin-capabilities.js";
import { readBannerSettings, saveBannerSettings } from "../../_shared/banner-core.js";

export async function onRequestGet({ request, env }) {
  try {
    requireAdminOriginWhenPresent(request, env);
    await requireAdminCapability(env, request, "content.view");
    return response(await readBannerSettings(env));
  } catch (error) { return errorResponse(error, request, env); }
}

export async function onRequestPut({ request, env }) {
  try {
    requireAdminOrigin(request, env);
    const session = await requireAdminCapability(env, request, "content.manage");
    await requireCsrf(request, session);
    await enforceRateLimit(env, request, "site_content", session.accountId);
    const body = await readJsonBody(request);
    if (!body || Object.keys(body).length !== 2 || !("config" in body) || !("expectedRevision" in body)) throw new AuthFailure(400, "banner_request_invalid", "The banner save request is malformed.");
    const settings = await saveBannerSettings(env, body.config, body.expectedRevision, session.accountId);
    await writeAudit(env, { actorAccountId: session.accountId, eventType: "site_banner_updated", result: "success", metadata: { revision: settings.revision } });
    return response(settings);
  } catch (error) { return errorResponse(error, request, env); }
}

export async function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  if (context.request.method === "PUT") return onRequestPut(context);
  return jsonResponse({ ok: false, error: "method_not_allowed", message: "This method is not allowed." }, { status: 405, headers: { Allow: "GET, PUT" } });
}

function response(settings) { return jsonResponse({ ok: true, config: settings.config, revision: settings.revision, updatedAt: settings.updatedAt }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
function requireAdminOriginWhenPresent(request, env) { if (request.headers.get("origin")) requireAdminOrigin(request, env); }
function requireAdminOrigin(request, env) { const origin = normalizeOrigin(request.headers.get("origin")); const expected = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN); if (!origin || origin !== expected) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed."); }
