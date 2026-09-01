import { AuthFailure, corsHeaders, errorResponse, jsonResponse, normalizeOrigin, requireCsrf } from "../../../_shared/auth-core.js";
import { accessForSession, requireAdminCapability } from "../../../_shared/admin-capabilities.js";
import { adminGamingPayload, mutateGaming, removeGamingArtwork, uploadGamingArtwork } from "../../../_shared/gaming-core.js";

const PREFIX = "/api/admin/gaming";
const MAX_JSON = 64 * 1024;
const MAX_ARTWORK = 4 * 1024 * 1024;

export async function onRequest({ request, env }) {
  try {
    if (request.method === "OPTIONS") return options(request, env);
    const path = new URL(request.url).pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
    requireOriginWhenPresent(request, env);
    if (request.method === "GET" && !path) {
      const session = await requireAdminCapability(env, request, "gaming.view");
      return response(await adminGamingPayload(env, await accessForSession(env, session)), request, env);
    }
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "GET,POST,OPTIONS" });
    requireOrigin(request, env); const session = await requireAdminCapability(env, request, "gaming.manage"); await requireCsrf(request, session);
    const artwork = path.match(/^([^/]+)\/artwork$/);
    if (artwork) {
      const declared = Number(request.headers.get("content-length") || 0); if (declared > MAX_ARTWORK) throw new AuthFailure(413, "gaming_artwork_too_large", "Choose artwork no larger than 4 MB.");
      const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.byteLength > MAX_ARTWORK) throw new AuthFailure(413, "gaming_artwork_too_large", "Choose artwork no larger than 4 MB.");
      return response(await uploadGamingArtwork(env, session.accountId, decode(artwork[1]), bytes, request.headers.get("content-type"), request.headers.get("x-file-name")), request, env);
    }
    if (path) throw new AuthFailure(404, "gaming_route_not_found", "The Admin Gaming action was not found.");
    const body = await jsonBody(request);
    const payload = body.action === "remove_artwork" ? await removeGamingArtwork(env, session.accountId, body.gameId) : await mutateGaming(env, session.accountId, body);
    return response(payload, request, env);
  } catch (error) { return errorResponse(error, request, env); }
}

async function jsonBody(request) { if (!String(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) throw new AuthFailure(415, "content_type_required", "A JSON request body is required."); const declared = Number(request.headers.get("content-length") || 0); if (declared > MAX_JSON) throw new AuthFailure(413, "request_too_large", "The request is too large."); const text = await request.text(); if (text.length > MAX_JSON) throw new AuthFailure(413, "request_too_large", "The request is too large."); try { return JSON.parse(text || "{}"); } catch { throw new AuthFailure(400, "invalid_json", "The JSON request body is invalid."); } }
function response(payload, request, env) { return jsonResponse(payload, { headers: { ...corsHeaders(request, env), "Cache-Control": "no-store" } }); }
function requireOriginWhenPresent(request, env) { if (request.headers.get("origin")) requireOrigin(request, env); }
function requireOrigin(request, env) { const origin = normalizeOrigin(request.headers.get("origin")); if (!origin || origin !== normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN)) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed."); }
function options(request, env) { requireOrigin(request, env); return new Response(null, { status: 204, headers: { ...corsHeaders(request, env), "Access-Control-Allow-Headers": "content-type,x-csrf-token,x-file-name", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Max-Age": "600", "Cache-Control": "no-store" } }); }
function decode(value) { try { return decodeURIComponent(value); } catch { return ""; } }
