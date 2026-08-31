import { AuthFailure, errorResponse, jsonResponse } from "../../_shared/auth-core.js";
import {
  changePollLifecycle,
  createPoll,
  getCreatorRumbleDiscovery,
  getPollCreatorAccess,
  getPublicPoll,
  listCreatorPolls,
  listPublicPolls,
  readPollJson,
  submitWebVote,
  updatePoll,
  verifyPublicPollRequest,
} from "../../_shared/polls-core.js";
import { pollMediaResponse, removePollMedia, uploadPollMedia } from "../../_shared/poll-media.js";

const PREFIX = "/api/polls";
const PUBLIC_CACHE = "public, max-age=5, stale-while-revalidate=15";

export async function onRequest(context) {
  const { request, env } = context;
  try {
    const path = new URL(request.url).pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
    if ((request.method === "GET" || request.method === "HEAD") && /^media\/[A-Za-z0-9_-]{16,80}$/.test(path)) return pollMediaResponse(env, path.slice(6), request);
    if (request.method === "GET" || request.method === "HEAD") return publicRead(request, env, path);
    if (!path.startsWith("internal/")) throw new AuthFailure(404, "poll_route_not_found", "The Poll route was not found.");
    const internalPath = path.slice(9);
    const mediaUpload = internalPath.match(/^([^/]+)\/media\/(banner|option)(?:\/([^/]+))?$/);
    if (request.method === "POST" && mediaUpload && String(request.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
      const declared = Number(request.headers.get("content-length") || 0);
      if (Number.isFinite(declared) && declared > 9 * 1024 * 1024) throw new AuthFailure(413, "request_too_large", "The Poll image request is too large.");
      const copy = request.clone(); const raw = new Uint8Array(await request.arrayBuffer());
      if (raw.byteLength > 9 * 1024 * 1024) throw new AuthFailure(413, "request_too_large", "The Poll image request is too large.");
      await verifyPublicPollRequest(request, env, raw);
      const form = await copy.formData(); const file = form.get("image");
      if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") throw new AuthFailure(400, "poll_media_file_required", "Choose a JPG, PNG, or WebP image.");
      const accountId = String(form.get("accountId") || "").slice(0, 160);
      const result = await uploadPollMedia(env, decode(mediaUpload[1]), mediaUpload[2], decode(mediaUpload[3] || ""), accountId, new Uint8Array(await file.arrayBuffer()), file.type, file.name);
      return noStore(result);
    }
    const { body, raw } = await readPollJson(request);
    await verifyPublicPollRequest(request, env, raw);
    const mediaRead = internalPath.match(/^media\/([A-Za-z0-9_-]{16,80})$/);
    if (request.method === "POST" && mediaRead) return pollMediaResponse(env, mediaRead[1], request, String(body.accountId || ""));
    return noStore(await internalAction(request.method, env, internalPath, body));
  } catch (error) { return errorResponse(error, request, env); }
}

async function publicRead(request, env, path) {
  if (request.method !== "GET" && request.method !== "HEAD") throw new AuthFailure(405, "method_not_allowed", "This Poll method is not allowed.");
  const url = new URL(request.url);
  const payload = path ? await getPublicPoll(env, decode(path)) : await listPublicPolls(env, { view: url.searchParams.get("view"), search: url.searchParams.get("search") });
  return jsonResponse(payload, { headers: { "Cache-Control": payload?.poll?.state === "open" || !path ? PUBLIC_CACHE : "public, max-age=60", ETag: `W/\"${hash(JSON.stringify(payload))}\"` } });
}

async function internalAction(method, env, path, body) {
  const accountId = String(body.accountId || "").slice(0, 160);
  if (method === "POST" && path === "access") return getPollCreatorAccess(env, accountId);
  if (method === "POST" && path === "discovery") return getCreatorRumbleDiscovery(env, accountId);
  if (method === "POST" && path === "mine") return listCreatorPolls(env, accountId);
  if (method === "POST" && path === "create") return createPoll(env, accountId, body.input || {});
  const read = path.match(/^([^/]+)\/read$/);
  if (method === "POST" && read) return getPublicPoll(env, decode(read[1]), accountId, true);
  const save = path.match(/^([^/]+)\/save$/);
  if (method === "PUT" && save) return updatePoll(env, accountId, decode(save[1]), body.input || {});
  const lifecycle = path.match(/^([^/]+)\/lifecycle$/);
  if (method === "POST" && lifecycle) return changePollLifecycle(env, accountId, decode(lifecycle[1]), body.input || {});
  const vote = path.match(/^([^/]+)\/vote$/);
  if (method === "POST" && vote) return submitWebVote(env, relayActor(body.actor, accountId), decode(vote[1]), body.input || {});
  const mediaRemove = path.match(/^([^/]+)\/media\/(banner|option)(?:\/([^/]+))?$/);
  if (method === "DELETE" && mediaRemove) return removePollMedia(env, decode(mediaRemove[1]), mediaRemove[2], decode(mediaRemove[3] || ""), accountId);
  throw new AuthFailure(404, "poll_route_not_found", "The Poll action was not found.");
}

function relayActor(value, accountId) {
  const actor = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (actor.namespace === "web_account") {
    if (!accountId || actor.accountId !== accountId) throw new AuthFailure(400, "poll_actor_invalid", "The account vote identity is invalid.");
    return { namespace: "web_account", key: `account:${accountId}`, accountId, label: String(actor.label || "").slice(0, 100) || null };
  }
  if (actor.namespace === "web_anonymous" && /^anonymous:[a-f0-9-]{36}$/.test(String(actor.key || ""))) {
    return { namespace: "web_anonymous", key: String(actor.key), label: null };
  }
  throw new AuthFailure(400, "poll_actor_invalid", "The Poll voter identity is invalid.");
}

function noStore(payload) { return jsonResponse(payload, { headers: { "Cache-Control": "no-store" } }); }
function decode(value) { try { return decodeURIComponent(value); } catch { return ""; } }
function hash(value) { let result = 2166136261; for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619); return (result >>> 0).toString(16); }

export { internalAction, publicRead };
