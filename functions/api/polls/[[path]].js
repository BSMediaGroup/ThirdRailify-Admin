import { AuthFailure, errorResponse, jsonResponse } from "../../_shared/auth-core.js";
import {
  changePollLifecycle,
  createPoll,
  getPollCreatorAccess,
  getPublicPoll,
  listCreatorPolls,
  listPublicPolls,
  readPollJson,
  submitWebVote,
  updatePoll,
  verifyPublicPollRequest,
} from "../../_shared/polls-core.js";

const PREFIX = "/api/polls";
const PUBLIC_CACHE = "public, max-age=5, stale-while-revalidate=15";

export async function onRequest(context) {
  const { request, env } = context;
  try {
    const path = new URL(request.url).pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET" || request.method === "HEAD") return publicRead(request, env, path);
    if (!path.startsWith("internal/")) throw new AuthFailure(404, "poll_route_not_found", "The Poll route was not found.");
    const { body, raw } = await readPollJson(request);
    await verifyPublicPollRequest(request, env, raw);
    return noStore(await internalAction(request.method, env, path.slice(9), body));
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
