import {
  AuthFailure,
  corsHeaders,
  errorResponse,
  jsonResponse,
  normalizeOrigin,
  requireCsrf,
} from "../../../_shared/auth-core.js";
import { requireAdminCapability } from "../../../_shared/admin-capabilities.js";
import {
  adminWheelAccess,
  adminWheelDetail,
  adminWheelLibrary,
  adminWheelResults,
  getWheelSettings,
  mutateCreatorGrant,
  mutateWheelAssignment,
  mutateWheelControl,
  readWheelJson,
  saveWheelSettings,
  searchWheelAccounts,
  voidOfficialResult,
} from "../../../_shared/wheels-core.js";
import { adminRemoveWheelMedia } from "../../../_shared/wheel-media.js";
import { adminMutateStage, adminStageLibrary } from "../../../_shared/wheel-stages-core.js";

const PREFIX = "/api/admin/wheels";

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method === "OPTIONS") return options(request, env);
    const path = new URL(request.url).pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
    requireAdminOriginWhenPresent(request, env);
    if (request.method === "GET") {
      await requireAdminCapability(env, request, "wheels.view");
      if (!path) return response(await adminWheelLibrary(env), request, env);
      if (path === "stages") return response(await adminStageLibrary(env), request, env);
      if (path === "access") return response(await adminWheelAccess(env), request, env);
      if (path === "results") return response(await adminWheelResults(env, { search: new URL(request.url).searchParams.get("search") }), request, env);
      if (path === "accounts") return response(await searchWheelAccounts(env, new URL(request.url).searchParams.get("q")), request, env);
      if (path === "settings") return response(await getWheelSettings(env), request, env);
      return response(await adminWheelDetail(env, decode(path)), request, env);
    }
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "GET,POST,OPTIONS" });
    requireAdminOrigin(request, env);
    const session = await requireAdminCapability(env, request, "wheels.manage");
    await requireCsrf(request, session);
    const { body } = await readWheelJson(request, 64 * 1024);
    if (path === "grants") return response(await mutateCreatorGrant(env, session.accountId, body), request, env);
    if (path === "assignments") return response(await mutateWheelAssignment(env, session.accountId, body), request, env);
    if (path === "controls") return response(await mutateWheelControl(env, session.accountId, body), request, env);
    if (path === "results/void") return response(await voidOfficialResult(env, session.accountId, body), request, env);
    if (path === "settings") return response(await saveWheelSettings(env, session.accountId, body), request, env);
    if (path === "stages") return response(await adminMutateStage(env, session.accountId, body), request, env);
    const mediaRemoval = path.match(/^([^/]+)\/media\/([^/]+)\/remove$/);
    if (mediaRemoval) return response(await adminRemoveWheelMedia(env, decode(mediaRemoval[1]), decode(mediaRemoval[2]), session.accountId), request, env);
    throw new AuthFailure(404, "wheel_route_not_found", "The Admin wheel action was not found.");
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

function response(payload, request, env) { return jsonResponse(payload, { headers: { ...corsHeaders(request, env), "Cache-Control": "no-store" } }); }
function requireAdminOriginWhenPresent(request, env) { if (request.headers.get("origin")) requireAdminOrigin(request, env); }
function requireAdminOrigin(request, env) { const origin = normalizeOrigin(request.headers.get("origin")); const expected = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN); if (!origin || origin !== expected) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed."); }
function options(request, env) { requireAdminOrigin(request, env); return new Response(null, { status: 204, headers: { ...corsHeaders(request, env), "Access-Control-Allow-Headers": "content-type,x-csrf-token", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Max-Age": "600", "Cache-Control": "no-store" } }); }
function decode(value) { try { return decodeURIComponent(value); } catch { return ""; } }
