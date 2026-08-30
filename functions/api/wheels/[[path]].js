import { AuthFailure, errorResponse, jsonResponse } from "../../_shared/auth-core.js";
import {
  applyWinnerAction,
  changeWheelLifecycle,
  createWheel,
  getCreatorAccess,
  getPublicWheel,
  getWheelAccess,
  listPublicWheels,
  performOfficialSpin,
  readWheelJson,
  saveWheel,
  verifyWheelInternalRequest,
} from "../../_shared/wheels-core.js";
import { removeWheelMedia, uploadWheelMedia, wheelMediaResponse } from "../../_shared/wheel-media.js";

const PREFIX = "/api/wheels";
const PUBLIC_CACHE = "public, max-age=30, s-maxage=120, stale-while-revalidate=300";

export async function onRequest(context) {
  const { request, env } = context;
  try {
    const path = new URL(request.url).pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET" || request.method === "HEAD") return await handlePublicRead(request, env, path);
    if (!path.startsWith("internal/")) throw new AuthFailure(404, "wheel_route_not_found", "The wheel route was not found.");
    const internalPath = path.slice("internal/".length);
    const mediaUpload = internalPath.match(/^([^/]+)\/media\/(background|centre|segment-fill)$/);
    if (request.method === "POST" && mediaUpload) return noStore(await handleMediaUpload(request, env, mediaUpload));
    const { body, raw } = await readWheelJson(request);
    await verifyWheelInternalRequest(request, env, raw);
    return noStore(await handleInternal(request.method, env, internalPath, body));
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

async function handlePublicRead(request, env, path) {
  const url = new URL(request.url);
  const media = path.match(/^media\/([a-f0-9-]{16,80})$/i);
  if (media) {
    let accountId = "";
    if (request.headers.get("x-thirdrailify-signature")) { await verifyWheelInternalRequest(request, env, new Uint8Array()); accountId = String(request.headers.get("x-thirdrailify-account-id") || "").slice(0, 160); }
    return wheelMediaResponse(env, decode(media[1]), request, accountId);
  }
  if (!path) return cached(await listPublicWheels(env, { search: url.searchParams.get("search"), sort: url.searchParams.get("sort") }));
  if (path === "access" || path.endsWith("/access")) throw new AuthFailure(401, "authentication_required", "Sign in to view wheel access.");
  if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/i.test(path)) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  return cached(await getPublicWheel(env, path));
}

async function handleInternal(method, env, path, body) {
  const accountId = String(body.accountId || "").slice(0, 160);
  if (method === "POST" && path === "access") return getCreatorAccess(env, accountId);
  if (method === "POST" && path === "read") return listPublicWheels(env, body);
  if (method === "POST" && path === "create") return createWheel(env, accountId, body.input || {});
  const read = path.match(/^([^/]+)\/read$/);
  if (method === "POST" && read) return getPublicWheel(env, decode(read[1]), accountId);
  const access = path.match(/^([^/]+)\/access$/);
  if (method === "POST" && access) return getWheelAccess(env, accountId, decode(access[1]));
  const save = path.match(/^([^/]+)\/save$/);
  if (method === "PUT" && save) return saveWheel(env, accountId, decode(save[1]), body.input || {});
  const spins = path.match(/^([^/]+)\/spins$/);
  if (method === "POST" && spins) return performOfficialSpin(env, accountId, decode(spins[1]), body.input || {});
  const winner = path.match(/^([^/]+)\/winner-action$/);
  if (method === "POST" && winner) return applyWinnerAction(env, accountId, decode(winner[1]), body.input || {});
  const lifecycle = path.match(/^([^/]+)\/lifecycle$/);
  if (method === "POST" && lifecycle) return changeWheelLifecycle(env, accountId, decode(lifecycle[1]), body.input || {});
  const mediaRemove = path.match(/^([^/]+)\/media\/(background|centre)$/);
  if (method === "DELETE" && mediaRemove) return removeWheelMedia(env, decode(mediaRemove[1]), mediaRemove[2], accountId);
  throw new AuthFailure(404, "wheel_route_not_found", "The wheel action was not found.");
}

async function handleMediaUpload(request, env, match) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > 8 * 1024 * 1024) throw new AuthFailure(413, "wheel_media_too_large", "The wheel image is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 8 * 1024 * 1024) throw new AuthFailure(413, "wheel_media_too_large", "The wheel image is too large.");
  await verifyWheelInternalRequest(request, env, bytes);
  return uploadWheelMedia(env, decode(match[1]), match[2], request.headers.get("x-thirdrailify-account-id"), bytes, request.headers.get("content-type"), request.headers.get("x-thirdrailify-filename"));
}

function cached(payload) { return jsonResponse(payload, { headers: { "Cache-Control": PUBLIC_CACHE, ETag: `W/\"${simpleHash(JSON.stringify(payload))}\"`, "X-Content-Type-Options": "nosniff" } }); }
function noStore(payload) { return jsonResponse(payload, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
function decode(value) { try { return decodeURIComponent(value); } catch { return ""; } }
function simpleHash(value) { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619); return (hash >>> 0).toString(16); }

export { handleInternal, handleMediaUpload, handlePublicRead };
