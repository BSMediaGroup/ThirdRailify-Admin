import { deletePoll } from '../../../_shared/polls-core.js';
import { schemaObject } from '../../../_shared/schema-capabilities.js';
import { uploadPollMedia, pollMediaResponse } from '../../../_shared/poll-media.js';
import { AuthFailure, corsHeaders, errorResponse, jsonResponse, normalizeOrigin, requireCsrf } from "../../../_shared/auth-core.js";
import { requireAdminCapability } from "../../../_shared/admin-capabilities.js";
import { getPollStreamCandidates, getSafeRumbleDiscovery, createPoll, updatePoll, adminPollAccess, adminPollLibrary, changePollLifecycle, changePollVisibility, getPublicPoll, mutatePollCreatorGrant, readPollJson } from "../../../_shared/polls-core.js";

const PREFIX = "/api/admin/polls";

export async function onRequest({ request, env }) {
  try {
    if (request.method === "OPTIONS") return options(request, env);
    originWhenPresent(request, env);
    const path = new URL(request.url).pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET") {
      await requireAdminCapability(env, request, "polls.view");
      if (!path) { const url = new URL(request.url); return response(await adminPollLibrary(env, { state: url.searchParams.get("state"), owner: url.searchParams.get("owner"), type: url.searchParams.get("type") }), request, env); }
      if (/^media\/[A-Za-z0-9_-]{16,80}$/.test(path)) { const session = await requireAdminCapability(env, request, "polls.view"); return pollMediaResponse(env, path.slice(6), request, session.accountId); }
      const streams = path.match(/^([^/]+)\/stream-links$/);
      if (streams) return response(await getPollStreamCandidates(env, (await requireAdminCapability(env, request, 'polls.manage')).accountId, decode(streams[1])), request, env);
      if (path === "discovery") return response(await getSafeRumbleDiscovery(env), request, env);
      if (path === "access") return response(await adminPollAccess(env), request, env);
      const payload = await getPublicPoll(env, decode(path), (await requireAdminCapability(env, request, "polls.view")).accountId, true);
      const db = env.THIRDRAILIFY_COMMERCE_DB;
      if (await schemaObject(db, 'aboot_poll_links')) {
        const linked = await db.prepare('SELECT l.bracket_id,l.match_id,b.title,b.draft_json FROM aboot_poll_links l JOIN aboot_brackets b ON b.id=l.bracket_id WHERE l.poll_id=? AND l.active=1').bind(payload.poll.id).first();
        if (linked) { const match = JSON.parse(linked.draft_json).matches.find(m => m.id === linked.match_id); payload.poll.bracketLink = { bracketId: linked.bracket_id, matchId: linked.match_id, title: linked.title, round: match?.round, position: match?.position }; }
      }
      return response(payload, request, env);
    }
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This Admin Poll method is not allowed.", { Allow: "GET,POST,OPTIONS" });
    requireOrigin(request, env); const session = await requireAdminCapability(env, request, "polls.manage"); await requireCsrf(request, session);
    const media = path.match(/^([^/]+)\/media\/(banner|option)(?:\/([^/]+))?$/);
    if (media) {
      if (Number(request.headers.get('content-length') || 0) > 9 * 1024 * 1024) throw new AuthFailure(413, 'request_too_large', 'Image request exceeds the limit.');
      const raw = await request.arrayBuffer();
      if (raw.byteLength > 9 * 1024 * 1024) throw new AuthFailure(413, 'request_too_large', 'Image request exceeds the limit.');
      const form = await new Request(request.url, { method: 'POST', headers: request.headers, body: raw }).formData(); const file = form.get('image');
      if (!file || typeof file === 'string') throw new AuthFailure(400, 'poll_media_file_required', 'Choose an image.');
      return response(await uploadPollMedia(env, decode(media[1]), media[2], decode(media[3] || ''), session.accountId, new Uint8Array(await file.arrayBuffer()), file.type, file.name), request, env);
    }
    const { body } = await readPollJson(request);
    if (path === "create") return response(await createPoll(env, session.accountId, body), request, env);
    const deletion = path.match(/^([^/]+)\/delete$/);
    if (deletion) return response(await deletePoll(env, session.accountId, decode(deletion[1]), body), request, env);
    const edit = path.match(/^([^/]+)\/save$/);
    if (edit) return response(await updatePoll(env, session.accountId, decode(edit[1]), body), request, env);
    if (path === "grants") return response(await mutatePollCreatorGrant(env, session.accountId, body), request, env);
    const lifecycle = path.match(/^([^/]+)\/lifecycle$/);
    if (lifecycle) return response(await changePollLifecycle(env, session.accountId, decode(lifecycle[1]), body), request, env);
    const visibility = path.match(/^([^/]+)\/visibility$/);
    if (visibility) return response(await changePollVisibility(env, session.accountId, decode(visibility[1]), body), request, env);
    throw new AuthFailure(404, "poll_route_not_found", "The Admin Poll action was not found.");
  } catch (error) { return errorResponse(error, request, env); }
}

function response(payload, request, env) { return jsonResponse(payload, { headers: { ...corsHeaders(request, env), "Cache-Control": "no-store" } }); }
function originWhenPresent(request, env) { if (request.headers.get("origin")) requireOrigin(request, env); }
function requireOrigin(request, env) { if (normalizeOrigin(request.headers.get("origin")) !== normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN)) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed."); }
function options(request, env) { requireOrigin(request, env); return new Response(null, { status: 204, headers: { ...corsHeaders(request, env), "Access-Control-Allow-Headers": "content-type,x-csrf-token", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Cache-Control": "no-store" } }); }
function decode(value) { try { return decodeURIComponent(value); } catch { return ""; } }
