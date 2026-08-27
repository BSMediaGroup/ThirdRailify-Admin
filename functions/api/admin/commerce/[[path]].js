import {
  AuthFailure,
  corsHeaders,
  enforceRateLimit,
  errorResponse,
  jsonResponse,
  normalizeOrigin,
  readJsonBody,
  requireAdmin,
  requireCsrf,
  requireMasterAdmin,
  writeAudit,
} from "../../../_shared/auth-core.js";
import {
  businessProfilePayload,
  commerceOverview,
  grantCommerceCapability,
  permissionGrantsPayload,
  requireCommerceCapability,
  revokeCommerceCapability,
  templatesPayload,
  updateBusinessProfile,
  updateTemplate,
} from "../../../_shared/commerce-core.js";

const ROUTE_PREFIX = "/api/admin/commerce";

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method === "OPTIONS") return handleOptions(request, env);
    const path = new URL(request.url).pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET") return await handleGet(request, env, path);
    if (request.method === "POST") return await handlePost(request, env, path);
    throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "GET, POST, OPTIONS" });
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

async function handleGet(request, env, path) {
  requireAdminOriginWhenPresent(request, env);
  const session = await requireAdmin(env, request);
  let payload;
  if (!path || path === "overview") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await commerceOverview(env, session);
  } else if (path === "business") {
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await businessProfilePayload(env, session);
  } else if (path === "templates") {
    await requireCommerceCapability(env, session, "commerce.templates.manage");
    payload = await templatesPayload(env, session);
  } else if (path === "permissions") {
    await requireMasterAdmin(env, request);
    payload = await permissionGrantsPayload(env, session);
  } else {
    throw new AuthFailure(404, "not_found", "The commerce route was not found.");
  }
  return jsonResponse(payload, { headers: corsHeaders(request, env) });
}

async function handlePost(request, env, path) {
  requireAdminOrigin(request, env);
  const session = await requireAdmin(env, request);
  await requireCsrf(request, session);
  await enforceRateLimit(env, request, "commerce", session.accountId);
  const body = await readJsonBody(request);
  let payload;
  let authEventType;

  if (path === "business") {
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await updateBusinessProfile(env, session, body);
    authEventType = "commerce_business_updated";
  } else if (path.startsWith("templates/")) {
    await requireCommerceCapability(env, session, "commerce.templates.manage");
    const templateKey = decodePathPart(path.slice("templates/".length));
    payload = await updateTemplate(env, session, templateKey, body);
    authEventType = "commerce_template_updated";
  } else if (path === "permissions/grant") {
    await requireMasterAdmin(env, request);
    await grantCommerceCapability(env, session, body.accountId, body.capability, body.reason);
    payload = await permissionGrantsPayload(env, session);
    authEventType = "commerce_capability_granted";
  } else if (path === "permissions/revoke") {
    await requireMasterAdmin(env, request);
    await revokeCommerceCapability(env, session, body.accountId, body.capability);
    payload = await permissionGrantsPayload(env, session);
    authEventType = "commerce_capability_revoked";
  } else {
    throw new AuthFailure(404, "not_found", "The commerce action was not found.");
  }

  await writeAudit(env, {
    actorAccountId: session.accountId,
    eventType: authEventType,
    result: "success",
    metadata: { commerceAudit: true },
  });
  return jsonResponse(payload, { headers: corsHeaders(request, env) });
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

function decodePathPart(value) {
  try {
    return decodeURIComponent(value).slice(0, 80);
  } catch {
    return "";
  }
}

export { handleGet, handlePost };
